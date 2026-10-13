// test/roster-link.test.js — 名簿照合・legacy_* の付け替え・解除(設計書 v2 §4.4)。合成データのみ。Node 24 が要る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite の isTransaction が要る(Node >=24)';
let openDb, migrate, loadMigrations, createAccountsRepo, linkVerifiedUser, applyRoster;
if (!skip) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
  ({ linkVerifiedUser, applyRoster } = await import('../server/rosterLink.js'));
}
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const org = accounts.createOrg({ name: 'テスト部', now: 1 });
  const user = (email, { verified = true, name = email } = {}) => {
    const u = accounts.createUser({ email, name, passwordHash: 'x', now: 1 });
    if (verified) accounts.markEmailVerified(u.id, 1);
    return accounts.getUser(u.id);
  };
  // 旧データ(組織所有・作者は legacy 名のみ)
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pd1', org.id, '2026-10-01');
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pdX', 'o_other', '2026-10-01');
  const refl = (id, pd, legacy) => db.prepare(
    "INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES (?, ?, ?, 'org')",
  ).run(id, pd, legacy);
  refl('refl1', 'pd1', '旧A'); refl('refl2', 'pd1', '旧B'); refl('reflX', 'pdX', '旧A');
  db.prepare("INSERT INTO rec_sessions (id, legacy_owner_name, kind, practice_day_id, visibility) VALUES ('s1', '旧A', 'practice', 'pd1', 'org')").run();
  db.prepare("INSERT INTO rec_sessions (id, kind, practice_day_id, visibility) VALUES ('s2', 'practice', 'pd1', 'org')").run();
  db.prepare("INSERT INTO roadmaps (id, org_id, legacy_name) VALUES ('rm1', ?, '旧A')").run(org.id);
  return { db, accounts, org, user };
}
const authorOf = (db, id) => db.prepare('SELECT author_user_id AS a FROM reflections WHERE id = ?').get(id).a;

test('確認済みメールが名簿と一致 → 紐付く(roster_id 付き)', { skip }, () => {
  const { accounts, org, user } = setup();
  const u = user('a@example.test');
  accounts.replaceRoster(org.id, [{ name: 'A', email: 'a@example.test' }]);
  const r = linkVerifiedUser(accounts, u, 10);
  assert.deepEqual(r.linkedOrgIds, [org.id]);
  const m = accounts.listMembers(org.id);
  assert.equal(m.length, 1);
  assert.equal(m[0].user_id, u.id);
  assert.equal(m[0].roster_id, accounts.listRoster(org.id)[0].id);
});

test('未確認・削除済み・名簿に無いメールは紐付かない', { skip }, () => {
  const { accounts, org, user } = setup();
  accounts.replaceRoster(org.id, [{ name: 'A', email: 'a@example.test' }]);
  const unv = user('a@example.test', { verified: false });
  assert.deepEqual(linkVerifiedUser(accounts, unv, 10).linkedOrgIds, []);
  accounts.markEmailVerified(unv.id, 2);
  accounts.markUserDeleted(unv.id, 3);
  assert.deepEqual(linkVerifiedUser(accounts, accounts.getUser(unv.id), 10).linkedOrgIds, []);
  const other = user('z@example.test');
  assert.deepEqual(linkVerifiedUser(accounts, other, 10).linkedOrgIds, []);
  assert.equal(accounts.listMembers(org.id).length, 0);
});

test('紐付けは冪等(2回目は新規リンクなし・linked_at も変えない)', { skip }, () => {
  const { accounts, org, user } = setup();
  const u = user('a@example.test');
  accounts.replaceRoster(org.id, [{ name: 'A', email: 'a@example.test', legacyName: '旧A' }]);
  linkVerifiedUser(accounts, u, 10);
  const again = linkVerifiedUser(accounts, u, 99);
  assert.deepEqual(again.linkedOrgIds, []);
  assert.equal(accounts.listMembers(org.id)[0].linked_at, 10);
});

test('legacy 名が一致する自組織の反省・ロードマップ・軌跡を本人に付け替える(他組織・他人・既に所有者ありは触らない)', { skip }, () => {
  const { db, accounts, org, user } = setup();
  const u = user('a@example.test');
  accounts.replaceRoster(org.id, [
    { name: 'A', email: 'a@example.test', legacyName: '旧A' },
    { name: 'B', email: 'b@example.test', legacyName: '旧B' },
  ]);
  const r = linkVerifiedUser(accounts, u, 10);
  assert.equal(authorOf(db, 'refl1'), u.id);
  assert.equal(authorOf(db, 'refl2'), null); // B はまだ未登録
  assert.equal(authorOf(db, 'reflX'), null); // 他組織の器
  assert.equal(db.prepare("SELECT owner_user_id AS o FROM rec_sessions WHERE id='s1'").get().o, u.id);
  assert.equal(db.prepare("SELECT owner_user_id AS o FROM rec_sessions WHERE id='s2'").get().o, null);
  assert.equal(db.prepare("SELECT user_id AS u FROM roadmaps WHERE id='rm1'").get().u, u.id);
  assert.deepEqual(r.reattached, { reflections: 1, sessions: 1, roadmaps: 1 });
  // 冪等
  assert.deepEqual(linkVerifiedUser(accounts, u, 11).reattached, { reflections: 0, sessions: 0, roadmaps: 0 });
});

