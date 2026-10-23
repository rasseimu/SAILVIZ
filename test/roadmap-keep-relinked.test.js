// test/roadmap-keep-relinked.test.js — 互換 PUT roadmap・取込み再実行が、名簿照合で付け替え済みの
// roadmaps 行(user_id・org_id)を消さないこと(S2.6-P5)。合成データのみ。Node 24 が要る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite が要る(Node >=24)';
let openDb, migrate, loadMigrations, createAccountsRepo, createDbRepo, importFromFiles, syncRoadmaps;
if (!skip) {
  ({ syncRoadmaps } = await import('../server/db/roadmapSync.js'));
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
  ({ createDbRepo } = await import('../server/repos/dbRepo.js'));
  ({ importFromFiles } = await import('../server/db/importFromFiles.js'));
}
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const org = accounts.createOrg({ name: 'テスト部', now: 1 });
  const u = accounts.createUser({ email: 'a@example.test', name: 'A', passwordHash: 'x', now: 1 });
  return { db, accounts, org, userId: u.id };
}
const rows = (db) => db.prepare('SELECT id, user_id, org_id, legacy_name, goal FROM roadmaps ORDER BY legacy_name').all();

test('互換 PUT roadmap: 付け替え済みの行は user_id・org_id・id を保ち、内容だけ更新', { skip }, () => {
  const { db, accounts, org, userId } = setup();
  const repo = createDbRepo({ db, dataDir: '/nonexistent' });
  repo.writeOverlay('roadmap', { 旧A: { goal: 'g1', milestones: [] }, 旧B: { goal: 'b1' } });
  db.prepare('UPDATE roadmaps SET org_id = ? WHERE legacy_name = ?').run(org.id, '旧A');
  accounts.reattachLegacy({ orgId: org.id, userId, legacyName: '旧A' });
  const before = rows(db).find((r) => r.legacy_name === '旧A');
  assert.equal(before.user_id, userId);

  repo.writeOverlay('roadmap', { 旧A: { goal: 'g2', milestones: [{ t: 1 }] }, 旧B: { goal: 'b2' } });
  const after = rows(db);
  const a = after.find((r) => r.legacy_name === '旧A');
  assert.equal(a.user_id, userId);
  assert.equal(a.org_id, org.id);
  assert.equal(a.id, before.id);
  assert.equal(a.goal, 'g2');
  assert.equal(after.length, 2);
  assert.equal(new Set(after.map((r) => r.id)).size, 2);
  assert.deepEqual(repo.readOverlay('roadmap')['旧A'], { goal: 'g2', milestones: [{ t: 1 }] });
});

test('互換 PUT roadmap: incoming に無い未付け替え行は消える(従来どおり)・付け替え済みは残る', { skip }, () => {
  const { db, accounts, org, userId } = setup();
  const repo = createDbRepo({ db, dataDir: '/nonexistent' });
  repo.writeOverlay('roadmap', { 旧A: { goal: 'g1' }, 旧B: { goal: 'b1' } });
  db.prepare('UPDATE roadmaps SET org_id = ?').run(org.id);
  accounts.reattachLegacy({ orgId: org.id, userId, legacyName: '旧A' });
  repo.writeOverlay('roadmap', {});
  const after = rows(db);
  assert.deepEqual(after.map((r) => r.legacy_name), ['旧A']);
  assert.equal(after[0].user_id, userId);
});

test('取込み再実行: 付け替え済みの roadmaps 行を保ち、未設定の org_id だけ補う', { skip }, async () => {
  const { db, accounts, org, userId } = setup();
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-keep-'));
  await mkdir(join(dataDir, 'projects'), { recursive: true });
  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({ 旧A: { goal: 'g1' }, 旧B: { goal: 'b1' } }));
  importFromFiles({ db, dataDir, orgId: org.id });
  accounts.reattachLegacy({ orgId: org.id, userId, legacyName: '旧A' });
  const before = rows(db).find((r) => r.legacy_name === '旧A');

  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({ 旧A: { goal: 'g2' }, 旧B: { goal: 'b2' } }));
  importFromFiles({ db, dataDir, orgId: org.id, forceReimport: true });
  const after = rows(db);
  const a = after.find((r) => r.legacy_name === '旧A');
  assert.equal(a.user_id, userId);
  assert.equal(a.org_id, org.id);
  assert.equal(a.id, before.id);
  assert.equal(a.goal, 'g2');
  assert.equal(after.length, 2);
});

