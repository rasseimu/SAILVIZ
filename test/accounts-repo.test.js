// test/accounts-repo.test.js
// 002_accounts.sql(アカウント・組織・名簿・トークン)とリポジトリ。合成データのみ。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// db.isTransaction を使うので Node 24 以上で十分。
const [major] = process.versions.node.split('.').map(Number);
const hasSqlite = major >= 24;
const skipMsg = hasSqlite ? undefined : 'node:sqlite の isTransaction が要る(Node >=24)';

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
  const { rows } = repo.replaceRoster(o.id, [
    { name: 'テスト一', email: 'One@Example.test', legacyName: '旧一' },
    { name: 'テスト二', email: 'two@example.test' },
  ], 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, 'one@example.test');
  assert.equal(rows[0].legacy_name, '旧一');
  assert.equal(repo.findRosterByEmail(o.id, 'ONE@example.test').name, 'テスト一');
  assert.equal(repo.findRosterByEmail(o.id, 'nobody@example.test'), null);
  assert.equal(repo.findRosterRowsByEmail('two@example.test').length, 1);
  const again = repo.replaceRoster(o.id, [{ name: 'テスト三', email: 'three@example.test' }], 20).rows;
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

test('P2-1 replaceRoster: メール一致の行は ID を引き継ぎ、宙に浮いた roster_id が 0 件', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const o = repo.createOrg({ name: '合成部' });
  const [r1, r2] = repo.replaceRoster(o.id, [
    { name: 'テスト一', email: 'one@example.test' },
    { name: 'テスト二', email: 'two@example.test' },
  ], 10).rows;
  const u1 = repo.createUser({ email: 'one@example.test' });
  const u2 = repo.createUser({ email: 'two@example.test' });
  repo.linkMember({ orgId: o.id, userId: u1.id, rosterId: r1.id });
  repo.linkMember({ orgId: o.id, userId: u2.id, rosterId: r2.id });
  // one は残し(名前変更)、two は消す、three を足す
  const u3 = repo.createUser({ email: 'invited@example.test' });
  repo.linkMember({ orgId: o.id, userId: u3.id, rosterId: null }); // 招待で入った会員(roster_id=NULL)
  const { rows, detached } = repo.replaceRoster(o.id, [
    { name: 'テスト一改', email: ' ONE@example.test ' },
    { name: 'テスト三', email: 'three@example.test' },
  ], 20);
  assert.deepEqual(detached, [{ userId: u2.id, rosterId: r2.id }]);
  const one = rows.find((r) => r.email === 'one@example.test');
  assert.equal(one.id, r1.id);
  assert.equal(one.name, 'テスト一改');
  assert.equal(one.updated_at, 20);
  const dangling = db.prepare(
    'SELECT COUNT(*) AS n FROM org_members m WHERE m.roster_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_roster r WHERE r.id = m.roster_id)',
  ).get().n;
  assert.equal(dangling, 0);
  const members = repo.listMembers(o.id);
  assert.equal(members.find((m) => m.user_id === u1.id).roster_id, r1.id);
  assert.equal(members.find((m) => m.user_id === u2.id).roster_id, null);
  assert.equal(repo.isMember(o.id, u2.id), true);
  db.close();
});

test('P2-2 createOrg/replaceRoster は外側のトランザクションに入れられる(SAVEPOINT)', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  db.exec('BEGIN');
  const o = repo.createOrg({ name: '合成部' });
  repo.replaceRoster(o.id, [{ name: 'A', email: 'a@example.test' }]);
  db.exec('ROLLBACK');
  assert.equal(repo.getOrg(o.id), null);
  assert.equal(repo.listRoster(o.id).length, 0);
  // withTx の入れ子: 内側の失敗は内側だけ巻き戻す
  repo.withTx(() => {
    const a = repo.createOrg({ name: 'keep' });
    assert.throws(() => repo.withTx(() => { repo.createOrg({ name: 'drop' }); throw new Error('x'); }), /x/);
    assert.ok(repo.getOrg(a.id));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'drop'").get().n, 0);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'keep'").get().n, 1);
  assert.equal(db.isTransaction, false);
  db.close();
});

