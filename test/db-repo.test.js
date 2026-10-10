// test/db-repo.test.js
// DB 版リポジトリ(fileRepo と同一インターフェース)。node:sqlite が要る(Node >=22.5/24)。
// 互換 PUT の削除ルール(§10.8/§5)を重点的に検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');

let openDb, migrate, loadMigrations, createDbRepo;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createDbRepo } = await import('../server/repos/dbRepo.js'));
}

async function freshRepo() {
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-dbrepo-'));
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  return { repo: createDbRepo({ db, dataDir }), db, dataDir };
}

const track = (id, extra = {}) => ({
  id, name: id, color: '#e6194B', visible: true,
  points: [{ t: 1, lat: 35, lon: 139, speed: 1 }],
  bounds: { minLat: 35, maxLat: 35, minLon: 139, maxLon: 139 }, ...extra,
});
const baseProj = (over = {}) => ({
  version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
  tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [], ...over,
});

test('write→read 往復(assemble + _rev 付与)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const proj = baseProj({ tracks: [track('t1', { tRange: { start: 1, end: 2 } })],
    reflections: [{ id: 'r1', createdAt: 1, text: 'x', people: ['村瀬 礼'], notes: {} }] });
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', proj);
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  assert.equal(got._rev, 1);
  const { _rev, ...pure } = got;
  assert.deepStrictEqual(pure, proj);
  await rm(dataDir, { recursive: true, force: true });
});

test('listProjects が書いた器を返す(降順)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj());
  await repo.writeProject('sailviz-20260902-0900.sailviz.json', baseProj());
  assert.deepEqual((await repo.listProjects()).map((p) => p.name), ['sailviz-20260902-0900.sailviz.json', 'sailviz-20260901-0900.sailviz.json']);
  await rm(dataDir, { recursive: true, force: true });
});

test('削除ルール②: _rev 無し PUT で既存トラックを消さない(新しく届いた軌跡が残る)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  // 初期2トラック
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [track('t1'), track('t2')] }));
  // クライアントが t2 を含まない JSON を _rev 無しで PUT
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [track('t1')] }));
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  const ids = got.tracks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't2'], 't2 は消えない');
  await rm(dataDir, { recursive: true, force: true });
});

test('削除ルール③: 表示設定の編集は in-place 更新(複製せず点列も保持)', { skip: skipMsg }, async () => {
  // Web は GPS 点列を編集しない。同じ点列で view(visible/name)だけ変えて保存する。
  // トラックは点列の指紋で同定され、既存行を上書き更新する(複製しない・点列列は触らない)。
  const { repo, dataDir } = await freshRepo();
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [track('t1')] }));
  const edited = { ...track('t1'), visible: false, name: 'renamed' }; // 点列は同じ
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [edited] }));
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  assert.equal(got.tracks.length, 1, '複製されない(in-place 更新)');
  const t = got.tracks[0];
  assert.equal(t.visible, false, '表示設定は反映');
  assert.equal(t.name, 'renamed');
  assert.deepStrictEqual(t.points, [{ t: 1, lat: 35, lon: 139, speed: 1 }], '点列は保持');
  await rm(dataDir, { recursive: true, force: true });
});

test('新規トラックは追加される(点列込み)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [track('t1')] }));
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ tracks: [track('t1'), track('t2')] }));
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  assert.deepEqual(got.tracks.map((t) => t.id).sort(), ['t1', 't2']);
  await rm(dataDir, { recursive: true, force: true });
});

test('反省は入れ替わる(Web の編集を尊重: 消したものは消える)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const r = (id) => ({ id, createdAt: 1, text: id, people: [], notes: {} });
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ reflections: [r('r1'), r('r2')] }));
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ reflections: [r('r1')] }));
  const got = await repo.readProject('sailviz-20260901-0900.sailviz.json');
  assert.deepEqual(got.reflections.map((x) => x.id), ['r1']);
  await rm(dataDir, { recursive: true, force: true });
});

test('反省の更新保存は UPSERT: 内容更新・件数不変・rowid 不変・同期削除も効く', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  // reflections.id は器×索引の合成 ID(`${pdId}_r${i}`)。同じ位置の反省は同じ行を更新する。
  const r = (id, text) => ({ id, createdAt: 1, text, people: [], notes: {} });
  const rows = () => db.prepare('SELECT rowid AS n, id, position FROM reflections ORDER BY position').all();
  await repo.writeProject(NAME, baseProj({ reflections: [r('a', 'a'), r('b', 'b')] }));
  await repo.writeProject(NAME, baseProj({ reflections: [r('a', 'a2'), r('b', 'b2')] })); // 既存行あり
  const before = rows();
  await repo.writeProject(NAME, baseProj({ reflections: [r('a', 'a3'), r('b', 'b3'), r('c', 'c3')] }));
  const mid = rows();
  assert.equal(mid.length, 3);
  assert.deepEqual(mid.slice(0, 2).map((x) => x.n), before.map((x) => x.n), '既存行は作り直されない(rowid 不変)');
  assert.deepEqual((await repo.readProject(NAME)).reflections.map((x) => x.text), ['a3', 'b3', 'c3']);
  await repo.writeProject(NAME, baseProj({ reflections: [r('a', 'a4')] })); // 同期削除
  const after = rows();
  assert.equal(after.length, 1);
  assert.equal(after[0].n, before[0].n);
  assert.deepEqual((await repo.readProject(NAME)).reflections.map((x) => x.text), ['a4']);
  await rm(dataDir, { recursive: true, force: true });
});

