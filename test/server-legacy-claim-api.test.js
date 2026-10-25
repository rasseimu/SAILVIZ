// test/server-legacy-claim-api.test.js — 旧名簿の氏名への自動の結び付け(氏名の空白を除く一致)と GET /api/orgs/:orgId/legacy-claim。合成データのみ。Node 24 が要る。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';
import { rosterForSubject } from '../server/orgMembers.js';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let server, base, db, accounts, issueAuthToken, legacyOrg, otherOrg;
let seq = 0;
const clock = 1_000_000;

const mkMember = (orgId, { admin = false, name } = {}) => {
  seq += 1;
  const u = accounts.createUser({ email: `l${seq}@example.test`, name: name ?? `L${seq}`, passwordHash: 'x', now: clock });
  accounts.linkMember({ orgId, userId: u.id, rosterId: null, now: clock });
  if (admin) accounts.addOrgAdmin(orgId, u.id);
  return { user: u, tok: issueAuthToken(accounts, u.id, clock).token };
};
const call = (method, path, tok, body) => fetch(`${base}${path}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const owners = () => db.prepare('SELECT id, author_user_id AS u FROM reflections ORDER BY id').all();

before(async () => {
  if (skip) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  ({ issueAuthToken } = await import('../server/accountAuth.js'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  accounts = createAccountsRepo({ db });
  legacyOrg = accounts.createOrg({ name: '旧データの部', now: 1 });
  otherOrg = accounts.createOrg({ name: '別の部', now: 1 });
  // 旧データ: 取込み組織に「旧 一郎」「旧 二郎」。別の組織にも同姓同名の「旧 一郎」。
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pd1', legacyOrg.id, '2026-10-01');
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pd2', otherOrg.id, '2026-10-01');
  for (const [id, pd, name] of [['r1', 'pd1', '旧 一郎'], ['r2', 'pd1', '旧 一郎'], ['r3', 'pd1', '旧 二郎'], ['r4', 'pd2', '旧 一郎'], ['r5', 'pd1', '旧 三郎']]) {
    db.prepare("INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES (?, ?, ?, 'org')").run(id, pd, name);
  }
  db.prepare("INSERT INTO rec_sessions (id, legacy_owner_name, kind, practice_day_id, visibility) VALUES ('s1','旧 一郎','practice','pd1','org')").run();
  const api = createApi({ repo: {}, token: 'shared-secret', accounts, authOptions: { now: () => clock }, migrationOrgId: legacyOrg.id });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  db.close();
});

const claimPath = (orgId) => `/api/orgs/${orgId}/legacy-claim`;
const ownerOf = (id) => owners().find((x) => x.id === id).u;

test('氏名が空白違いで一致するメンバーは自動で結び付く(GET legacy-claim)。本人以外・未ログインは見られない', { skip }, async () => {
  const me = mkMember(legacyOrg.id, { name: '旧二郎' }); // スペースなしで登録
  const outsider = mkMember(otherOrg.id);
  assert.equal((await call('GET', claimPath(legacyOrg.id))).status, 401);
  assert.equal((await call('GET', claimPath(legacyOrg.id), outsider.tok)).status, 403);
  const j = await (await call('GET', claimPath(legacyOrg.id), me.tok)).json();
  assert.deepEqual(j, { available: true, linked: '旧 二郎' });
  assert.equal(ownerOf('r3'), me.user.id);
});

test('ほかの組織では、同姓同名がいても結び付かない(記録は動かない)', { skip }, async () => {
  const same = mkMember(otherOrg.id, { name: '旧一郎' });
  const before = JSON.stringify(owners());
  assert.deepEqual(await (await call('GET', claimPath(otherOrg.id), same.tok)).json(), { available: false, linked: null });
  assert.equal((await call('GET', '/api/me', same.tok)).status, 200);
  assert.equal(JSON.stringify(owners()), before);
});

test('氏名が一致しなければ結び付かず、氏名を直す(PATCH /api/me)と結び付く。取込み組織の記録だけが動く', { skip }, async () => {
  const me = mkMember(legacyOrg.id, { name: 'ニックネーム' });
  assert.deepEqual(await (await call('GET', claimPath(legacyOrg.id), me.tok)).json(), { available: true, linked: null });
  assert.equal(ownerOf('r1'), null);
  assert.equal((await call('PATCH', '/api/me', me.tok, { name: '旧一郎' })).status, 200);
  assert.equal(ownerOf('r1'), me.user.id);
  assert.equal(ownerOf('r2'), me.user.id);
  assert.equal(ownerOf('r4'), null); // 別の組織の同姓同名の記録は動かない
  assert.equal(db.prepare("SELECT owner_user_id AS u FROM rec_sessions WHERE id = 's1'").get().u, me.user.id);
  const roster = rosterForSubject(accounts, { kind: 'user', userId: me.user.id, orgIds: [legacyOrg.id] }, legacyOrg.id);
  assert.equal(roster.find((m) => m.id === me.user.id).fullName, '旧 一郎');
  const members = await (await call('GET', `/api/orgs/${legacyOrg.id}/members`, me.tok)).json();
  assert.equal(members.find((m) => m.userId === me.user.id).legacyName, '旧 一郎');

  // 後から同じ氏名で入った人は結び付かない(先に結び付いた人の記録は動かない)。結び付いた人は氏名を変えても外れない。
  const later = mkMember(legacyOrg.id, { name: '旧 一郎' });
  assert.deepEqual(await (await call('GET', claimPath(legacyOrg.id), later.tok)).json(), { available: true, linked: null });
  assert.equal(ownerOf('r1'), me.user.id);
  assert.equal((await call('PATCH', '/api/me', me.tok, { name: '旧二郎' })).status, 200);
  assert.equal((await (await call('GET', claimPath(legacyOrg.id), me.tok)).json()).linked, '旧 一郎');
});

test('招待リンクから登録すると、参加と同時に結び付く', { skip }, async () => {
  const admin = mkMember(legacyOrg.id, { admin: true });
  const inv = await (await call('POST', `/api/orgs/${legacyOrg.id}/invites`, admin.tok, {})).json();
  const r = await call('POST', '/api/auth/register', null, {
    email: 'reg-legacy@example.test', password: 'dummy-pass-123', name: '旧三郎', affiliationText: 'テスト部', agreedAt: clock,
    inviteCode: inv.code,
  });
  assert.equal(r.status, 200);
  const { user } = await r.json();
  assert.equal(ownerOf('r5'), user.id);
});
