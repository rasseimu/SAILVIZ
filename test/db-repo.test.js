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
  const id = (await repo.createProject(proj, { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  const got = await repo.readProject(id);
  assert.equal(got._rev, 1);
  const { _rev, ...pure } = got;
  assert.deepStrictEqual(pure, proj);
  await rm(dataDir, { recursive: true, force: true });
});

test('listProjects が書いた器を返す(降順)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  await repo.createProject(baseProj(), { name: 'sailviz-20260901-0900.sailviz.json' });
  await repo.createProject(baseProj(), { name: 'sailviz-20260902-0900.sailviz.json' });
  assert.deepEqual((await repo.listProjects()).map((p) => p.name), ['sailviz-20260902-0900.sailviz.json', 'sailviz-20260901-0900.sailviz.json']);
  await rm(dataDir, { recursive: true, force: true });
});

test('削除ルール②: _rev 無し PUT で既存トラックを消さない(新しく届いた軌跡が残る)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  // 初期2トラック
  const id = (await repo.createProject(baseProj({ tracks: [track('t1'), track('t2')] }), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  // クライアントが t2 を含まない JSON を _rev 無しで PUT
  await repo.writeProject(id, baseProj({ tracks: [track('t1')] }));
  const got = await repo.readProject(id);
  const ids = got.tracks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't2'], 't2 は消えない');
  await rm(dataDir, { recursive: true, force: true });
});

