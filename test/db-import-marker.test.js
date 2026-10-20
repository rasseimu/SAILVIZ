// test/db-import-marker.test.js
// 取込み済みの印(meta.import_completed)・再実行の拒否・--force-reimport・org_id 修正手順(S2.6-P8)。
// 合成データのみ。node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'server', 'db', 'migrations');

let openDb, migrate, loadMigrations, importFromFiles, readImportMarker, fixLegacyOrgId, countReimportLoss;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ importFromFiles, readImportMarker, fixLegacyOrgId, countReimportLoss } = await import('../server/db/importFromFiles.js'));
}

async function fixture({ file = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-marker-'));
  await mkdir(join(dataDir, 'projects'), { recursive: true });
  const proj = JSON.stringify({ version: 3, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 },
    tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [{ id: 'reflA', createdAt: 1, text: 'a', people: [], notes: {} }] });
  await writeFile(join(dataDir, 'projects', 'sailviz-20260901-0900.sailviz.json'), proj);
  await writeFile(join(dataDir, 'progress.json'), JSON.stringify({
    reflA: { issueStage: 1, goalDone: false, text: { goal: 'g' }, comments: { goal: [{ text: 'c', ts: 5 }] } },
  }));
  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({ 'テスト太郎': { goal: 'x', milestones: [] } }));
  const db = openDb(file ? join(dataDir, 'sailviz.db') : ':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_t', 'T', 1)").run();
  return { dataDir, db };
}
const cleanup = (dataDir) => rm(dataDir, { recursive: true, force: true });

test('印なしで取込む → 印(完了時刻・orgId)が書かれる。dry-run では書かれない', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  assert.equal(readImportMarker(db), null);
  importFromFiles({ db, dataDir, dryRun: true, now: 5, orgId: 'org_t' });
  assert.equal(readImportMarker(db), null);
  importFromFiles({ db, dataDir, now: 42, orgId: 'org_t' });
  assert.deepEqual(readImportMarker(db), { at: 42, orgId: 'org_t' });
  db.close();
  await cleanup(dataDir);
});

test('印ありで再実行 → 明示エラー、DB は変わらない', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 42, orgId: 'org_t' });
  db.prepare('UPDATE reflection_progress SET issue_stage = 9').run();
  assert.throws(() => importFromFiles({ db, dataDir, now: 50, orgId: 'org_t' }), (e) => e.code === 'IMPORT_ALREADY_DONE');
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('SELECT issue_stage s FROM reflection_progress').get().s, 9);
  assert.deepEqual(readImportMarker(db), { at: 42, orgId: 'org_t' });
  // dry-run は書かないので印があっても通る
  assert.doesNotThrow(() => importFromFiles({ db, dataDir, dryRun: true }));
  db.close();
  await cleanup(dataDir);
});

test('ガードは「アカウントがあるか」でなく「印があるか」: users がいても最初の取込みは通る', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.test', 1)").run();
  assert.doesNotThrow(() => importFromFiles({ db, dataDir, now: 1, orgId: 'org_t' }));
  db.close();
  await cleanup(dataDir);
});

test('forceReimport → 消える件数を返し、取込みが進み、印が更新される', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 42, orgId: 'org_t' });
  assert.deepEqual(countReimportLoss(db, { dataDir }), {
    practiceDays: 1, recSessions: 0, tracks: 0, reflections: 1, progress: 1, comments: 1, roadmapsOverwritten: 1, roadmapsDeleted: 0,
  });
  db.prepare('UPDATE reflection_progress SET issue_stage = 9').run();
  const report = importFromFiles({ db, dataDir, now: 99, orgId: 'org_t', forceReimport: true });
  assert.equal(report.projects, 1);
  assert.equal(db.prepare('SELECT issue_stage s FROM reflection_progress').get().s, 1);
  assert.deepEqual(readImportMarker(db), { at: 99, orgId: 'org_t' });
  db.close();
  await cleanup(dataDir);
});

