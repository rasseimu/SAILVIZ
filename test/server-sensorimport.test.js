// test/server-sensorimport.test.js
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
const NS = 1_000_000;
const t0 = Date.UTC(2026, 8, 8, 0, 6, 0);
// 注意: 点間隔は rejectOutliers(MAX_SPEED_MPS=25) に落とされない現実的な速度にする。
// 0.001 度 ≈ 110m。10 秒間隔なら約 11m/s で保持される（1 秒だと 140m/s で除去され点数が崩れる）。
const CSV = [
  'time,latitude,longitude,speed',
  `${t0 * NS},35.300,139.480,3.1`,
  `${(t0 + 10000) * NS},35.301,139.481,3.2`,
].join('\n');

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sv-si-'));
  const api = createApi({ dataDir, token: TOKEN });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });

test('preview: 未認証は 401', async () => {
  const r = await fetch(`${base}/api/sensor-imports`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person: 'x', filename: 'a.csv', csv: CSV }),
  });
  assert.equal(r.status, 401);
});

test('preview: 認証あり -> importId と practiceDate、matched は null', async () => {
  const r = await fetch(`${base}/api/sensor-imports`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ person: '山田 太郎', filename: 'Location.csv', csv: CSV }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.importId, /^imp_[A-Za-z0-9_]+$/);
  assert.equal(j.points, 2);
  assert.equal(j.matched, null);
  assert.ok(j.practiceDate > 0);
  assert.ok(j.bounds && typeof j.bounds.minLat === 'number' && typeof j.bounds.maxLon === 'number');
});

test('preview: GPS 点ゼロは 422', async () => {
  const r = await fetch(`${base}/api/sensor-imports`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ person: 'x', filename: 'a.csv', csv: 'time,latitude,longitude\n' }),
  });
  assert.equal(r.status, 422);
});

test('preview: person/csv 欠落は 400', async () => {
  const r = await fetch(`${base}/api/sensor-imports`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ person: 'x' }),
  });
  assert.equal(r.status, 400);
});

test('commit: 既存プロジェクトの tracks/sensorLogs に反映', async () => {
  // 対象プロジェクトを用意
  const name = 'sailviz-20260908-0906-m1.sailviz.json';
  await fetch(`${base}/api/projects/${name}`, {
    method: 'PUT', headers: bearer,
    body: JSON.stringify({ version: 1, practiceDate: t0, reflections: [{ people: ['山田 太郎'] }] }),
  });
  // プレビュー
  const pv = await (await fetch(`${base}/api/sensor-imports`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ person: '山田 太郎', filename: 'Location.csv', csv: CSV }),
  })).json();
  // コミット
  const r = await fetch(`${base}/api/sensor-imports/${pv.importId}/commit`, {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ name, boatNumber: '4649' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).name, name);
  // 反映確認
  const proj = await (await fetch(`${base}/api/projects/${name}`)).json();
  assert.equal(proj.tracks.length, 1);
  assert.equal(proj.tracks[0].source.boatNumber, '4649');
  assert.equal(proj.sensorLogs.length, 1);
  assert.match(proj.sensorLogs[0].filename, /^4649_\d{8}-\d{4}\.csv$/);
});

test('commit: 未認証は 401 / name 欠如は 400 / 不明 importId は 404', async () => {
  const noauth = await fetch(`${base}/api/sensor-imports/imp_x/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(noauth.status, 401);
  const bad = await fetch(`${base}/api/sensor-imports/imp_x/commit`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ boatNumber: '1' }),
  });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${base}/api/sensor-imports/imp_notexist/commit`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ name: 'sailviz-20260101-0900.sailviz.json', boatNumber: '1' }),
  });
  assert.equal(missing.status, 404);
});
