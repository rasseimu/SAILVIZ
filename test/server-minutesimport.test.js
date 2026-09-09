// test/server-minutesimport.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.js';

let server, base, dataDir;
const TOKEN = 's3cret';
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
// JST 2026-09-09 00:00 = UTC 2026-09-08 15:00
const PD_NEW = Date.UTC(2026, 8, 8, 15, 0, 0);
// JST 2026-09-10 00:00(append テスト用に別日)
const PD_APPEND = Date.UTC(2026, 8, 9, 15, 0, 0);

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sv-mi-'));
  const api = createApi({ dataDir, token: TOKEN });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });

const commit = (body, headers = bearer) => fetch(`${base}/api/minutes-imports/commit`, {
  method: 'POST', headers, body: JSON.stringify(body),
});

test('commit: 未認証は 401', async () => {
  const r = await commit({ practiceDate: PD_NEW, rows: [{ fullName: '本間 由真' }] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
});

test('commit: 名簿外 fullName は 400', async () => {
  const r = await commit({ practiceDate: PD_NEW, rows: [{ fullName: '存在 しない', goal: 'g' }] });
  assert.equal(r.status, 400);
});

test('commit: 新規プロジェクトを作成して反省を保存', async () => {
  const r = await commit({
    practiceDate: PD_NEW,
    rows: [{ fullName: '本間 由真', goal: 'g', issue: 'i', discovery: 'd', raw: 'r' }],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.created, true);
  assert.equal(j.added, 1);
  assert.match(j.name, /^sailviz-20260909-0000\.sailviz\.json$/);
  const proj = await (await fetch(`${base}/api/projects/${j.name}`)).json();
  assert.equal(proj.reflections.length, 1);
  assert.deepEqual(proj.reflections[0].people, ['本間 由真']);
  assert.equal(proj.reflections[0].notes.goal, 'g');
  assert.equal(proj.practiceDate, PD_NEW);
});

test('commit: 既存(practiceDate 一致)へ append し同一部員はマージ', async () => {
  const name = 'sailviz-20260910-0000.sailviz.json';
  await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer,
    body: JSON.stringify({ version: 1, practiceDate: PD_APPEND, reflections: [] }),
  });
  const r = await commit({
    practiceDate: PD_APPEND,
    rows: [
      { fullName: '高田 咲', goal: 'a', issue: '', discovery: '', raw: 'r1' },
      { fullName: '高田 咲', goal: 'b', issue: '', discovery: '', raw: 'r2' },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.created, false);
  assert.equal(j.name, name);
  assert.equal(j.added, 1); // 同一部員2行 → 1反省
  const proj = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(proj.reflections.length, 1);
  assert.equal(proj.reflections[0].notes.goal, 'a\nb');
});