test('fixLegacyOrgId: org_id NULL かつ legacy_name ありの行だけ更新する', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_other', 'O', 1)").run();
  importFromFiles({ db, dataDir, now: 42 }); // orgId なしで取込む → org_id NULL
  db.prepare("INSERT INTO practice_days (id, org_id, date, legacy_name, rev) VALUES ('pd_o', 'org_other', '2026-09-02', 'o.sailviz.json', 0)").run();
  db.prepare("INSERT INTO practice_days (id, org_id, date, legacy_name, rev) VALUES ('pd_n', NULL, '2026-09-03', NULL, 0)").run();
  db.prepare("INSERT INTO roadmaps (id, org_id, legacy_name) VALUES ('rm_o', 'org_other', 'other')").run();
  db.prepare("INSERT INTO roadmaps (id, org_id, legacy_name) VALUES ('rm_n', NULL, NULL)").run();

  const r = fixLegacyOrgId({ db, orgId: 'org_t', now: 7 });
  assert.deepEqual(r, { practiceDays: 1, roadmaps: 1, warnings: [] });
  const org = (t, id) => db.prepare(`SELECT org_id o FROM ${t} WHERE id = ?`).get(id).o;
  assert.equal(db.prepare("SELECT org_id o FROM practice_days WHERE legacy_name = 'sailviz-20260901-0900.sailviz.json'").get().o, 'org_t');
  assert.equal(db.prepare("SELECT org_id o FROM roadmaps WHERE legacy_name = 'テスト太郎'").get().o, 'org_t');
  assert.equal(org('practice_days', 'pd_o'), 'org_other');
  assert.equal(org('practice_days', 'pd_n'), null);
  assert.equal(org('roadmaps', 'rm_o'), 'org_other');
  assert.equal(org('roadmaps', 'rm_n'), null);
  assert.deepEqual(readImportMarker(db), { at: 42, orgId: 'org_t' }, '印の orgId も直す');
  assert.equal(db.prepare("SELECT updated_at u FROM meta WHERE key = 'import_completed'").get().u, 7, 'now を印の更新時刻に使う');
  // 再実行はしない(行数は変わらない)
  assert.equal(db.prepare('SELECT count(*) c FROM practice_days').get().c, 3);
  db.close();
  await cleanup(dataDir);
});

test('fixLegacyOrgId: 存在しない組織は拒否し何も変えない', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 42 });
  assert.throws(() => fixLegacyOrgId({ db, orgId: 'org_nope' }), /存在しません/);
  assert.equal(db.prepare('SELECT count(*) c FROM practice_days WHERE org_id IS NULL').get().c, 1);
  db.close();
  await cleanup(dataDir);
});

test('CLI: 印ありの再実行は終了コード 1、--force-reimport は件数を出して進む、--fix-org-id で修正', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture({ file: true });
  db.close();
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'server/db/importFromFiles.js'), dataDir, ...args],
    { encoding: 'utf8', env: { ...process.env, MIGRATION_ORG_ID: 'org_t' } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const again = run();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /取込み済み/);
  const forced = run('--force-reimport');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /消える件数/);
  assert.match(forced.stdout, /"practiceDays":1/);
  const fix = run('--fix-org-id');
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.stdout, /fix-org-id/);
  await cleanup(dataDir);
});

