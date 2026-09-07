// test/server-api.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.js';

let server, base, dataDir;
const TOKEN = 's3cret';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-api-'));
  const api = createApi({ dataDir, token: TOKEN });
  server = createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

test('health ok', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.deepEqual(await r.json(), { ok: true });
});

test('write requires auth', async () => {
  const name = 'sailviz-20260101-0900.sailviz.json';
  const unauth = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(unauth.status, 401);
});

test('unlock then write then read', async () => {
  const name = 'sailviz-20260101-0900.sailviz.json';
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const put = await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer, body: JSON.stringify({ version: 1, tracks: [] }),
  });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(got.version, 1);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.some((p) => p.name === name), true);
});

test('unlock endpoint validates password', async () => {
  const bad = await fetch(`${base}/api/unlock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/unlock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TOKEN }),
  });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie') || '', /sailviz_token=/);
});

test('summaries returns lightweight rows', async () => {
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows[0]?.reflectionCount !== undefined, true);
});

test('overlay put/get', async () => {
  const put = await fetch(`${base}/api/overlays/progress`, {
    method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ r1: { issueStage: 2 } }),
  });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/overlays/progress`)).json();
  assert.deepEqual(got, { r1: { issueStage: 2 } });
});
