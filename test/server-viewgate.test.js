// test/server-viewgate.test.js
// 閲覧ログインゲートの結合テスト。viewUser/viewPassword を設定した時のみ
// GET データ系が保護され、ログイン後の Cookie で閲覧できることを確認する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.js';

let server, base, dataDir;
const TOKEN = 's3cret';
const VIEW_USER = '芝浦工業大学体育会ヨット部';
const VIEW_PASSWORD = '6235';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-viewgate-'));
  const api = createApi({ dataDir, token: TOKEN, viewUser: VIEW_USER, viewPassword: VIEW_PASSWORD });
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

test('session reports gate on and logged out initially', async () => {
  const s = await (await fetch(`${base}/api/session`)).json();
  assert.equal(s.gate, true);
  assert.equal(s.loggedIn, false);
});

test('GET data is blocked without login', async () => {
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/summaries`)).status, 401);
});

test('login rejects wrong credentials', async () => {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: VIEW_USER, password: 'wrong' }),
  });
  assert.equal(r.status, 401);
});

test('login sets cookie and unlocks viewing', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: VIEW_USER, password: VIEW_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /sailviz_view=/);

  const projects = await fetch(`${base}/api/projects`, { headers: { cookie } });
  assert.equal(projects.status, 200);

  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  assert.equal(session.loggedIn, true);
});

test('edit-mode write token also grants viewing', async () => {
  const projects = await fetch(`${base}/api/projects`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(projects.status, 200);
});