test('削除ルール③: 表示設定の編集は in-place 更新(複製せず点列も保持)', { skip: skipMsg }, async () => {
  // Web は GPS 点列を編集しない。同じ点列で view(visible/name)だけ変えて保存する。
  // トラックは点列の指紋で同定され、既存行を上書き更新する(複製しない・点列列は触らない)。
  const { repo, dataDir } = await freshRepo();
  const id = (await repo.createProject(baseProj({ tracks: [track('t1')] }), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  const edited = { ...track('t1'), visible: false, name: 'renamed' }; // 点列は同じ
  await repo.writeProject(id, baseProj({ tracks: [edited] }));
  const got = await repo.readProject(id);
  assert.equal(got.tracks.length, 1, '複製されない(in-place 更新)');
  const t = got.tracks[0];
  assert.equal(t.visible, false, '表示設定は反映');
  assert.equal(t.name, 'renamed');
  assert.deepStrictEqual(t.points, [{ t: 1, lat: 35, lon: 139, speed: 1 }], '点列は保持');
  await rm(dataDir, { recursive: true, force: true });
});

test('新規トラックは追加される(点列込み)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const id = (await repo.createProject(baseProj({ tracks: [track('t1')] }), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  await repo.writeProject(id, baseProj({ tracks: [track('t1'), track('t2')] }));
  const got = await repo.readProject(id);
  assert.deepEqual(got.tracks.map((t) => t.id).sort(), ['t1', 't2']);
  await rm(dataDir, { recursive: true, force: true });
});

test('反省は入れ替わる(Web の編集を尊重: 消したものは消える)', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const r = (id) => ({ id, createdAt: 1, text: id, people: [], notes: {} });
  const id = (await repo.createProject(baseProj({ reflections: [r('r1'), r('r2')] }), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  await repo.writeProject(id, baseProj({ reflections: [r('r1')] }));
  const got = await repo.readProject(id);
  assert.deepEqual(got.reflections.map((x) => x.id), ['r1']);
  await rm(dataDir, { recursive: true, force: true });
});

test('反省の更新保存は UPSERT: 内容更新・件数不変・rowid 不変・同期削除も効く', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  // reflections.id は器×索引の合成 ID(`${pdId}_r${i}`)。同じ位置の反省は同じ行を更新する。
  const r = (id, text) => ({ id, createdAt: 1, text, people: [], notes: {} });
  const rows = () => db.prepare('SELECT rowid AS n, id, position FROM reflections ORDER BY position').all();
  const id = (await repo.createProject(baseProj({ reflections: [r('a', 'a'), r('b', 'b')] }), { name: NAME })).id;
  await repo.writeProject(id, baseProj({ reflections: [r('a', 'a2'), r('b', 'b2')] })); // 既存行あり
  const before = rows();
  await repo.writeProject(id, baseProj({ reflections: [r('a', 'a3'), r('b', 'b3'), r('c', 'c3')] }));
  const mid = rows();
  assert.equal(mid.length, 3);
  assert.deepEqual(mid.slice(0, 2).map((x) => x.n), before.map((x) => x.n), '既存行は作り直されない(rowid 不変)');
  assert.deepEqual((await repo.readProject(id)).reflections.map((x) => x.text), ['a3', 'b3', 'c3']);
  await repo.writeProject(id, baseProj({ reflections: [r('a', 'a4')] })); // 同期削除
  const after = rows();
  assert.equal(after.length, 1);
  assert.equal(after[0].n, before[0].n);
  assert.deepEqual((await repo.readProject(id)).reflections.map((x) => x.text), ['a4']);
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
  const id = (await repo.createProject(baseProj(), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  await repo.deleteProject(id);
  assert.deepEqual(await repo.listProjects(), []);
  await rm(dataDir, { recursive: true, force: true });
});

test('findProjectByPracticeDate は practiceDate を持つ器だけ JST 日で照合', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const pd = Date.UTC(2026, 8, 3, 1, 0, 0); // JST 2026-09-03
  const id = (await repo.createProject(baseProj({ practiceDate: pd }), { name: 'sailviz-20260901-0900.sailviz.json' })).id;
  await repo.createProject(baseProj(), { name: 'sailviz-20260902-0900.sailviz.json' }); // practiceDate 無し
  const found = await repo.findProjectByPracticeDate(pd);
  assert.equal(found.name, 'sailviz-20260901-0900.sailviz.json');
  assert.equal(found.id, id);
  assert.equal(await repo.findProjectByPracticeDate(Date.UTC(2020, 0, 1)), null);
  await rm(dataDir, { recursive: true, force: true });
});

test('中抜き削除で残トラックの color↔points が崩れない(id 重複でも)', { skip: skipMsg }, async () => {
  // 旧データは全艇 id='Location.csv'。index 一致だと中抜き削除で view と点列がズレる。
  const { repo, dataDir } = await freshRepo();
  const t = (lat, color) => ({ id: 'Location.csv', name: `b${lat}`, color, visible: true,
    points: [{ t: lat, lat, lon: 0, speed: 0 }], bounds: { minLat: lat, maxLat: lat, minLon: 0, maxLon: 0 } });
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  const id = (await repo.createProject(baseProj({ tracks: [t(0, '#000'), t(1, '#111'), t(2, '#222')] }), { name: NAME })).id;
  // 真ん中(lat=1)を削除して PUT(Web の splice 相当)。rule② で残るが、各トラックの色↔点列は保たれること。
  await repo.writeProject(id, baseProj({ tracks: [t(0, '#000'), t(2, '#222')] }));
  const got = await repo.readProject(id);
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
  const id = (await repo.createProject(baseProj({ tracks: [t(0, '#000'), t(1, '#111')] }), { name: NAME })).id;
  await repo.writeProject(id, baseProj({ tracks: [t(1, '#111'), t(0, '#000')] })); // 並べ替え
  const got = await repo.readProject(id);
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

// --- 練習を ID で引く(設計書 §5.5.1)---

test('listProjects は id・name・label を返す', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  const { id, name } = await repo.createProject(baseProj(), { name: NAME });
  assert.match(id, /^pd_[0-9a-f]{10}$/);
  assert.equal(name, NAME);
  const list = await repo.listProjects();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'label', 'name']);
  assert.equal(list[0].id, id);
  assert.equal(list[0].name, NAME);
  assert.equal(typeof list[0].label, 'string');
  await rm(dataDir, { recursive: true, force: true });
});

test('同じ名前の器を 2 つ作れて、ID で別々に読める', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  const a = await repo.createProject(baseProj({ marks: [{ id: 'mA' }] }), { name: NAME });
  const b = await repo.createProject(baseProj({ marks: [{ id: 'mB' }] }), { name: NAME });
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await repo.readProject(a.id)).marks, [{ id: 'mA' }]);
  assert.deepEqual((await repo.readProject(b.id)).marks, [{ id: 'mB' }]);
  // 片方を書き換えても他方は変わらない
  await repo.writeProject(a.id, baseProj({ marks: [{ id: 'mA2' }] }));
  assert.deepEqual((await repo.readProject(b.id)).marks, [{ id: 'mB' }]);
  // 並びは名前の降順、同名なら id 順
  const list = await repo.listProjects();
  assert.deepEqual(list.map((p) => p.id), [a.id, b.id].sort());
  assert.ok(list.every((p) => p.name === NAME));
  // 片方を消しても他方は残る
  await repo.deleteProject(a.id);
  assert.deepEqual((await repo.listProjects()).map((p) => p.id), [b.id]);
  await rm(dataDir, { recursive: true, force: true });
});