test('overlay progress/roadmap 往復', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const progress = { r1: { issueStage: 1, goalDone: true, text: { goal: 'g' },
    comments: { goal: [{ text: 'c', ts: 5, url: 'u' }] } } };
  await repo.writeOverlay('progress', progress);
  assert.deepStrictEqual(await repo.readOverlay('progress'), progress);
  const roadmap = { '村瀬 礼': { goal: 'x', milestones: [{ id: 'm', title: 't', done: false, doneAt: null }] } };
  await repo.writeOverlay('roadmap', roadmap);
  assert.deepStrictEqual(await repo.readOverlay('roadmap'), roadmap);
  await rm(dataDir, { recursive: true, force: true });
});

test('deleteProject で器が消える', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj());
  await repo.deleteProject('sailviz-20260901-0900.sailviz.json');
  assert.deepEqual(await repo.listProjects(), []);
  await rm(dataDir, { recursive: true, force: true });
});

test('findProjectByPracticeDate は practiceDate を持つ器だけ JST 日で照合', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const pd = Date.UTC(2026, 8, 3, 1, 0, 0); // JST 2026-09-03
  await repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj({ practiceDate: pd }));
  await repo.writeProject('sailviz-20260902-0900.sailviz.json', baseProj()); // practiceDate 無し
  const found = await repo.findProjectByPracticeDate(pd);
  assert.equal(found.name, 'sailviz-20260901-0900.sailviz.json');
  assert.equal(await repo.findProjectByPracticeDate(Date.UTC(2020, 0, 1)), null);
  await rm(dataDir, { recursive: true, force: true });
});

test('中抜き削除で残トラックの color↔points が崩れない(id 重複でも)', { skip: skipMsg }, async () => {
  // 旧データは全艇 id='Location.csv'。index 一致だと中抜き削除で view と点列がズレる。
  const { repo, dataDir } = await freshRepo();
  const t = (lat, color) => ({ id: 'Location.csv', name: `b${lat}`, color, visible: true,
    points: [{ t: lat, lat, lon: 0, speed: 0 }], bounds: { minLat: lat, maxLat: lat, minLon: 0, maxLon: 0 } });
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  await repo.writeProject(NAME, baseProj({ tracks: [t(0, '#000'), t(1, '#111'), t(2, '#222')] }));
  // 真ん中(lat=1)を削除して PUT(Web の splice 相当)。rule② で残るが、各トラックの色↔点列は保たれること。
  await repo.writeProject(NAME, baseProj({ tracks: [t(0, '#000'), t(2, '#222')] }));
  const got = await repo.readProject(NAME);
  const byLat = new Map(got.tracks.map((tr) => [tr.points[0].lat, tr.color]));
  assert.equal(byLat.get(0), '#000');
  assert.equal(byLat.get(1), '#111', 'lat=1 の色が別トラックの色に化けない');
  assert.equal(byLat.get(2), '#222');
  await rm(dataDir, { recursive: true, force: true });
});

test('トラック並べ替え PUT で points↔view がズレない', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const t = (lat, color) => ({ id: 'Location.csv', name: `b${lat}`, color, visible: true,
    points: [{ t: lat, lat, lon: 0, speed: 0 }], bounds: { minLat: lat, maxLat: lat, minLon: 0, maxLon: 0 } });
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  await repo.writeProject(NAME, baseProj({ tracks: [t(0, '#000'), t(1, '#111')] }));
  await repo.writeProject(NAME, baseProj({ tracks: [t(1, '#111'), t(0, '#000')] })); // 並べ替え
  const got = await repo.readProject(NAME);
  const byLat = new Map(got.tracks.map((tr) => [tr.points[0].lat, tr.color]));
  assert.equal(byLat.get(0), '#000');
  assert.equal(byLat.get(1), '#111');
  await rm(dataDir, { recursive: true, force: true });
});

test('uploads はファイルに委譲(save/read/rename)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  await repo.saveUpload('imp_x', 'raw.csv', 'a,b\n1,2\n');
  assert.equal(await repo.readUpload('imp_x', 'raw.csv'), 'a,b\n1,2\n');
  await repo.renameUpload('imp_x', 'raw.csv', '4321_20260101-0900.csv');
  assert.equal(await repo.readUpload('imp_x', '4321_20260101-0900.csv'), 'a,b\n1,2\n');
  await rm(dataDir, { recursive: true, force: true });
});