test('P2-3 markEmailTokenUsed / revokeAuthToken は変更の有無を返す(二重使用の判別)', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const u = repo.createUser({ email: 'a@example.test' });
  const et = repo.createEmailToken({ userId: u.id, purpose: 'verify', tokenHash: 'e1' });
  assert.equal(repo.markEmailTokenUsed(et, 1), true);
  assert.equal(repo.markEmailTokenUsed(et, 2), false);
  assert.equal(repo.markEmailTokenUsed('et_none', 3), false);
  const at = repo.createAuthToken({ userId: u.id, tokenHash: 'h1' });
  assert.equal(repo.revokeAuthToken(at, 1), true);
  assert.equal(repo.revokeAuthToken(at, 2), false);
  assert.equal(repo.getAuthTokenByHash('h1').revoked_at, 1);
  db.close();
});

test('P2-4 replaceRoster: 正規化後にメールが重複したら弾く(何も変更しない)', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const o = repo.createOrg({ name: '合成部' });
  repo.replaceRoster(o.id, [{ name: 'A', email: 'a@example.test' }]);
  assert.throws(
    () => repo.replaceRoster(o.id, [
      { name: 'X', email: 'dup@example.test' },
      { name: 'Y', email: '  DUP@Example.test ' },
    ]),
    (e) => e.code === 'ROSTER_DUPLICATE_EMAIL',
  );
  assert.deepEqual(repo.listRoster(o.id).map((r) => r.email), ['a@example.test']);
  // メール無しの複数行は可
  assert.equal(repo.replaceRoster(o.id, [{ name: 'P' }, { name: 'Q' }]).rows.length, 2);
  // 別組織なら同じメールも可
  const o2 = repo.createOrg({ name: '別部' });
  assert.equal(repo.replaceRoster(o2.id, [{ email: 'a@example.test' }]).rows.length, 1);
  db.close();
});

test('P3-2 replaceRoster: 既存の同メール重複行を指す会員は残る行へ付け替える', { skip: skipMsg }, () => {
  const { db, repo } = setup();
  const o = repo.createOrg({ name: '合成部' });
  const ins = db.prepare('INSERT INTO org_roster (id, org_id, name, email, updated_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('r_first', o.id, 'A', 'dup@example.test', 1);
  ins.run('r_second', o.id, 'A2', 'dup@example.test', 1);
  const u = repo.createUser({ email: 'dup@example.test' });
  repo.linkMember({ orgId: o.id, userId: u.id, rosterId: 'r_second' });
  const { rows, detached } = repo.replaceRoster(o.id, [{ name: 'A', email: 'dup@example.test' }], 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'r_first');
  assert.deepEqual(detached, []);
  assert.equal(repo.listMembers(o.id)[0].roster_id, 'r_first');
  db.close();
});

test('P2-1 withTx: COMMIT が失敗しても depth が戻り、元の例外が出て、次の withTx が動く', { skip: skipMsg }, () => {
  const { db } = setup();
  let failCommit = true;
  const wrapped = {
    exec(sql) {
      if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('commit failed'); }
      return db.exec(sql);
    },
    prepare: (s) => db.prepare(s),
    get isTransaction() { return db.isTransaction; },
  };
  const repo = createAccountsRepo({ db: wrapped });
  assert.throws(() => repo.withTx(() => { db.exec("INSERT INTO orgs (id, name, created_at) VALUES ('o_x', 'x', 1)"); }), /commit failed/);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'o_x'").get().n, 0);
  // depth が -1 になっていると、ここで入れ子判定を誤って BEGIN が二重になる
  repo.withTx(() => {
    repo.withTx(() => { db.exec("INSERT INTO orgs (id, name, created_at) VALUES ('o_y', 'y', 1)"); });
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE id = 'o_y'").get().n, 1);
  assert.equal(db.isTransaction, false);
  db.close();
});

test('P3-1 withTx: ROLLBACK が失敗しても元の例外を投げ直す', { skip: skipMsg }, () => {
  const { db } = setup();
  const wrapped = {
    exec(sql) {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return db.exec(sql);
    },
    prepare: (s) => db.prepare(s),
    get isTransaction() { return db.isTransaction; },
  };
  const repo = createAccountsRepo({ db: wrapped });
  assert.throws(() => repo.withTx(() => { throw new Error('original'); }), /original/);
  db.exec('ROLLBACK'); // 後始末(偽物が失敗させたため)
  db.close();
});

test('P3 email_tokens(user_id) の索引がある', { skip: skipMsg }, () => {
  const { db } = setup();
  const idx = db.prepare("PRAGMA index_list('email_tokens')").all().map((i) => i.name);
  assert.ok(idx.includes('email_tokens_user'));
  db.close();
});
