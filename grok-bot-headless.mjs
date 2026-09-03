#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// --- Configuration -----------------------------------------------------------

const CLI_NAME = 'grok-bot-headless';
const SERVICE_UNIT = 'grok-bot-headless.service';
const API_URL = validatedServiceUrl(
  process.env.SAND_BACKEND_URL || process.env.CURSOR_API_BASE_URL || 'https://api2.cursor.sh',
  'backend',
);
const WEBSITE_URL = validatedServiceUrl(
  process.env.SAND_CURSOR_WEBSITE_URL || process.env.CURSOR_WEBSITE_URL || 'https://cursor.com',
  'website',
);
const AUTH_CLIENT_ID = process.env.SAND_AUTH_CLIENT_ID || 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const CONFIG_DIR = process.env.GROK_BOT_HEADLESS_CONFIG_DIR || join(homedir(), '.config', 'grok-bot-headless');
const DATA_ROOT = process.env.SAND_DATA_ROOT || join(homedir(), '.local', 'share', 'grok-bot-headless');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');
const MACHINE_PATH = join(CONFIG_DIR, 'machine.json');
const DAEMON_CREDENTIAL_PATH = join(DATA_ROOT, 'local-exec-daemon-credential.json');
const HEARTBEAT_PATH = join(DATA_ROOT, 'local-exec-supervisor.json');
const DISCOVERY_PATH = join(DATA_ROOT, 'local-exec-daemon.json');
const SETTINGS_PATH = join(DATA_ROOT, 'settings.json');
const APP_BINARY = process.env.GROK_BOT_BINARY || '/opt/Grok Bot/grok-bot';
const DAEMON_SCRIPT = process.env.GROK_BOT_DAEMON_SCRIPT || '/opt/Grok Bot/resources/app.asar/dist/local-exec-daemon/main.cjs';
const DAEMON_CONTAINER_PATH = DAEMON_SCRIPT.includes('.asar/')
  ? `${DAEMON_SCRIPT.slice(0, DAEMON_SCRIPT.indexOf('.asar/'))}.asar`
  : DAEMON_SCRIPT;
const PACKAGE_JSON_PATH = process.env.GROK_BOT_PACKAGE_JSON || join(dirname(APP_BINARY), 'resources', 'app.asar', 'package.json');
const TESTED_CLIENT_VERSIONS = Object.freeze(['0.30.0']);
const POLICIES = Object.freeze(['always', 'ask', 'never']);
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DESCRIPTOR_REFRESH_MS = 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;
const DAEMON_RESTART_MS = 5 * 1000;
const DAEMON_STOP_GRACE_MS = 5 * 1000;
const LOGIN_POLL_ATTEMPTS = 150;
const LOGIN_POLL_MAX_MS = 10 * 1000;
const SUBPROCESS_TIMEOUT_MS = 20 * 1000;

function validatedServiceUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${label} URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} URL cannot contain credentials`);
  }
  const insecureLocalAllowed = process.env.GROK_BOT_ALLOW_INSECURE_LOCALHOST === '1'
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !insecureLocalAllowed) {
    throw new Error(`${label} URL must use HTTPS`);
  }
  return parsed.href.replace(/\/+$/, '');
}

// --- Pure helpers ------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const printJson = (value) => process.stdout.write(formatJson(value));
const base64url = (value) => Buffer.from(value).toString('base64url');

function describeError(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) {
    messages.push(current.message || String(current));
  }
  return messages.join(': ');
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function accountScope(accessToken) {
  const payload = jwtPayload(accessToken);
  return createHash('sha256').update(payload.sub || accessToken).digest('hex');
}

function tokenExpiresSoon(accessToken) {
  const exp = Number(jwtPayload(accessToken).exp || 0) * 1000;
  return exp === 0 || exp - Date.now() < TOKEN_REFRESH_MARGIN_MS;
}

function cursorChecksum(machineId, nowMs = Date.now()) {
  // Keep JavaScript's 32-bit shift behavior. The official client and server use this exact transform.
  const epoch = Math.floor(nowMs / 1_000_000);
  const bytes = Buffer.from([
    (epoch >> 40) & 255,
    (epoch >> 32) & 255,
    (epoch >> 24) & 255,
    (epoch >> 16) & 255,
    (epoch >> 8) & 255,
    epoch & 255,
  ]);
  let previous = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = ((bytes[index] ^ previous) + index) & 255;
    previous = bytes[index];
  }
  return `${bytes.toString('base64url')}${machineId}`;
}

function isTestedClientVersion(version) {
  return TESTED_CLIENT_VERSIONS.includes(version);
}

function hasCredentialShape(credentials) {
  return typeof credentials?.accessToken === 'string'
    && credentials.accessToken.length > 0
    && typeof credentials?.refreshToken === 'string'
    && credentials.refreshToken.length > 0;
}

function oauthTokens(body) {
  return {
    accessToken: body.accessToken || body.access_token,
    refreshToken: body.refreshToken || body.refresh_token,
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Local files -------------------------------------------------------------

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, formatJson(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
}

async function machineIdentity() {
  const current = await readJson(MACHINE_PATH);
  if (typeof current?.machineId === 'string' && current.machineId.length > 0) return current;
  const created = { machineId: randomUUID(), label: hostname() };
  await atomicJson(MACHINE_PATH, created);
  return created;
}

async function saveCredentials(credentials) {
  const saved = { ...credentials, savedAtMs: Date.now() };
  await atomicJson(CREDENTIALS_PATH, saved);
  return saved;
}

async function loadCredentials() {
  const credentials = await readJson(CREDENTIALS_PATH);
  if (!hasCredentialShape(credentials)) {
    throw new Error(`No valid account credentials. Run: ${CLI_NAME} login`);
  }
  return refresh(credentials);
}

const heartbeat = () => atomicJson(HEARTBEAT_PATH, { pid: process.pid, at: Date.now() });

// --- Official application ----------------------------------------------------

function appNode(code) {
  return execFileSync(APP_BINARY, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

let installedVersionCache;
function installedVersion() {
  if (installedVersionCache === undefined) {
    try {
      installedVersionCache = appNode(`process.stdout.write(require(${JSON.stringify(PACKAGE_JSON_PATH)}).version)`).trim() || null;
    } catch {
      installedVersionCache = null;
    }
  }
  return installedVersionCache;
}

function clientVersion() {
  return process.env.SAND_CLIENT_APP_VERSION || installedVersion() || TESTED_CLIENT_VERSIONS.at(-1);
}

function probeDaemonEntry() {
  appNode(`require.resolve(${JSON.stringify(DAEMON_SCRIPT)})`);
}

async function assertAppInstalled() {
  for (const [label, path] of [['application binary', APP_BINARY], ['daemon archive', DAEMON_CONTAINER_PATH]]) {
    await access(path).catch((error) => {
      throw new Error(`Cannot access the Grok Bot ${label}: ${path}`, { cause: error });
    });
  }
}

function spawnDaemon(machineId) {
  const child = fork(DAEMON_SCRIPT, [], {
    execPath: APP_BINARY,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SAND_PACKAGED: '1',
      SAND_DATA_ROOT: DATA_ROOT,
      SAND_CLIENT_APP_VERSION: clientVersion(),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('spawn', () => {
    child.send({ type: 'sand-local-exec-file-key', key: null, computerId: machineId });
  });
  return child;
}

async function terminate(child) {
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
  const exitedWithin = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
  if (child.connected) child.disconnect();
  child.kill('SIGTERM');
  if (!(await exitedWithin(DAEMON_STOP_GRACE_MS))) {
    child.kill('SIGKILL');
    await exitedWithin(1000);
  }
}

// --- Backend protocol --------------------------------------------------------

function authHeaders(machineId, credentials) {
  const teamId = credentials.selectedTeamId;
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    ...(teamId == null || teamId === '' ? {} : { 'x-cursor-team-id': String(teamId) }),
    'x-cursor-checksum': cursorChecksum(machineId),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': clientVersion(),
    'x-sand-box-namespace': 'prod',
    'x-ghost-mode': 'true',
    'x-request-id': randomUUID(),
  };
}

async function responseJson(response, action) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${action} returned HTTP ${response.status} with invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${action} returned HTTP ${response.status}: ${body.message || body.error || text || 'unknown error'}`);
  }
  return body;
}

async function postJson(path, body, action, headers = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return responseJson(response, action);
}

function connectUnary(service, method, request, credentials, machineId) {
  const headers = { ...authHeaders(machineId, credentials), 'connect-protocol-version': '1' };
  return postJson(`/${service}/${method}`, request, method, headers);
}

