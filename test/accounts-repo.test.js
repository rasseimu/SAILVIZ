// test/accounts-repo.test.js
// 002_accounts.sql(アカウント・組織・名簿・トークン)とリポジトリ。合成データのみ。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

let openDb, migrate, loadMigrations, createAccountsRepo;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
}
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

function setup() {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  return { db, repo: createAccountsRepo({ db }) };
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('002 を適用すると §5.1 のアカウント系の表と列ができる', { skip: skipMsg }, () => {
  const { db } = setup();
  const v = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.ok(v.includes(2));
  assert.deepEqual(cols(db, 'users'), ['id', 'email', 'email_verified_at', 'password_hash', 'name',
    'affiliation_text', 'default_visibility', 'agreed_at', 'created_at', 'deleted_at']);
  assert.deepEqual(cols(db, 'auth_tokens'), ['id', 'user_id', 'token_hash', 'created_at', 'last_used_at', 'expires_at', 'revoked_at']);
  assert.deepEqual(cols(db, 'email_tokens'), ['id', 'user_id', 'purpose', 'token_hash', 'new_email', 'expires_at', 'used_at']);
  assert.deepEqual(cols(db, 'orgs'), ['id', 'name', 'created_at']);
  assert.deepEqual(cols(db, 'org_admins'), ['org_id', 'user_id']);
  assert.deepEqual(cols(db, 'org_roster'), ['id', 'org_id', 'name', 'email', 'legacy_name', 'updated_at']);
  assert.deepEqual(cols(db, 'org_members'), ['org_id', 'user_id', 'roster_id', 'linked_at']);
  // 平文トークン列は無い
  assert.ok(!cols(db, 'auth_tokens').includes('token'));
  // org_invites は S2.9(003)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'org_invites'").get(), undefined);
  db.close();
});

test('002 は冪等(再適用しても 0 件)', { skip: skipMsg }, () => {
  const { db } = setup();
  assert.equal(migrate(db, loadMigrations(MIG_DIR)), 0);
  db.close();
});

test('users: 作成・取得・メール一意(大文字小文字を区別しない)', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'Alice@Example.test', name: 'テスト太郎', affiliationText: '合成大学', passwordHash: 'scrypt$x', agreedAt: 5, now: 10 });
  assert.match(u.id, /^u_[0-9a-f]{10}$/);
  assert.equal(u.email, 'alice@example.test');
  assert.equal(u.created_at, 10);
  assert.equal(u.email_verified_at, null);
  assert.equal(repo.getUserByEmail('ALICE@example.test').id, u.id);
  assert.throws(() => repo.createUser({ email: 'alice@example.test' }), /UNIQUE/);
  db.close();
});

test('users: メール確認・更新・削除印', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'a@example.test', name: 'A' });
  repo.markEmailVerified(u.id, 100);
  assert.equal(repo.getUser(u.id).email_verified_at, 100);
  repo.updateUser(u.id, { name: 'B', defaultVisibility: 'org' });
  assert.equal(repo.getUser(u.id).name, 'B');
  assert.equal(repo.getUser(u.id).default_visibility, 'org');
  assert.equal(repo.getUser(u.id).email_verified_at, 100);
  repo.updateUser(u.id, { email: 'New@example.test' }); // 変更で確認が外れる(§4.2)
  assert.equal(repo.getUser(u.id).email, 'new@example.test');
  assert.equal(repo.getUser(u.id).email_verified_at, null);
  repo.markUserDeleted(u.id, 200);
  assert.equal(repo.getUser(u.id).deleted_at, 200);
  assert.equal(repo.getUser('u_none'), null);
  db.close();
});

