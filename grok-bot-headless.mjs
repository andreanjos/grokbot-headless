#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const CLIENT_VERSION = process.env.SAND_CLIENT_APP_VERSION || installedVersion();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DESCRIPTOR_REFRESH_MS = 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}
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
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const insecureLocalAllowed = process.env.GROK_BOT_ALLOW_INSECURE_LOCALHOST === '1'
    && parsed.protocol === 'http:'
    && isLocalhost;
  if (parsed.protocol !== 'https:' && !insecureLocalAllowed) {
    throw new Error(`${label} URL must use HTTPS`);
  }
  return trimSlash(parsed.href);
}


function installedVersion() {
  try {
    return execFileSync(
      APP_BINARY,
      ['-e', `process.stdout.write(require(${JSON.stringify(PACKAGE_JSON_PATH)}).version)`],
      {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim() || '0.30.0';
  } catch {
    return '0.30.0';
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
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

async function atomicJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function readJson(path, required = true) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function machineIdentity() {
  const current = await readJson(MACHINE_PATH, false);
  if (typeof current?.machineId === 'string' && current.machineId.length > 0) return current;
  const created = { machineId: randomUUID(), label: hostname() };
  await atomicJson(MACHINE_PATH, created);
  return created;
}

function commonHeaders(machineId, accessToken, teamId) {
  return {
    authorization: `Bearer ${accessToken}`,
    ...(teamId == null || teamId === '' ? {} : { 'x-cursor-team-id': String(teamId) }),
    'x-cursor-checksum': cursorChecksum(machineId),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': CLIENT_VERSION,
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

async function login() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const uuid = randomUUID();
  const loginUrl = new URL('/loginDeepControl', WEBSITE_URL);
  loginUrl.searchParams.set('challenge', challenge);
  loginUrl.searchParams.set('uuid', uuid);
  loginUrl.searchParams.set('mode', 'login');
  loginUrl.searchParams.set('redirectTarget', 'sand');
  loginUrl.searchParams.set('supportsSelectedTeamLogin', 'true');
  process.stdout.write(`Open this URL in any browser and complete sign-in:\n\n${loginUrl}\n\nWaiting for authorization...\n`);

  let delay = 1000;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const pollUrl = new URL('/auth/poll', API_URL);
    pollUrl.searchParams.set('uuid', uuid);
    pollUrl.searchParams.set('verifier', verifier);
    const response = await fetch(pollUrl, { headers: { 'content-type': 'application/json' } });
    if (response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.floor(delay * 1.2), 10_000);
      continue;
    }
    const body = await responseJson(response, 'OAuth poll');
    const accessToken = body.accessToken || body.access_token;
    const refreshToken = body.refreshToken || body.refresh_token;
    if (!accessToken || !refreshToken) throw new Error('OAuth response did not contain access and refresh tokens');
    await atomicJson(CREDENTIALS_PATH, {
      accessToken,
      refreshToken,
      ...(body.selectedTeamId == null ? {} : { selectedTeamId: body.selectedTeamId }),
      savedAtMs: Date.now(),
    });
    process.stdout.write(`Account authorized for ${hostname()}.\n`);
    return;
  }
  throw new Error('OAuth sign-in timed out');
}

async function refresh(credentials) {
  if (!tokenExpiresSoon(credentials.accessToken)) return credentials;
  const response = await fetch(new URL('/oauth/token', API_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: AUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    }),
  });
  const body = await responseJson(response, 'OAuth refresh');
  if (body.shouldLogout) throw new Error('OAuth refresh requires a new sign-in');
  const next = {
    ...credentials,
    accessToken: body.access_token || body.accessToken || credentials.accessToken,
    refreshToken: body.refresh_token || body.refreshToken || credentials.refreshToken,
    savedAtMs: Date.now(),
  };
  await atomicJson(CREDENTIALS_PATH, next);
  return next;
}

async function connectUnary(service, method, request, credentials, machineId) {
  const response = await fetch(`${API_URL}/${service}/${method}`, {
    method: 'POST',
    headers: {
      ...commonHeaders(machineId, credentials.accessToken, credentials.selectedTeamId),
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    },
    body: JSON.stringify(request),
  });
  return responseJson(response, method);
}

async function mintDescriptor() {
  const identity = await machineIdentity();
  let credentials = await readJson(CREDENTIALS_PATH, true).catch(() => {
    throw new Error(`No account credentials. Run: ${process.argv[1]} login`);
  });
  credentials = await refresh(credentials);
  const headers = commonHeaders(identity.machineId, credentials.accessToken, credentials.selectedTeamId);

  const [daemonResponse, computerResponse] = await Promise.all([
    fetch(new URL('/sand-box/local-exec-daemon-credential', API_URL), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => responseJson(response, 'Local daemon credential mint')),
    connectUnary(
      'aiserver.v1.GrokBotService',
      'IssueGrokBotUserComputerCredential',
      { machineId: identity.machineId },
      credentials,
      identity.machineId,
    ),
  ]);

  if (!daemonResponse.credential) throw new Error('Daemon credential mint returned no credential');
  if (!computerResponse.credential) throw new Error('User-computer credential mint returned no credential');
  const descriptor = {
    credential: daemonResponse.credential,
    backendUrl: API_URL,
    ...(typeof daemonResponse.expiresAtMs === 'number' ? { expiresAtMs: daemonResponse.expiresAtMs } : {}),
    userComputer: {
      credential: computerResponse.credential,
      machineId: identity.machineId,
      expiresAtMs: Number(computerResponse.expiresAtMs),
      accountScope: accountScope(credentials.accessToken),
      serverAuthoritative: computerResponse.serverAuthoritative === true,
    },
  };
  await atomicJson(DAEMON_CREDENTIAL_PATH, descriptor);
  return { identity, descriptor };
}

async function heartbeat() {
  await atomicJson(HEARTBEAT_PATH, { pid: process.pid, at: Date.now() });
}

function spawnDaemon(machineId) {
  const child = fork(DAEMON_SCRIPT, [], {
    execPath: APP_BINARY,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SAND_PACKAGED: '1',
      SAND_DATA_ROOT: DATA_ROOT,
      SAND_CLIENT_APP_VERSION: CLIENT_VERSION,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('spawn', () => {
    child.send({ type: 'sand-local-exec-file-key', key: null, computerId: machineId });
  });
  return child;
}

async function run() {
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  let { identity } = await mintDescriptor();
  await heartbeat();
  let stopping = false;
  let refreshBusy = false;
  let child;

  const startDaemon = () => {
    const daemon = spawnDaemon(identity.machineId);
    daemon.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(`local-exec daemon exited (${signal || code}); restarting in 5 seconds`);
      setTimeout(() => {
        if (!stopping) child = startDaemon();
      }, 5000).unref();
    });
    return daemon;
  };
  child = startDaemon();

  const heartbeatTimer = setInterval(() => heartbeat().catch((error) => console.error(`heartbeat: ${error.message}`)), HEARTBEAT_MS);
  const refreshTimer = setInterval(async () => {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      ({ identity } = await mintDescriptor());
    } catch (error) {
      console.error(`credential refresh: ${error.message}`);
    } finally {
      refreshBusy = false;
    }
  }, DESCRIPTOR_REFRESH_MS);

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    clearInterval(refreshTimer);
    const exitPromise = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    if (child.connected) child.disconnect();
    child.kill('SIGTERM');
    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited) {
      child.kill('SIGKILL');
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    await rm(HEARTBEAT_PATH, { force: true });
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.stdout.write(`Native Grok Bot node started: ${identity.label} (${identity.machineId})\n`);
}

