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
import { practiceSummary } from '../src/summary.js';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
let server, base, dataDir, db;
const TOKEN = 's3cret';
const NAME = 'sailviz-20260101-0900.sailviz.json';
const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let nameId; // NAME の器の練習 ID(POST で作ったときに受け取る)
// 新しい器は POST /api/projects で作る。返り値の id で以後引く。
const create = async (name, project) => {
  const r = await fetch(`${base}/api/projects`, { method: 'POST', headers: bearer, body: JSON.stringify({ name, project }) });
  assert.equal(r.status, 201);
  return (await r.json()).id;
};

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
  const api = createApi({ repo, token: TOKEN, migrationOrgId: 'o_test' }); // DB 版は MIGRATION_ORG_ID が必須(S2.5-P2)
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

test('POST→PUT→GET→list が DB 版で動く', { skip: skipMsg }, async () => {
  nameId = await create(NAME, proj());
  assert.match(nameId, /^pd_[0-9a-f]{10}$/);
  const put = await fetch(`${base}/api/projects/${nameId}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj({ version: 2 })) });
  assert.equal(put.status, 200);
  const got = await (await fetch(`${base}/api/projects/${nameId}`)).json();
  assert.equal(got.version, 2);
  assert.equal(got._rev, 2);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.ok(list.some((p) => p.id === nameId && p.name === NAME));
});

test('PUT は既存の器だけ(無い ID・名前は 404)', { skip: skipMsg }, async () => {
  for (const id of ['pd_0000000000', 'sailviz-20260109-0900.sailviz.json']) {
    const r = await fetch(`${base}/api/projects/${id}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj()) });
    assert.equal(r.status, 404, id);
  }
  assert.equal((await fetch(`${base}/api/projects/pd_XYZ`)).status, 400, 'ID の形でなければ 400');
});

test('summaries が DB 版で軽量行を返す', { skip: skipMsg }, async () => {
  const rows = await (await fetch(`${base}/api/summaries`)).json();
  assert.ok(Array.isArray(rows));
  assert.equal(rows.find((r) => r.name === NAME)?.id, nameId);
});

test('GET /api/reflections は練習ごとの反省だけを返す(軌跡を読まない)', { skip: skipMsg }, async () => {
  const name = 'sailviz-20260103-0900.sailviz.json';
  const id = await create(name, proj({ tracks: [trk('t1')], reflections: [{ id: 'rb', people: ['部員 B'] }, { id: 'ra', people: ['部員 A'] }] }));
  const rows = await (await fetch(`${base}/api/reflections`)).json();
  const e = rows.find((r) => r.id === id);
  assert.deepStrictEqual(e, { id, name, reflections: [{ id: 'rb', people: ['部員 B'] }, { id: 'ra', people: ['部員 A'] }] });
  assert.ok(rows.some((r) => r.id === nameId && Array.isArray(r.reflections)));
});

test('summaries は軌跡の点列を読まずに、全体を読んだときと同じ要約を返す(件数・練習日時)', { skip: skipMsg }, async () => {
  const name = 'sailviz-20260105-0900.sailviz.json';
  const t = (id, start) => ({ ...trk(id), tRange: { start, end: start + 1000 } });
  const id = await create(name, proj({ tracks: [t('t2', 1_800_000_000_000), t('t1', 1_700_000_000_000)], reflections: [{ id: 'rs', wind: { dir: 'N', speed: 3 } }] }));
  const row = (await (await fetch(`${base}/api/summaries`)).json()).find((r) => r.id === id);
  const full = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.deepStrictEqual(row, { id, name, ...practiceSummary(full, { name }) });
  assert.equal(row.trackCount, 2);
  assert.equal(row.trackedAt, 1_700_000_000_000);
  const light = createDbRepo({ db, dataDir }).readSummaryWithAccess(id);
  assert.equal(light.project.tracks.length, 2);
  assert.ok(light.project.tracks.every((x) => x.points === undefined && x.tRange), '点列は読まない・tRange は読む');
  assert.equal(light.access.tracks.length, 2);
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
  const id = await create(n, proj({ tracks: [trk('a'), trk('b')] }));
  // クライアントが b を知らずに a だけで保存
  await fetch(`${base}/api/projects/${id}`, { method: 'PUT', headers: bearer, body: JSON.stringify(proj({ tracks: [trk('a')] })) });
  const got = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.deepEqual(got.tracks.map((t) => t.id).sort(), ['a', 'b']);
});

test('404 for missing project', { skip: skipMsg }, async () => {
  const r = await fetch(`${base}/api/projects/sailviz-29991231-0000.sailviz.json`);
  assert.equal(r.status, 404);
});
