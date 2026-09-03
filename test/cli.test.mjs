import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLI = fileURLToPath(new URL('../grok-bot-headless.mjs', import.meta.url));
const AUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const FAKE_DAEMON = `
const fs = require('node:fs');
const path = require('node:path');
process.on('message', (bootstrap) => {
  const { ELECTRON_RUN_AS_NODE, SAND_PACKAGED, SAND_DATA_ROOT, SAND_CLIENT_APP_VERSION } = process.env;
  fs.writeFileSync(
    path.join(process.env.SAND_DATA_ROOT, 'local-exec-daemon.json'),
    JSON.stringify({ pid: process.pid, bootstrap, env: { ELECTRON_RUN_AS_NODE, SAND_PACKAGED, SAND_DATA_ROOT, SAND_CLIENT_APP_VERSION } }),
  );
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const base64url = (value) => Buffer.from(value).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest();
const jwt = (payload) => `header.${base64url(JSON.stringify(payload))}.signature`;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function fakeBackend(tokens) {
  const requests = [];
  let polls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw.length > 0 ? JSON.parse(raw) : null;
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body });
    const reply = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    switch (url.pathname) {
      case '/auth/poll':
        polls += 1;
        return polls === 1
          ? reply(404, {})
          : reply(200, { accessToken: tokens.expired, refreshToken: 'refresh-1', selectedTeamId: 42 });
      case '/oauth/token':
        return reply(200, { access_token: tokens.fresh, refresh_token: 'refresh-2' });
      case '/sand-box/local-exec-daemon-credential':
        return reply(200, { credential: 'daemon-credential', expiresAtMs: 9_100_000_000_000 });
      case '/aiserver.v1.GrokBotService/IssueGrokBotUserComputerCredential':
        return reply(200, { credential: 'computer-credential', expiresAtMs: '9000000000000', serverAuthoritative: true });
      case '/aiserver.v1.DashboardService/RegisterSandMachine':
        return reply(200, {});
      case '/aiserver.v1.DashboardService/UpdateSandMachineLocalToolPermission':
        return reply(200, { machine: { machineId: body.machineId, label: 'host', localToolPermission: body.localToolPermission } });
      default:
        return reply(404, { message: `unknown route ${url.pathname}` });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ requests, server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('the CLI drives the whole lifecycle against a fake backend and daemon', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'grok-bot-headless-cli-'));
  const configDir = join(root, 'config');
  const dataRoot = join(root, 'data');
  const shimDir = join(root, 'bin');
  const appDir = join(root, 'app');
  mkdirSync(shimDir);
  mkdirSync(appDir);
  // logout calls systemctl; the shim keeps the test away from the real user manager.
  writeFileSync(join(shimDir, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(appDir, 'package.json'), '{"version":"0.30.0"}\n');
  writeFileSync(join(appDir, 'daemon.cjs'), FAKE_DAEMON);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokens = {
    expired: jwt({ sub: 'user-1', exp: nowSeconds - 60 }),
    fresh: jwt({ sub: 'user-1', exp: nowSeconds + 3600 }),
  };
  const backend = await fakeBackend(tokens);
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    GROK_BOT_HEADLESS_CONFIG_DIR: configDir,
    SAND_DATA_ROOT: dataRoot,
    GROK_BOT_BINARY: process.execPath,
    GROK_BOT_DAEMON_SCRIPT: join(appDir, 'daemon.cjs'),
    GROK_BOT_PACKAGE_JSON: join(appDir, 'package.json'),
    CURSOR_API_BASE_URL: backend.url,
    CURSOR_WEBSITE_URL: 'https://website.example.test',
    GROK_BOT_ALLOW_INSECURE_LOCALHOST: '1',
  };
  delete env.SAND_CLIENT_APP_VERSION;
  const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  const paths = {
    credentials: join(configDir, 'credentials.json'),
    machine: join(configDir, 'machine.json'),
    daemonCredential: join(dataRoot, 'local-exec-daemon-credential.json'),
    heartbeat: join(dataRoot, 'local-exec-supervisor.json'),
    discovery: join(dataRoot, 'local-exec-daemon.json'),
    settings: join(dataRoot, 'settings.json'),
  };
  const requestsTo = (suffix) => backend.requests.filter((request) => request.path.endsWith(suffix));

  try {
    await t.test('login completes browser-link PKCE and saves credentials with owner-only access', async () => {
      const { stdout } = await cli('login');
      const loginUrl = new URL(stdout.match(/https:\/\/\S+/)[0]);
      assert.equal(`${loginUrl.origin}${loginUrl.pathname}`, 'https://website.example.test/loginDeepControl');
      assert.equal(loginUrl.searchParams.get('redirectTarget'), 'sand');
      const polls = requestsTo('/auth/poll');
      assert.equal(polls.length, 2, 'a 404 poll is retried');
      assert.equal(polls[0].query.uuid, loginUrl.searchParams.get('uuid'));
      assert.equal(base64url(sha256(polls[0].query.verifier)), loginUrl.searchParams.get('challenge'));
      assert.match(stdout, /Account authorized/);
      const saved = readJson(paths.credentials);
      assert.deepEqual(
        { accessToken: saved.accessToken, refreshToken: saved.refreshToken, selectedTeamId: saved.selectedTeamId },
        { accessToken: tokens.expired, refreshToken: 'refresh-1', selectedTeamId: 42 },
      );
      assert.equal(statSync(paths.credentials).mode & 0o777, 0o600);
      assert.equal(statSync(configDir).mode & 0o777, 0o700);
    });

    await t.test('check refreshes an expiring token and mints both runtime credentials', async () => {
      const { stdout } = await cli('check');
      assert.deepEqual(JSON.parse(stdout), {
        compatible: true,
        installedVersion: '0.30.0',
        testedVersion: true,
        daemonEntryPoint: 'verified',
        authentication: 'verified',
      });
      const [refresh] = requestsTo('/oauth/token');
      assert.deepEqual(refresh.body, { client_id: AUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'refresh-1' });
      const saved = readJson(paths.credentials);
      assert.equal(saved.accessToken, tokens.fresh);
      assert.equal(saved.refreshToken, 'refresh-2');
      assert.equal(saved.selectedTeamId, 42, 'refresh keeps the selected team');

      const machine = readJson(paths.machine);
      const [mint] = requestsTo('/sand-box/local-exec-daemon-credential');
      assert.deepEqual(mint.body, {});
      assert.equal(mint.headers.authorization, `Bearer ${tokens.fresh}`);
      assert.equal(mint.headers['x-cursor-team-id'], '42');
      assert.equal(mint.headers['x-cursor-client-type'], 'sand');
      assert.equal(mint.headers['x-cursor-client-version'], '0.30.0');
      assert.ok(mint.headers['x-cursor-checksum'].endsWith(machine.machineId));
      const [computer] = requestsTo('/IssueGrokBotUserComputerCredential');
      assert.deepEqual(computer.body, { machineId: machine.machineId });
      assert.equal(computer.headers['connect-protocol-version'], '1');
      assert.deepEqual(readJson(paths.daemonCredential), {
        credential: 'daemon-credential',
        backendUrl: backend.url,
        expiresAtMs: 9_100_000_000_000,
        userComputer: {
          credential: 'computer-credential',
          machineId: machine.machineId,
          expiresAtMs: 9_000_000_000_000,
          accountScope: sha256('user-1').toString('hex'),
          serverAuthoritative: true,
        },
      });
    });

    await t.test('policy registers the machine, updates the backend, and stores the local setting', async () => {
      const { stdout } = await cli('policy', 'always');
      assert.match(stdout, /set to always/);
      const methods = backend.requests
        .filter((request) => request.path.startsWith('/aiserver.v1.DashboardService/'))
        .map((request) => request.path.split('/').pop());
      assert.deepEqual(methods, ['RegisterSandMachine', 'UpdateSandMachineLocalToolPermission']);
      assert.deepEqual(readJson(paths.settings), { version: 1, localToolPermission: 'always' });
      await assert.rejects(cli('policy', 'sometimes'), /Policy must be one of: always, ask, never/);
    });

    await t.test('run supervises the daemon, reports status, notices a crash, and stops cleanly', async () => {
      const controller = spawn(process.execPath, [CLI, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      controller.stdout.on('data', (chunk) => { stdout += chunk; });
      controller.stderr.on('data', (chunk) => { stderr += chunk; });
      const exit = new Promise((resolve) => controller.once('exit', (code, signal) => resolve({ code, signal })));
      try {
        await waitFor(() => stdout.includes('Native Grok Bot node started'), 'controller start');
        const machine = readJson(paths.machine);
        const discovery = await waitFor(() => existsSync(paths.discovery) && readJson(paths.discovery), 'daemon bootstrap');
        assert.deepEqual(discovery.bootstrap, { type: 'sand-local-exec-file-key', key: null, computerId: machine.machineId });
        assert.deepEqual(discovery.env, {
          ELECTRON_RUN_AS_NODE: '1',
          SAND_PACKAGED: '1',
          SAND_DATA_ROOT: dataRoot,
          SAND_CLIENT_APP_VERSION: '0.30.0',
        });
        assert.equal(readJson(paths.heartbeat).pid, controller.pid);

        const status = JSON.parse((await cli('status')).stdout);
        assert.deepEqual(status, {
          label: hostname(),
          machineId: machine.machineId,
          daemonPid: discovery.pid,
          daemonAlive: true,
          localToolPermission: 'always',
          credentialExpiresAtMs: 9_000_000_000_000,
          dataRoot,
        });

        process.kill(discovery.pid, 'SIGKILL');
        await waitFor(() => stderr.includes('local-exec daemon exited (SIGKILL); restarting in 5 seconds'), 'crash notice');
      } finally {
        controller.kill('SIGTERM');
      }
      assert.deepEqual(await exit, { code: 0, signal: null });
      assert.equal(existsSync(paths.heartbeat), false, 'stop removes the supervisor heartbeat');
    });

    await t.test('logout removes credentials and keeps the machine identity and policy', async () => {
      const { stdout } = await cli('logout');
      assert.match(stdout, /credentials removed/);
      for (const path of [paths.credentials, paths.daemonCredential, paths.discovery]) {
        assert.equal(existsSync(path), false, path);
      }
      assert.equal(existsSync(paths.machine), true);
      assert.equal(existsSync(paths.settings), true);
      await assert.rejects(cli('check'), /No valid account credentials\. Run: grok-bot-headless login/);
    });
  } finally {
    backend.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