test('countReimportLoss: 実際に消える・上書きされる行だけ数える(DB 作成の行は数えない)', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 42, orgId: 'org_t' });
  const pdId = db.prepare('SELECT id FROM practice_days').get().id;
  db.prepare("INSERT INTO rec_sessions (id, kind, practice_day_id, visibility) VALUES ('s1', 'practice', ?, 'org')").run(pdId);
  db.prepare("INSERT INTO tracks (session_id, points) VALUES ('s1', '[]')").run();
  // DB で作った練習日(legacy_name なし)とその下の子は消えない
  db.prepare("INSERT INTO practice_days (id, org_id, date, legacy_name, rev) VALUES ('pd_db', 'org_t', '2026-09-05', NULL, 0)").run();
  db.prepare("INSERT INTO rec_sessions (id, kind, practice_day_id, visibility) VALUES ('s2', 'practice', 'pd_db', 'org')").run();
  db.prepare("INSERT INTO reflections (id, practice_day_id, visibility) VALUES ('r_db', 'pd_db', 'org')").run();
  // 入力に無い legacy_name の練習日も消えない
  db.prepare("INSERT INTO practice_days (id, org_id, date, legacy_name, rev) VALUES ('pd_x', 'org_t', '2026-09-06', 'x.sailviz.json', 0)").run();
  // ロードマップ: 付け替え済み(user_id あり・入力に無い)は消えない、未付け替え・入力に無いものは消える
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.test', 1)").run();
  db.prepare("INSERT INTO roadmaps (id, user_id, org_id, legacy_name) VALUES ('rm_u', 'u1', 'org_t', 'アリス')").run();
  db.prepare("INSERT INTO roadmaps (id, user_id, org_id, legacy_name) VALUES ('rm_gone', NULL, 'org_t', '消える人')").run();
  assert.deepEqual(countReimportLoss(db, { dataDir }), {
    practiceDays: 1, recSessions: 1, tracks: 1, reflections: 1, progress: 1, comments: 1, roadmapsOverwritten: 1, roadmapsDeleted: 1,
  });
  // progress.json が無ければ progress/comments は消えない
  await rm(join(dataDir, 'progress.json'));
  const c = countReimportLoss(db, { dataDir });
  assert.equal(c.progress, 0);
  assert.equal(c.comments, 0);
  db.close();
  await cleanup(dataDir);
});

test('fixLegacyOrgId: dryRun は件数だけ返し書かない', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  importFromFiles({ db, dataDir, now: 42 });
  const r = fixLegacyOrgId({ db, orgId: 'org_t', dryRun: true });
  assert.equal(r.practiceDays, 1);
  assert.equal(r.roadmaps, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM practice_days WHERE org_id IS NULL').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM roadmaps WHERE org_id IS NULL').get().c, 1);
  assert.deepEqual(readImportMarker(db), { at: 42, orgId: null });
  db.close();
  await cleanup(dataDir);
});

test('fixLegacyOrgId: 印の orgId が別組織なら印は書き換えず警告(行は直す)', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture();
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org_b', 'B', 1)").run();
  importFromFiles({ db, dataDir, now: 42, orgId: 'org_t' });
  db.prepare('UPDATE practice_days SET org_id = NULL').run();
  const r = fixLegacyOrgId({ db, orgId: 'org_b', now: 7 });
  assert.equal(r.practiceDays, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /org_t/);
  assert.deepEqual(readImportMarker(db), { at: 42, orgId: 'org_t' });
  db.close();
  await cleanup(dataDir);
});

test('CLI: --fix-org-id --dry-run は書かない / --fix-org-id と --force-reimport の同時指定は終了コード 1', { skip: skipMsg }, async () => {
  const { dataDir, db } = await fixture({ file: true });
  db.close();
  const run = (env, ...args) => spawnSync(process.execPath, [join(ROOT, 'server/db/importFromFiles.js'), dataDir, ...args],
    { encoding: 'utf8', env: { ...process.env, MIGRATION_ORG_ID: '', ...env } });
  assert.equal(run({}).status, 0); // MIGRATION_ORG_ID なし → org_id NULL で取込む
  const dry = run({ MIGRATION_ORG_ID: 'org_t' }, '--fix-org-id', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  const both = run({ MIGRATION_ORG_ID: 'org_t' }, '--fix-org-id', '--force-reimport');
  assert.equal(both.status, 1);
  const chk = openDb(join(dataDir, 'sailviz.db'));
  assert.equal(chk.prepare('SELECT count(*) c FROM practice_days WHERE org_id IS NULL').get().c, 1);
  chk.close();
  const real = run({ MIGRATION_ORG_ID: 'org_t' }, '--fix-org-id');
  assert.equal(real.status, 0, real.stderr);
  const chk2 = openDb(join(dataDir, 'sailviz.db'));
  assert.equal(chk2.prepare('SELECT count(*) c FROM practice_days WHERE org_id IS NULL').get().c, 0);
  chk2.close();
  await cleanup(dataDir);
});
