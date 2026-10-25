// test/server-legacy-claim-api.test.js — 旧名簿の氏名の本人確認(GET/POST /api/orgs/:orgId/legacy-claim)。合成データのみ。Node 24 が要る。
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

const claimPath = (orgId) => `/api/orgs/${orgId}/legacy-claim`;

test('GET legacy-claim: メンバー本人だけ。名前が空白違いで一致する旧氏名を提案し、候補は未紐付けの旧氏名', { skip }, async () => {
  const me = mkMember(legacyOrg.id, { name: '旧二郎' }); // 空白なしで登録
  const outsider = mkMember(otherOrg.id);
  assert.equal((await call('GET', claimPath(legacyOrg.id))).status, 401);
  assert.equal((await call('GET', claimPath(legacyOrg.id), outsider.tok)).status, 403);
  const j = await (await call('GET', claimPath(legacyOrg.id), me.tok)).json();
  assert.equal(j.available, true);
  assert.equal(j.linked, null);
  assert.equal(j.suggested, '旧 二郎');
  assert.ok(j.candidates.includes('旧 二郎'));
});

test('ほかの組織では、同姓同名がいても available: false・POST は 403。記録は動かない', { skip }, async () => {
  const same = mkMember(otherOrg.id, { name: '旧 一郎' });
  const v = await (await call('GET', claimPath(otherOrg.id), same.tok)).json();
  assert.deepEqual(v, { available: false, linked: null, suggested: null, candidates: [] });
  const before = JSON.stringify(owners());
  const r = await call('POST', claimPath(otherOrg.id), same.tok, { legacyName: '旧 一郎' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'legacy_unavailable');
  assert.equal(JSON.stringify(owners()), before);
});

test('POST legacy-claim: 「はい」で取込み組織の記録だけが本人のものになり、名簿の氏名が旧氏名になる', { skip }, async () => {
  const me = mkMember(legacyOrg.id, { name: 'ニックネーム' }); // 名前が一致しなくても一覧から選べる
  const v = await (await call('GET', claimPath(legacyOrg.id), me.tok)).json();
  assert.equal(v.suggested, null);
  assert.ok(v.candidates.includes('旧 一郎'));
  assert.equal((await call('POST', claimPath(legacyOrg.id), me.tok, { legacyName: '旧 三郎' })).status, 409); // 記録に無い
  assert.equal((await call('POST', claimPath(legacyOrg.id), me.tok, {})).status, 422);
  const r = await call('POST', claimPath(legacyOrg.id), me.tok, { legacyName: '旧 一郎' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).moved, { reflections: 2, sessions: 1, roadmaps: 0 });
  const o = Object.fromEntries(owners().map((x) => [x.id, x.u]));
  assert.equal(o.r1, me.user.id);
  assert.equal(o.r2, me.user.id);
  assert.equal(o.r3, null);
  assert.equal(o.r4, null); // 別の組織の同姓同名の記録は動かない
  const after = await (await call('GET', claimPath(legacyOrg.id), me.tok)).json();
  assert.equal(after.linked, '旧 一郎');
  const roster = rosterForSubject(accounts, { kind: 'user', userId: me.user.id, orgIds: [legacyOrg.id] }, legacyOrg.id);
  assert.equal(roster.find((m) => m.id === me.user.id).fullName, '旧 一郎');
  const members = await (await call('GET', `/api/orgs/${legacyOrg.id}/members`, me.tok)).json();
  assert.equal(members.find((m) => m.userId === me.user.id).legacyName, '旧 一郎');

  // 別のメンバーは同じ氏名を選べない(候補にも出ない)。自分は別の氏名へ付け替えられない。やり直しは 200(0 件)。
  const another = mkMember(legacyOrg.id, { name: '旧 一郎' });
  const av = await (await call('GET', claimPath(legacyOrg.id), another.tok)).json();
  assert.equal(av.suggested, null);
  assert.ok(!av.candidates.includes('旧 一郎'));
  assert.equal((await call('POST', claimPath(legacyOrg.id), another.tok, { legacyName: '旧 一郎' })).status, 409);
  const relink = await call('POST', claimPath(legacyOrg.id), me.tok, { legacyName: '旧 二郎' });
  assert.equal(relink.status, 409);
  assert.equal((await relink.json()).error.code, 'member_linked');
  const again = await call('POST', claimPath(legacyOrg.id), me.tok, { legacyName: '旧 一郎' });
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).moved, { reflections: 0, sessions: 0, roadmaps: 0 });
});