test('既に別の所有者がいる legacy データは奪わない。本人が既にロードマップを持てば付け替えない', { skip }, () => {
  const { db, accounts, org, user } = setup();
  const a = user('a@example.test'); const other = user('o@example.test');
  db.prepare('UPDATE reflections SET author_user_id = ? WHERE id = ?').run(other.id, 'refl1');
  db.prepare("INSERT INTO roadmaps (id, user_id) VALUES ('rmOwn', ?)").run(a.id);
  accounts.replaceRoster(org.id, [{ name: 'A', email: 'a@example.test', legacyName: '旧A' }]);
  const r = linkVerifiedUser(accounts, a, 10);
  assert.equal(authorOf(db, 'refl1'), other.id);
  assert.equal(db.prepare("SELECT user_id AS u FROM roadmaps WHERE id='rm1'").get().u, null);
  assert.equal(r.reattached.roadmaps, 0);
});

test('applyRoster: 置換→照合。linked / unlinked を返し、2回目は空', { skip }, () => {
  const { accounts, org, user } = setup();
  const a = user('a@example.test', { name: 'A' }); const b = user('b@example.test', { name: 'B' });
  user('c@example.test', { verified: false });
  const rows = [
    { name: 'A', email: 'a@example.test' }, { name: 'B', email: 'b@example.test' },
    { name: 'C', email: 'c@example.test' }, { name: 'D', email: 'd@example.test' },
  ];
  const r1 = applyRoster(accounts, org.id, rows, 10);
  assert.deepEqual(r1.linked.map((x) => x.userId).sort(), [a.id, b.id].sort());
  assert.deepEqual(r1.unlinked, []);
  const r2 = applyRoster(accounts, org.id, rows, 20);
  assert.deepEqual(r2.linked, []);
  assert.deepEqual(r2.unlinked, []);
  assert.equal(accounts.listMembers(org.id).length, 2);
});

test('applyRoster: 名簿から外すと解除(本人のデータは残る)。作成者(roster_id NULL)は対象外', { skip }, () => {
  const { db, accounts, org, user } = setup();
  const creator = user('boss@example.test'); const a = user('a@example.test', { name: 'A' });
  accounts.addOrgAdmin(org.id, creator.id);
  accounts.linkMember({ orgId: org.id, userId: creator.id, rosterId: null, now: 1 });
  applyRoster(accounts, org.id, [{ name: 'A', email: 'a@example.test', legacyName: '旧A' }], 10);
  assert.equal(accounts.isMember(org.id, a.id), true);
  const r = applyRoster(accounts, org.id, [], 20);
  assert.deepEqual(r.unlinked, [{ userId: a.id, name: 'A' }]);
  assert.equal(accounts.isMember(org.id, a.id), false);
  assert.equal(accounts.isMember(org.id, creator.id), true);
  assert.equal(authorOf(db, 'refl1'), a.id); // 付け替え済みのデータは残る
});

test('作成者のメールが名簿に載っても roster_id は NULL のまま(解除対象外を保つ)', { skip }, () => {
  const { accounts, org, user } = setup();
  const creator = user('boss@example.test');
  accounts.linkMember({ orgId: org.id, userId: creator.id, rosterId: null, now: 1 });
  const r = applyRoster(accounts, org.id, [{ name: 'Boss', email: 'boss@example.test' }], 10);
  assert.deepEqual(r.linked, []);
  assert.equal(accounts.listMembers(org.id)[0].roster_id, null);
  applyRoster(accounts, org.id, [], 20);
  assert.equal(accounts.isMember(org.id, creator.id), true);
});

test('名簿のメールを直すと、旧メールのユーザーは解除・新メールのユーザーは紐付く', { skip }, () => {
  const { accounts, org, user } = setup();
  const a = user('a@example.test', { name: 'A' }); const a2 = user('a2@example.test', { name: 'A2' });
  applyRoster(accounts, org.id, [{ name: 'A', email: 'a@example.test' }], 10);
  const r = applyRoster(accounts, org.id, [{ name: 'A', email: 'a2@example.test' }], 20);
  assert.deepEqual(r.linked, [{ userId: a2.id, name: 'A2' }]);
  assert.deepEqual(r.unlinked, [{ userId: a.id, name: 'A' }]);
});

test('メール重複は ROSTER_DUPLICATE_EMAIL を投げ、何も変えない', { skip }, () => {
  const { accounts, org } = setup();
  assert.throws(() => applyRoster(accounts, org.id, [
    { name: 'A', email: 'a@example.test' }, { name: 'B', email: 'a@example.test' },
  ], 10), (e) => e.code === 'ROSTER_DUPLICATE_EMAIL');
  assert.deepEqual(accounts.listRoster(org.id), []);
});