async function refresh(credentials) {
  if (!tokenExpiresSoon(credentials.accessToken)) return credentials;
  const body = await postJson('/oauth/token', {
    client_id: AUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
  }, 'OAuth refresh');
  if (body.shouldLogout) throw new Error('OAuth refresh requires a new sign-in');
  const tokens = oauthTokens(body);
  return saveCredentials({
    ...credentials,
    accessToken: tokens.accessToken || credentials.accessToken,
    refreshToken: tokens.refreshToken || credentials.refreshToken,
  });
}

async function mintDescriptor(identity, credentials) {
  const { machineId } = identity;
  const [daemon, computer] = await Promise.all([
    postJson('/sand-box/local-exec-daemon-credential', {}, 'Local daemon credential mint', authHeaders(machineId, credentials)),
    connectUnary('aiserver.v1.GrokBotService', 'IssueGrokBotUserComputerCredential', { machineId }, credentials, machineId),
  ]);
  if (!daemon.credential) throw new Error('Daemon credential mint returned no credential');
  if (!computer.credential) throw new Error('User-computer credential mint returned no credential');
  const descriptor = {
    credential: daemon.credential,
    backendUrl: API_URL,
    ...(typeof daemon.expiresAtMs === 'number' ? { expiresAtMs: daemon.expiresAtMs } : {}),
    userComputer: {
      credential: computer.credential,
      machineId,
      expiresAtMs: Number(computer.expiresAtMs),
      accountScope: accountScope(credentials.accessToken),
      serverAuthoritative: computer.serverAuthoritative === true,
    },
  };
  await atomicJson(DAEMON_CREDENTIAL_PATH, descriptor);
  return descriptor;
}

async function syncMachinePolicy(value, identity, credentials, connect = connectUnary) {
  await connect(
    'aiserver.v1.DashboardService',
    'RegisterSandMachine',
    { label: identity.label, localToolPermission: value },
    credentials,
    identity.machineId,
  );
  const response = await connect(
    'aiserver.v1.DashboardService',
    'UpdateSandMachineLocalToolPermission',
    { machineId: identity.machineId, localToolPermission: value },
    credentials,
    identity.machineId,
  );
  if (response.machine?.machineId !== identity.machineId) {
    throw new Error('Machine permission update returned an invalid machine');
  }
  if (response.machine.localToolPermission !== value) {
    throw new Error(`The backend limited the machine policy to ${response.machine.localToolPermission || 'ask'}`);
  }
  return response.machine;
}

// --- Commands ----------------------------------------------------------------

async function login() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const uuid = randomUUID();
  const loginUrl = new URL('/loginDeepControl', WEBSITE_URL);
  loginUrl.search = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'sand',
    supportsSelectedTeamLogin: 'true',
  });
  process.stdout.write(`Open this URL in any browser and complete sign-in:\n\n${loginUrl}\n\nWaiting for authorization...\n`);

  const pollUrl = new URL(`${API_URL}/auth/poll`);
  pollUrl.search = new URLSearchParams({ uuid, verifier });
  let delay = 1000;
  for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(pollUrl);
    if (response.status !== 404) {
      const body = await responseJson(response, 'OAuth poll');
      const tokens = oauthTokens(body);
      if (!tokens.accessToken || !tokens.refreshToken) {
        throw new Error('OAuth response did not contain access and refresh tokens');
      }
      await saveCredentials({
        ...tokens,
        ...(body.selectedTeamId == null ? {} : { selectedTeamId: body.selectedTeamId }),
      });
      process.stdout.write(`Account authorized for ${hostname()}.\n`);
      return;
    }
    await sleep(delay);
    delay = Math.min(Math.floor(delay * 1.2), LOGIN_POLL_MAX_MS);
  }
  throw new Error('OAuth sign-in timed out');
}

async function localCompatibility() {
  await assertAppInstalled();
  probeDaemonEntry();
  const version = installedVersion();
  if (!version) throw new Error('Cannot read the installed Grok Bot version');
  return {
    compatible: true,
    installedVersion: version,
    testedVersion: isTestedClientVersion(version),
    daemonEntryPoint: 'verified',
  };
}

async function check(localOnly) {
  const report = await localCompatibility();
  if (!localOnly) await mintDescriptor(await machineIdentity(), await loadCredentials());
  printJson({ ...report, authentication: localOnly ? 'skipped' : 'verified' });
}

