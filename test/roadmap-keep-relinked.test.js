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
let openDb, migrate, loadMigrations, createAccountsRepo, createDbRepo, importFromFiles;
if (!skip) {
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
  importFromFiles({ db, dataDir, orgId: org.id });
  const after = rows(db);
  const a = after.find((r) => r.legacy_name === '旧A');
  assert.equal(a.user_id, userId);
  assert.equal(a.org_id, org.id);
  assert.equal(a.id, before.id);
  assert.equal(a.goal, 'g2');
  assert.equal(after.length, 2);
});
