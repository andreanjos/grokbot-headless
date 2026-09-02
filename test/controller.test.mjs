import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountScope,
  base64url,
  cursorChecksum,
  hasCredentialShape,
  isTestedClientVersion,
  jwtPayload,
  syncMachinePolicy,
  trimSlash,
  validatedServiceUrl,
} from '../grok-bot-headless.mjs';

test('trimSlash removes all trailing slashes', () => {
  assert.equal(trimSlash('https://api.example.test///'), 'https://api.example.test');
});

test('service URLs require HTTPS and reject embedded credentials', () => {
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