async function run() {
  await assertAppInstalled();
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  const identity = await machineIdentity();
  let stopping = false;
  let daemon;

  const renewCredentials = async () => mintDescriptor(identity, await loadCredentials());

  const startDaemon = () => {
    const child = spawnDaemon(identity.machineId);
    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(`local-exec daemon exited (${signal || code}); restarting in ${DAEMON_RESTART_MS / 1000} seconds`);
      setTimeout(() => {
        if (!stopping) daemon = startDaemon();
      }, DAEMON_RESTART_MS).unref();
    });
    return child;
  };

  const repeat = async (intervalMs, label, work) => {
    while (!stopping) {
      await sleep(intervalMs);
      if (stopping) return;
      await work().catch((error) => console.error(`${label}: ${describeError(error)}`));
    }
  };

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    await terminate(daemon);
    await rm(HEARTBEAT_PATH, { force: true });
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };

  await renewCredentials();
  await heartbeat();
  daemon = startDaemon();
  void repeat(HEARTBEAT_MS, 'heartbeat', heartbeat);
  void repeat(DESCRIPTOR_REFRESH_MS, 'credential refresh', renewCredentials);
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.stdout.write(`Native Grok Bot node started: ${identity.label} (${identity.machineId})\n`);
}

async function status() {
  const [identity, discovery, descriptor, settings] = await Promise.all(
    [MACHINE_PATH, DISCOVERY_PATH, DAEMON_CREDENTIAL_PATH, SETTINGS_PATH].map((path) => readJson(path)),
  );
  printJson({
    label: identity?.label || hostname(),
    machineId: identity?.machineId || null,
    daemonPid: discovery?.pid || null,
    daemonAlive: discovery?.pid ? processAlive(discovery.pid) : false,
    localToolPermission: settings?.localToolPermission || 'ask',
    credentialExpiresAtMs: descriptor?.userComputer?.expiresAtMs || descriptor?.expiresAtMs || null,
    dataRoot: DATA_ROOT,
  });
}

async function policy(value) {
  if (!POLICIES.includes(value)) {
    throw new Error(`Policy must be one of: ${POLICIES.join(', ')}`);
  }
  const identity = await machineIdentity();
  const credentials = await loadCredentials();
  await syncMachinePolicy(value, identity, credentials);
  const current = await readJson(SETTINGS_PATH);
  await atomicJson(SETTINGS_PATH, {
    ...(current && typeof current === 'object' ? current : {}),
    version: 1,
    localToolPermission: value,
  });
  process.stdout.write(`Local and backend execution policy set to ${value}. Restart the service to apply it locally.\n`);
}

async function logout() {
  try {
    execFileSync('systemctl', ['--user', 'stop', SERVICE_UNIT], { stdio: 'ignore', timeout: SUBPROCESS_TIMEOUT_MS });
  } catch {
    // A direct run or an unavailable user service is handled by the process check below.
  }
  const discovery = await readJson(DISCOVERY_PATH);
  if (discovery?.pid && processAlive(discovery.pid)) {
    throw new Error('The local execution daemon is still active. Stop it before logout');
  }
  await Promise.all(
    [CREDENTIALS_PATH, DAEMON_CREDENTIAL_PATH, DISCOVERY_PATH, HEARTBEAT_PATH].map((path) => rm(path, { force: true })),
  );
  process.stdout.write('Local service stopped and credentials removed.\n');
}

// --- Entry point -------------------------------------------------------------

async function main(command, option) {
  switch (command) {
    case 'login': return login();
    case 'run': return run();
    case 'status': return status();
    case 'check':
      if (option !== undefined && option !== '--local') throw new Error(`Usage: ${CLI_NAME} check [--local]`);
      return check(option === '--local');
    case 'policy': return policy(option);
    case 'logout': return logout();
    default:
      process.stdout.write(`Usage: ${CLI_NAME} <login|run|status|check|policy|logout>\n`);
      process.exitCode = command === 'help' ? 0 : 2;
      return undefined;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // import.meta.url is the real path; argv[1] can be a symlink (for example a symlinked $HOME).
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv[2] || 'help', process.argv[3]).catch((error) => {
    console.error(`${CLI_NAME}: ${describeError(error)}`);
    process.exitCode = 1;
  });
}

export {
  accountScope,
  base64url,
  cursorChecksum,
  hasCredentialShape,
  isTestedClientVersion,
  jwtPayload,
  tokenExpiresSoon,
  syncMachinePolicy,
  validatedServiceUrl,
};
