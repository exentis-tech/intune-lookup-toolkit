// End-to-end tests for server.ps1 against a fake Graph. Needs PowerShell 7 (pwsh) on PATH, or PWSH=/path/to/pwsh.
// Run: npm run test:server
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGraph, SECRET } from './fake-graph.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PWSH = process.env.PWSH || 'pwsh';
const GRAPH_PORT = 9411;
const PORT = 8491;
const dir = mkdtempSync(join(tmpdir(), 'ilt-'));

function config(port, extra = {}) {
  const file = join(dir, `config-${port}.json`);
  writeFileSync(file, JSON.stringify({
    TenantId: 'contoso.onmicrosoft.com',
    ApplicationId: '11111111-2222-3333-4444-555555555555',
    ClientSecret: SECRET,
    GraphBaseUrl: `http://127.0.0.1:${GRAPH_PORT}/v1.0`,
    GraphBetaBaseUrl: `http://127.0.0.1:${GRAPH_PORT}/beta`,
    AuthorityHost: `http://127.0.0.1:${GRAPH_PORT}`,
    ListenPrefix: `http://127.0.0.1:${port}/`,
    AllowedOrigin: '*',
    EnableRealDelete: true, // ignored: this tool is read-only
    RequestTimeoutSeconds: 15,
    ...extra,
  }));
  return file;
}

function startServer(cfgFile) {
  const p = spawn(PWSH, ['-NoProfile', '-File', join(ROOT, 'server.ps1'), '-ConfigPath', cfgFile, '-NoBrowser']);
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const done = new Promise(r => p.on('exit', code => r(code)));
  return { p, done, output: () => out };
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/session`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

let fake, srv, session;
before(async () => {
  fake = await startFakeGraph(GRAPH_PORT);
  srv = startServer(config(PORT));
  session = await waitUp(PORT);
});
after(() => {
  srv && srv.p.kill();
  fake && fake.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const g = (path, init = {}) =>
  fetch(`http://127.0.0.1:${PORT}/graph/v1.0${path}`, { ...init, headers: { 'X-IAD-Session': session.sessionToken, ...(init.headers || {}) } });

test('session is read-only and never exposes the secret', () => {
  assert.equal(session.mode, 'app');
  assert.equal(session.readOnly, true);
  assert.equal(session.appDisplayName, 'Intune Lookup Toolkit');
  assert.match(session.sessionToken, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(session).includes(SECRET));
  assert.match(srv.output(), /read-only/);
});

test('serves the UI but never config.json, scripts or tests', async () => {
  const ok = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Intune Lookup Toolkit/);
  for (const p of ['/config.json', '/server.ps1', '/config.example.json', '/tests/fake-graph.js', '/js/../server.ps1', '/package.json']) {
    assert.equal((await fetch(`http://127.0.0.1:${PORT}${p}`)).status, 404, p);
  }
});

test('needs the session token and refuses other origins', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/graph/v1.0/devices`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('reads devices, managed devices, users and groups', async () => {
  for (const p of ['/devices', '/deviceManagement/managedDevices', '/users', '/groups', "/users?$filter=userPrincipalName eq 'jane.doe@contoso.com'"]) {
    const r = await g(p);
    assert.equal(r.status, 200, p);
  }
});

test('anything outside the allowlist is refused', async () => {
  for (const p of ['/deviceAppManagement/mobileApps', '/deviceManagement/deviceConfigurations', '/me/messages', '/sites/root', '/applications']) {
    assert.equal((await g(p)).status, 403, p);
  }
});

test('every write is refused, even with EnableRealDelete in the config', async () => {
  assert.equal((await g('/devices/x', { method: 'DELETE' })).status, 405);
  assert.equal((await g('/users/x', { method: 'PATCH', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 405);
  assert.equal((await g('/groups', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 405);
  const batch = reqs => g('/$batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }) });
  assert.equal((await batch([{ id: '1', method: 'GET', url: 'devices' }])).status, 200);
  assert.equal((await batch([{ id: '1', method: 'DELETE', url: 'devices/x' }])).status, 403);
  assert.equal((await batch([{ id: '1', method: 'GET', url: 'deviceAppManagement/mobileApps' }])).status, 403);
  assert.ok(!fake.calls.some(c => !/^(GET|POST \/v1\.0\/\$batch|POST \/[^ ]*\/oauth2)/.test(c)), 'only reads reached Graph');
});

test('a wrong secret stops the server with a clear message', async () => {
  const s = startServer(config(8492, { ClientSecret: 'wrong' }));
  assert.notEqual(await s.done, 0);
  assert.match(s.output(), /AADSTS7000215/);
});

test('a non-loopback ListenPrefix is refused', async () => {
  for (const prefix of ['http://0.0.0.0:8493/', 'http://+:8493/']) {
    const s = startServer(config(8493, { ListenPrefix: prefix }));
    assert.notEqual(await s.done, 0, prefix);
    assert.match(s.output(), /loopback/, prefix);
  }
});