async function status() {
  const identity = await readJson(MACHINE_PATH, false);
  const discovery = await readJson(DISCOVERY_PATH, false);
  const descriptor = await readJson(DAEMON_CREDENTIAL_PATH, false);
  const settings = await readJson(SETTINGS_PATH, false);
  const alive = discovery?.pid ? processAlive(discovery.pid) : false;
  process.stdout.write(`${JSON.stringify({
    label: identity?.label || hostname(),
    machineId: identity?.machineId || null,
    daemonPid: discovery?.pid || null,
    daemonAlive: alive,
    localToolPermission: settings?.localToolPermission || 'ask',
    credentialExpiresAtMs: descriptor?.userComputer?.expiresAtMs || descriptor?.expiresAtMs || null,
    dataRoot: DATA_ROOT,
  }, null, 2)}\n`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function policy(value) {
  if (!['always', 'ask', 'never'].includes(value)) {
    throw new Error('Policy must be one of: always, ask, never');
  }
  const current = await readJson(SETTINGS_PATH, false);
  await atomicJson(SETTINGS_PATH, {
    ...(current && typeof current === 'object' ? current : {}),
    version: 1,
    localToolPermission: value,
  });
  process.stdout.write(`Local execution policy set to ${value}. Restart the service to apply it.\n`);
}

async function logout() {
  try {
    execFileSync('systemctl', ['--user', 'stop', 'grok-bot-headless.service'], {
      stdio: 'ignore',
      timeout: 20_000,
    });
  } catch {
    // A direct run or an unavailable user service is handled by the process check below.
  }
  const discovery = await readJson(DISCOVERY_PATH, false);
  if (discovery?.pid && processAlive(discovery.pid)) {
    throw new Error('The local execution daemon is still active. Stop it before logout');
  }
  await rm(CREDENTIALS_PATH, { force: true });
  await rm(DAEMON_CREDENTIAL_PATH, { force: true });
  await rm(DISCOVERY_PATH, { force: true });
  await rm(HEARTBEAT_PATH, { force: true });
  process.stdout.write('Local service stopped and credentials removed.\n');
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'login') return login();
  if (command === 'run') {
    await access(APP_BINARY);
    await access(DAEMON_CONTAINER_PATH);
    return run();
  }
  if (command === 'status') return status();
  if (command === 'policy') return policy(process.argv[3]);
  if (command === 'logout') return logout();
  process.stdout.write('Usage: grok-bot-headless <login|run|status|policy|logout>\n');
  process.exitCode = command === 'help' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`grok-bot-headless: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}

export { accountScope, base64url, cursorChecksum, jwtPayload, tokenExpiresSoon, trimSlash, validatedServiceUrl };
