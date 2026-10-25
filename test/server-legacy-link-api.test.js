// test/server-legacy-link-api.test.js — 旧名簿の氏名の紐付け(GET legacy-names・POST legacy-links)。合成データのみ。Node 24 が要る。
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

const mkMember = (orgId, { admin = false } = {}) => {
  seq += 1;
  const u = accounts.createUser({ email: `l${seq}@example.test`, name: `L${seq}`, passwordHash: 'x', now: clock });
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
  for (const [id, pd, name] of [['r1', 'pd1', '旧 一郎'], ['r2', 'pd1', '旧 一郎'], ['r3', 'pd1', '旧 二郎'], ['r4', 'pd2', '旧 一郎']]) {
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

test('legacy-names: 管理者だけ。取込み組織は氏名と未付け替えの件数、ほかの組織は available: false', { skip }, async () => {
  const admin = mkMember(legacyOrg.id, { admin: true });
  const member = mkMember(legacyOrg.id);
  assert.equal((await call('GET', `/api/orgs/${legacyOrg.id}/legacy-names`)).status, 401);
  assert.equal((await call('GET', `/api/orgs/${legacyOrg.id}/legacy-names`, member.tok)).status, 403);
  const r = await call('GET', `/api/orgs/${legacyOrg.id}/legacy-names`, admin.tok);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.available, true);
  assert.deepEqual(j.names.map((n) => [n.name, n.unclaimed]), [['旧 一郎', 3], ['旧 二郎', 1]]);
  const otherAdmin = mkMember(otherOrg.id, { admin: true });
  const o = await (await call('GET', `/api/orgs/${otherOrg.id}/legacy-names`, otherAdmin.tok)).json();
  assert.deepEqual(o, { available: false, names: [] });
});

test('legacy-links: ほかの組織の管理者は同姓同名がいても紐付けられない(403)。何も変わらない', { skip }, async () => {
  const otherAdmin = mkMember(otherOrg.id, { admin: true });
  const target = mkMember(otherOrg.id);
  const before = JSON.stringify(owners());
  const r = await call('POST', `/api/orgs/${otherOrg.id}/legacy-links`, otherAdmin.tok, { userId: target.user.id, legacyName: '旧 一郎' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'legacy_unavailable');
  assert.equal(JSON.stringify(owners()), before);
});

test('legacy-links: 紐付けると取込み組織の記録だけが本人のものになり、メンバー一覧・名簿の旧氏名になる', { skip }, async () => {
  const admin = mkMember(legacyOrg.id, { admin: true });
  const member = mkMember(legacyOrg.id);
  const nonMember = mkMember(otherOrg.id);
  assert.equal((await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, member.tok, { userId: member.user.id, legacyName: '旧 一郎' })).status, 403);
  assert.equal((await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: nonMember.user.id, legacyName: '旧 一郎' })).status, 422);
  assert.equal((await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: member.user.id, legacyName: '旧 三郎' })).status, 422);
  const r = await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: member.user.id, legacyName: '旧 一郎' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).moved, { reflections: 2, sessions: 1, roadmaps: 0 });
  const o = Object.fromEntries(owners().map((x) => [x.id, x.u]));
  assert.equal(o.r1, member.user.id);
  assert.equal(o.r2, member.user.id);
  assert.equal(o.r3, null);
  assert.equal(o.r4, null); // 別の組織の同姓同名の記録は動かない
  const members = await (await call('GET', `/api/orgs/${legacyOrg.id}/members`, admin.tok)).json();
  assert.equal(members.find((m) => m.userId === member.user.id).legacyName, '旧 一郎');
  // 反省・進捗の名簿(GET /api/members の元)でも、本人の氏名が旧氏名になる
  const roster = rosterForSubject(accounts, { kind: 'user', userId: member.user.id, orgIds: [legacyOrg.id] }, legacyOrg.id);
  assert.equal(roster.find((m) => m.id === member.user.id).fullName, '旧 一郎');

  // 同じ氏名を別のメンバーへは紐付けられない。紐付け済みのメンバーを別の氏名へも変えられない。
  const another = mkMember(legacyOrg.id);
  const taken = await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: another.user.id, legacyName: '旧 一郎' });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error.code, 'legacy_taken');
  const relink = await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: member.user.id, legacyName: '旧 二郎' });
  assert.equal(relink.status, 409);
  assert.equal((await relink.json()).error.code, 'member_linked');
  // 同じ組み合わせのやり直しは 200(動く件数 0)
  const again = await call('POST', `/api/orgs/${legacyOrg.id}/legacy-links`, admin.tok, { userId: member.user.id, legacyName: '旧 一郎' });
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).moved, { reflections: 0, sessions: 0, roadmaps: 0 });
});