test('互換 PUT(org_id NULL)→ 取込み: org_id が補われる・別組織の org_id は上書きしない', { skip }, async () => {
  const { db, accounts, org } = setup();
  const other = accounts.createOrg({ name: '別部', now: 2 });
  const repo = createDbRepo({ db, dataDir: '/nonexistent' });
  repo.writeOverlay('roadmap', { 旧A: { goal: 'g1' }, 旧B: { goal: 'b1' } });
  assert.deepEqual(rows(db).map((r) => r.org_id), [null, null]);
  db.prepare('UPDATE roadmaps SET org_id = ? WHERE legacy_name = ?').run(other.id, '旧B');
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-keep-'));
  await mkdir(join(dataDir, 'projects'), { recursive: true });
  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({ 旧A: { goal: 'g2' }, 旧B: { goal: 'b2' } }));
  importFromFiles({ db, dataDir, orgId: org.id });
  const after = rows(db);
  assert.equal(after.find((r) => r.legacy_name === '旧A').org_id, org.id);
  assert.equal(after.find((r) => r.legacy_name === '旧B').org_id, other.id);
  assert.equal(after.find((r) => r.legacy_name === '旧B').goal, 'b2');
});

test('syncRoadmaps: 新規行の id が既存行と衝突したら別 id を振る(既存行は壊れない)', { skip }, () => {
  const { db } = setup();
  syncRoadmaps(db, [{ id: 'rm_legacy_0', legacy_name: '旧A', goal: 'a' }]);
  syncRoadmaps(db, [
    { id: 'rm_legacy_0', legacy_name: '旧A', goal: 'a2' },
    { id: 'rm_legacy_0', legacy_name: '旧B', goal: 'b' },
  ]);
  const after = rows(db);
  assert.equal(after.length, 2);
  assert.equal(new Set(after.map((r) => r.id)).size, 2);
  const a = after.find((r) => r.legacy_name === '旧A');
  assert.equal(a.id, 'rm_legacy_0');
  assert.equal(a.goal, 'a2');
  assert.notEqual(after.find((r) => r.legacy_name === '旧B').id, 'rm_legacy_0');
});

test('取込み 2 回目(forceReimport): roadmaps の行数・id・内容が変わらない', { skip }, async () => {
  const { db, org } = setup();
  const dataDir = await mkdtemp(join(tmpdir(), 'sailviz-keep-'));
  await mkdir(join(dataDir, 'projects'), { recursive: true });
  await writeFile(join(dataDir, 'roadmap.json'), JSON.stringify({
    旧A: { goal: 'g1', milestones: [{ t: 1 }], memo: 'x' }, 旧B: { goal: 'b1' },
  }));
  const dump = () => db.prepare('SELECT id, user_id, org_id, legacy_name, goal, milestones, extra FROM roadmaps ORDER BY legacy_name').all();
  importFromFiles({ db, dataDir, orgId: org.id, now: 100 });
  const first = dump();
  importFromFiles({ db, dataDir, orgId: org.id, now: 100, forceReimport: true });
  assert.deepEqual(dump(), first);
  assert.equal(first.length, 2);
});

test('syncRoadmaps: scopeOrgId なしは今と同じ(組織をまたいで legacy_name で突き合わせ・削除)', { skip }, () => {
  const { db, accounts, org } = setup();
  const other = accounts.createOrg({ name: '別部', now: 2 });
  syncRoadmaps(db, [{ id: 'rm_legacy_0', legacy_name: '旧A', goal: 'a', org_id: org.id },
    { id: 'rm_legacy_1', legacy_name: '旧B', goal: 'b', org_id: other.id }]);
  // scopeOrgId なし: 組織を問わず 旧A を更新し、入力に無い 旧B(別組織)も消す
  syncRoadmaps(db, [{ id: 'rm_legacy_0', legacy_name: '旧A', goal: 'a2', org_id: other.id }]);
  const after = rows(db);
  assert.deepEqual(after.map((r) => [r.legacy_name, r.org_id, r.goal]), [['旧A', org.id, 'a2']]);
});

test('syncRoadmaps: scopeOrgId ありは、その組織の行だけを突き合わせ・削除する(付け替え済みは残す)', { skip }, () => {
  const { db, accounts, org, userId } = setup();
  const other = accounts.createOrg({ name: '別部', now: 2 });
  syncRoadmaps(db, [{ id: 'rm_legacy_0', legacy_name: '__team__', goal: 'A', org_id: org.id },
    { id: 'rm_legacy_1', legacy_name: '旧A', goal: 'a', org_id: org.id }]);
  syncRoadmaps(db, [{ id: 'rm_legacy_0', legacy_name: '__team__', goal: 'B', org_id: other.id },
    { id: 'rm_legacy_1', legacy_name: '旧B', goal: 'b', org_id: other.id }], { scopeOrgId: other.id });
  assert.equal(rows(db).length, 4, '別組織の同名 __team__ は別の行になる');
  accounts.reattachLegacy({ orgId: org.id, userId, legacyName: '旧A' });
  // org の全置き換え(空): 未付け替えの __team__ は消え、付け替え済みの 旧A と other の行は残る
  syncRoadmaps(db, [], { scopeOrgId: org.id });
  const after = rows(db);
  assert.deepEqual(after.map((r) => [r.legacy_name, r.org_id, r.goal]).sort(),
    [['__team__', other.id, 'B'], ['旧A', org.id, 'a'], ['旧B', other.id, 'b']].sort());
  assert.equal(after.find((r) => r.legacy_name === '旧A').user_id, userId);
});
