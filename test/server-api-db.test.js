// test/server-api-db.test.js
// 互換 API を DB 版リポジトリで動かす結合テスト(既存 server-api.test.js の DB 版)。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
let server, base, dataDir, db;
const TOKEN = 's3cret';
const NAME = 'sailviz-20260101-0900.sailviz.json';
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let openDb, migrate, loadMigrations, createDbRepo;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createDbRepo } = await import('../server/repos/dbRepo.js'));
}

before(async () => {
  if (!hasSqlite) return;
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-apidb-'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  const repo = createDbRepo({ db, dataDir });
  const api = createApi({ repo, token: TOKEN });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (!hasSqlite) return;
  await new Promise((r) => server.close(r));
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const trk = (id) => ({ id, name: id, color: '#e6194B', visible: true,
  points: [{ t: 1, lat: 35, lon: 139, speed: 1 }],
  bounds: { minLat: 35, maxLat: 35, minLon: 139, maxLon: 139 } });
const proj = (over = {}) => ({ version: 1, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
  tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [], ...over });

test('PUT 認証必須(401)', { skip: skipMsg }, async () => {
  const r = await fetch(`${base}/api/projects/${NAME}`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(proj()) });
  assert.equal(r.status, 401);
});

test('PUT→GET→list が DB 版で動く', { skip: skipMsg }, async () => {
  const put = await fetch(`${base}/api/projects/${NAME}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj()) });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/projects/${NAME}`)).json();
  assert.equal(got.version, 1);
  assert.equal(got._rev, 1);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.ok(list.some((p) => p.name === NAME));
});

test('summaries が DB 版で軽量行を返す', { skip: skipMsg }, async () => {
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.ok(Array.isArray(rows));
  assert.ok(rows.find((r) => r.name === NAME));
});

test('overlay put/get が DB 版で動く', { skip: skipMsg }, async () => {
  const put = await fetch(`${base}/api/overlays/progress`, { method: 'PUT', headers: bearer,
    body: JSON.stringify({ r1: { issueStage: 2, goalDone: false } }) });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/overlays/progress`)).json();
  assert.deepStrictEqual(got, { r1: { issueStage: 2, goalDone: false } });
});

test('削除ルール②: 古い画面からの PUT で新しく届いた軌跡が消えない(HTTP 経路)', { skip: skipMsg }, async () => {
  const n = 'sailviz-20260202-0900.sailviz.json';
  await fetch(`${base}/api/projects/${n}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj({ tracks: [trk('a'), trk('b')] })) });
  // クライアントが b を知らずに a だけで保存
  await fetch(`${base}/api/projects/${n}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj({ tracks: [trk('a')] })) });
  const got = await (await fetch(`${base}/api/projects/${n}`)).json();
  assert.deepEqual(got.tracks.map((t) => t.id).sort(), ['a', 'b']);
});

test('404 for missing project', { skip: skipMsg }, async () => {
  const r = await fetch(`${base}/api/projects/sailviz-29991231-0000.sailviz.json`);
  assert.equal(r.status, 404);
});