test('writeProject は無い ID で not_found を投げる', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  assert.throws(() => repo.writeProject('pd_0000000000', baseProj()), (e) => e.code === 'not_found');
  // 名前を渡しても新しい器は作らない
  assert.throws(() => repo.writeProject('sailviz-20260901-0900.sailviz.json', baseProj()), (e) => e.code === 'not_found');
  assert.deepEqual(await repo.listProjects(), []);
  assert.throws(() => repo.readProject('pd_0000000000'));
  assert.equal(repo.getProjectAccess('pd_0000000000'), null);
  await rm(dataDir, { recursive: true, force: true });
});

test('createProject は orgId の器を作り id を返す', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_a', 'A', 1)").run();
  const NAME = 'sailviz-20260901-0900.sailviz.json';
  const { id, name } = await repo.createProject(baseProj(), { name: NAME, orgId: 'org_a' });
  assert.equal(name, NAME);
  const row = db.prepare('SELECT org_id, legacy_name, rev FROM practice_days WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { org_id: 'org_a', legacy_name: NAME, rev: 1 });
  assert.equal(repo.getProjectAccess(id).orgId, 'org_a');
  assert.equal(repo.readProjectWithAccess(id).access.orgId, 'org_a');
  await rm(dataDir, { recursive: true, force: true });
});

test('findProjectsByPracticeDate は id を返す', { skip: skipMsg }, async () => {
  const { repo, dataDir } = await freshRepo();
  const pd = Date.UTC(2026, 8, 3, 1, 0, 0); // JST 2026-09-03
  const NAME = 'sailviz-20260903-0900.sailviz.json';
  const a = await repo.createProject(baseProj({ practiceDate: pd }), { name: NAME });
  const b = await repo.createProject(baseProj({ practiceDate: pd }), { name: NAME });
  await repo.createProject(baseProj(), { name: 'sailviz-20260904-0900.sailviz.json' });
  const found = repo.findProjectsByPracticeDate(pd);
  assert.deepEqual(found.map((x) => x.id), [a.id, b.id].sort());
  assert.ok(found.every((x) => x.name === NAME && typeof x.label === 'string'));
  // 反省の著者で引くものも id を返す
  const refl = baseProj({ practiceDate: pd, reflections: [{ id: 'r1', createdAt: 1, text: 'x', people: ['テスト 太郎'], notes: {} }] });
  const c = await repo.createProject(refl, { name: 'sailviz-20260903-1000.sailviz.json' });
  assert.equal(repo.findReflectionByDate('テスト 太郎', pd).id, c.id);
  assert.deepEqual(repo.findReflectionsByDate('テスト 太郎', pd).map((x) => x.id), [c.id]);
  await rm(dataDir, { recursive: true, force: true });
});

// --- ロードマップを組織の中で同期する(設計書 §5.6)---

test('roadmap: 2 組織の __team__ は別々に保存され、片方の PUT で他方が変わらない', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_a', 'A', 1), ('org_b', 'B', 1)").run();
  const A = 'org_a'; const B = 'org_b';
  repo.writeOverlay('roadmap', { __team__: { goal: 'A の目標' }, 甲: { goal: 'a1' } }, { orgId: A, scopeOrgId: A });
  repo.writeOverlay('roadmap', { __team__: { goal: 'B の目標' }, 乙: { goal: 'b1' } }, { orgId: B, scopeOrgId: B });
  const bBefore = repo.readOverlay('roadmap', { orgId: B });
  assert.deepEqual(bBefore, { __team__: { goal: 'B の目標' }, 乙: { goal: 'b1' } });
  assert.deepEqual(repo.readOverlay('roadmap', { orgId: A }), { __team__: { goal: 'A の目標' }, 甲: { goal: 'a1' } });
  assert.equal(db.prepare("SELECT count(*) c FROM roadmaps WHERE legacy_name = '__team__'").get().c, 2);
  // A の全置き換え(甲を消し、__team__ を更新)は B の行に触らない
  repo.writeOverlay('roadmap', { __team__: { goal: 'A の目標2' } }, { orgId: A, scopeOrgId: A });
  assert.deepEqual(repo.readOverlay('roadmap', { orgId: A }), { __team__: { goal: 'A の目標2' } });
  assert.deepEqual(repo.readOverlay('roadmap', { orgId: B }), bBefore);
  // 認可用の一覧も同じ絞り込み
  assert.deepEqual(repo.listRoadmapAccess({ orgId: B }).map((r) => [r.legacyName, r.orgId]).sort(),
    [['__team__', B], ['乙', B]]);
  assert.equal(repo.listRoadmapAccess().length, 3);
  await rm(dataDir, { recursive: true, force: true });
});