test('auth_tokens: ハッシュだけ保存・一意・失効', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'a@example.test' });
  const id = repo.createAuthToken({ userId: u.id, tokenHash: 'h1', expiresAt: 1000, now: 1 });
  const row = repo.getAuthTokenByHash('h1');
  assert.equal(row.id, id);
  assert.equal(row.token_hash, 'h1');
  assert.equal(row.revoked_at, null);
  assert.equal(repo.getAuthTokenByHash('plain'), null);
  assert.throws(() => repo.createAuthToken({ userId: u.id, tokenHash: 'h1' }), /UNIQUE/);
  repo.touchAuthToken(id, { lastUsedAt: 50, expiresAt: 2000 });
  assert.equal(repo.getAuthTokenByHash('h1').expires_at, 2000);
  repo.createAuthToken({ userId: u.id, tokenHash: 'h2' });
  assert.equal(repo.revokeAllAuthTokens(u.id, 300), 2);
  assert.equal(repo.getAuthTokenByHash('h2').revoked_at, 300);
  assert.equal(repo.revokeAllAuthTokens(u.id, 400), 0);
  db.close();
});

test('email_tokens: purpose 検査・ハッシュ一意・使用済み', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'a@example.test' });
  const id = repo.createEmailToken({ userId: u.id, purpose: 'change', tokenHash: 'e1', newEmail: 'b@example.test', expiresAt: 9 });
  const row = repo.getEmailTokenByHash('e1');
  assert.equal(row.purpose, 'change');
  assert.equal(row.new_email, 'b@example.test');
  assert.equal(row.used_at, null);
  assert.throws(() => repo.createEmailToken({ userId: u.id, purpose: 'bogus', tokenHash: 'e2' }), /invalid purpose/);
  assert.throws(() => repo.createEmailToken({ userId: u.id, purpose: 'verify', tokenHash: 'e1' }), /UNIQUE/);
  repo.markEmailTokenUsed(id, 77);
  repo.markEmailTokenUsed(id, 88); // 2回目は上書きしない
  assert.equal(repo.getEmailTokenByHash('e1').used_at, 77);
  db.close();
});

test('orgs / org_admins: 作成者を管理者に・重複は無視', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'a@example.test' });
  const o = repo.createOrg({ name: '合成セーリング部', adminUserIds: [u.id, u.id], now: 5 });
  assert.match(o.id, /^o_[0-9a-f]{10}$/);
  assert.equal(o.created_at, 5);
  assert.deepEqual(repo.listOrgAdmins(o.id), [u.id]);
  assert.equal(repo.isOrgAdmin(o.id, u.id), true);
  assert.equal(repo.isOrgAdmin(o.id, 'u_other'), false);
  repo.addOrgAdmin(o.id, 'u_other');
  assert.equal(repo.listOrgAdmins(o.id).length, 2);
  db.close();
});

test('org_roster: 置き換え・メールの正規化と検索', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const o = repo.createOrg({ name: '合成部' });
  const rows = repo.replaceRoster(o.id, [
    { name: 'テスト一', email: 'One@Example.test', legacyName: '旧一' },
    { name: 'テスト二', email: 'two@example.test' },
  ], 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, 'one@example.test');
  assert.equal(rows[0].legacy_name, '旧一');
  assert.equal(repo.findRosterByEmail(o.id, 'ONE@example.test').name, 'テスト一');
  assert.equal(repo.findRosterByEmail(o.id, 'nobody@example.test'), null);
  assert.equal(repo.findRosterRowsByEmail('two@example.test').length, 1);
  const again = repo.replaceRoster(o.id, [{ name: 'テスト三', email: 'three@example.test' }], 20);
  assert.equal(again.length, 1);
  assert.equal(repo.findRosterByEmail(o.id, 'one@example.test'), null);
  db.close();
});

test('org_members: 紐付け・再紐付け(上書き)・解除・一意', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const o = repo.createOrg({ name: '合成部' });
  const u = repo.createUser({ email: 'a@example.test' });
  repo.linkMember({ orgId: o.id, userId: u.id, rosterId: 'r_1', now: 1 });
  repo.linkMember({ orgId: o.id, userId: u.id, rosterId: 'r_2', now: 2 });
  const m = repo.listMembers(o.id);
  assert.equal(m.length, 1);
  assert.equal(m[0].roster_id, 'r_2');
  assert.equal(m[0].linked_at, 2);
  assert.equal(repo.isMember(o.id, u.id), true);
  assert.equal(repo.listMembershipsOfUser(u.id).length, 1);
  repo.unlinkMember(o.id, u.id);
  assert.equal(repo.isMember(o.id, u.id), false);
  db.close();
});
