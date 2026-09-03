import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  accountScope,
  base64url,
  cursorChecksum,
  hasCredentialShape,
  isTestedClientVersion,
  jwtPayload,
  syncMachinePolicy,
  tokenExpiresSoon,
  validatedServiceUrl,
} from '../grok-bot-headless.mjs';

test('service URLs require HTTPS, drop trailing slashes, and reject embedded credentials', () => {
  assert.equal(validatedServiceUrl('https://api.example.test///', 'backend'), 'https://api.example.test');
  assert.throws(
    () => validatedServiceUrl('http://api.example.test', 'backend'),
    /backend URL must use HTTPS/,
  );
  assert.throws(
    () => validatedServiceUrl('https://user:secret@api.example.test', 'backend'),
    /backend URL cannot contain credentials/,
  );
});

test('plain HTTP is allowed for loopback hosts only with the explicit opt-in', () => {
  assert.throws(() => validatedServiceUrl('http://127.0.0.1:8080', 'backend'), /must use HTTPS/);
  process.env.GROK_BOT_ALLOW_INSECURE_LOCALHOST = '1';
  try {
    assert.equal(validatedServiceUrl('http://localhost:8080/', 'backend'), 'http://localhost:8080');
    assert.equal(validatedServiceUrl('http://127.0.0.1:8080', 'backend'), 'http://127.0.0.1:8080');
    assert.equal(validatedServiceUrl('http://[::1]:8080', 'backend'), 'http://[::1]:8080');
    assert.throws(() => validatedServiceUrl('http://api.example.test', 'backend'), /must use HTTPS/);
  } finally {
    delete process.env.GROK_BOT_ALLOW_INSECURE_LOCALHOST;
  }
});

test('access tokens expire soon inside the refresh margin or without an exp claim', () => {
  const token = (payload) => `header.${base64url(JSON.stringify(payload))}.signature`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal(tokenExpiresSoon(token({ exp: nowSeconds + 3600 })), false);
  assert.equal(tokenExpiresSoon(token({ exp: nowSeconds + 60 })), true);
  assert.equal(tokenExpiresSoon(token({ exp: nowSeconds - 60 })), true);
  assert.equal(tokenExpiresSoon(token({})), true);
  assert.equal(tokenExpiresSoon('not-a-jwt'), true);
});

test('base64url uses URL-safe encoding without padding', () => {
  assert.equal(base64url(Buffer.from([251, 255, 239])), '-__v');
});

test('cursorChecksum matches the Grok Bot byte transform', () => {
  assert.equal(cursorChecksum('machine-123', 1_788_370_000_000), '7D9BXRjPmachine-123');
});

test('compatibility metadata identifies tested client versions', () => {
  assert.equal(isTestedClientVersion('0.30.0'), true);
  assert.equal(isTestedClientVersion('99.0.0'), false);
});

test('credential validation requires both non-empty tokens', () => {
  assert.equal(hasCredentialShape({ accessToken: 'access', refreshToken: 'refresh' }), true);
  assert.equal(hasCredentialShape({ accessToken: 'access' }), false);
  assert.equal(hasCredentialShape({ accessToken: '', refreshToken: 'refresh' }), false);
  assert.equal(hasCredentialShape(null), false);
});

test('JWT payload and account scope use the token subject', () => {
  const payload = base64url(JSON.stringify({ sub: 'user-123', email: 'person@example.test' }));
  const token = `header.${payload}.signature`;
  assert.deepEqual(jwtPayload(token), { sub: 'user-123', email: 'person@example.test' });
  assert.equal(accountScope(token), 'fcdec6df4d44dbc637c7c5b58efface52a7f8a88535423430255be0bb89bedd8');
});

test('machine policy registers the machine before updating its backend permission', async () => {
  const calls = [];
  const identity = { machineId: 'machine-123', label: 'build-host' };
  const credentials = { accessToken: 'access', refreshToken: 'refresh' };
  const connect = async (service, method, request, receivedCredentials, machineId) => {
    calls.push({ service, method, request, receivedCredentials, machineId });
    return method === 'UpdateSandMachineLocalToolPermission'
      ? { machine: { machineId, label: identity.label, localToolPermission: 'always' } }
      : {};
  };

  const machine = await syncMachinePolicy('always', identity, credentials, connect);

  assert.equal(machine.localToolPermission, 'always');
  assert.deepEqual(calls.map(({ method }) => method), [
    'RegisterSandMachine',
    'UpdateSandMachineLocalToolPermission',
  ]);
  assert.deepEqual(calls[0].request, { label: 'build-host', localToolPermission: 'always' });
  assert.deepEqual(calls[1].request, { machineId: 'machine-123', localToolPermission: 'always' });
  assert.ok(calls.every(({ service }) => service === 'aiserver.v1.DashboardService'));
});

test('machine policy rejects a backend permission ceiling', async () => {
  const connect = async (_service, method) => (
    method === 'UpdateSandMachineLocalToolPermission'
      ? { machine: { machineId: 'machine-123', localToolPermission: 'ask' } }
      : {}
  );
  await assert.rejects(
    syncMachinePolicy(
      'always',
      { machineId: 'machine-123', label: 'build-host' },
      { accessToken: 'access', refreshToken: 'refresh' },
      connect,
    ),
    /backend limited the machine policy to ask/,
  );
});

test('the CLI runs when its path contains a symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grok-bot-headless-'));
  try {
    const link = join(directory, 'grok-bot-headless.mjs');
    symlinkSync(fileURLToPath(new URL('../grok-bot-headless.mjs', import.meta.url)), link);
    const output = execFileSync(process.execPath, [link, 'help'], { encoding: 'utf8' });
    assert.match(output, /^Usage: grok-bot-headless/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