test('getProjectAccess は軌跡の点列を読まずに、全体を読んだときと同じ access を返す', { skip: skipMsg }, async () => {
  const { db, dataDir } = await freshRepo();
  // prepare に渡る SQL を記録する(点列 = tracks.points を読む SQL が出ないことを確かめる)
  const sqls = [];
  const spy = new Proxy(db, { get: (t, k) => (k === 'prepare' ? (sql) => { sqls.push(sql); return t.prepare(sql); } : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
  const repo = createDbRepo({ db: spy, dataDir });
  try {
    const { id } = await repo.createProject(baseProj({ tracks: [track('b'), track('a')], reflections: [{ id: 'r1' }, { id: 'r2' }] }), { name: 'sailviz-20260101-0900.sailviz.json', orgId: 'org_a' });
    db.prepare("UPDATE reflections SET visibility = 'private', author_user_id = 'u_1' WHERE body LIKE '%\"r2\"%'").run();
    const full = repo.readProjectWithAccess(id).access;
    sqls.length = 0;
    const access = repo.getProjectAccess(id);
    assert.deepEqual(access, full);
    assert.equal(access.tracks.length, 2);
    assert.deepEqual(access.reflections.map((r) => r.visibility), ['org', 'private']);
    const trackSql = sqls.filter((s) => /FROM tracks/.test(s));
    assert.ok(trackSql.length > 0);
    assert.ok(trackSql.every((s) => !/SELECT \*/.test(s) && !/points/.test(s)), trackSql.join('\n'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('appendVideos は name + t が未登録の動画だけ足し、足したときだけ rev・updated_at を上げる(saved_at・反省・軌跡は不変)', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  try {
    const { id } = repo.createProject(baseProj({
      tracks: [track('a')], reflections: [{ id: 'r1', notes: { goal: 'x' } }], savedAt: '2026-01-01T00:00:00.000Z',
      videos: [{ id: 'vid0', t: 100, name: 'a.mp4', durationMs: null }],
    }), { name: 'sailviz-20260101-0900.sailviz.json' });
    const pd0 = db.prepare('SELECT rev, saved_at, updated_at FROM practice_days WHERE id = ?').get(id);
    const before = repo.readProject(id);
    const res = repo.appendVideos(id, [
      { id: 'vid0', t: 100.4, name: 'a.mp4', durationMs: null }, // 同じ動画(t の丸めで一致)
      { id: 'vid0', t: 200, name: 'a.mp4', durationMs: 1000 },   // 同名・別時刻
    ]);
    assert.equal(res.added, 1);
    assert.deepEqual(res.videos.map((v) => [v.id, v.t]), [['vid0', 100], ['vid1', 200]]);
    assert.deepEqual(repo.readVideos(id), res.videos);
    const pd1 = db.prepare('SELECT rev, saved_at, updated_at FROM practice_days WHERE id = ?').get(id);
    assert.equal(pd1.rev, pd0.rev + 1);
    assert.equal(pd1.saved_at, pd0.saved_at);
    assert.ok(pd1.updated_at >= pd0.updated_at);
    const after = repo.readProject(id);
    assert.deepEqual(after.tracks, before.tracks);
    assert.deepEqual(after.reflections, before.reflections);
    assert.deepEqual(after.videos, res.videos);

    const none = repo.appendVideos(id, [{ t: 200, name: 'a.mp4' }]);
    assert.equal(none.added, 0);
    assert.equal(db.prepare('SELECT rev FROM practice_days WHERE id = ?').get(id).rev, pd1.rev);
  } finally { db.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('appendVideos / readVideos は無い ID で not_found を投げ、トランザクションを残さない', { skip: skipMsg }, async () => {
  const { repo, db, dataDir } = await freshRepo();
  try {
    assert.throws(() => repo.appendVideos('pd_0000000000', [{ t: 1, name: 'a.mp4' }]), (e) => e.code === 'not_found');
    assert.throws(() => repo.readVideos('pd_0000000000'), (e) => e.code === 'not_found');
    // 次のトランザクションが始められる(ROLLBACK 済み)
    const { id } = repo.createProject(baseProj(), { name: 'sailviz-20260102-0900.sailviz.json' });
    assert.deepEqual(repo.readVideos(id), []);
    assert.equal(repo.appendVideos(id, [{ t: 1, name: 'a.mp4' }]).added, 1);
  } finally { db.close(); await rm(dataDir, { recursive: true, force: true }); }
});
