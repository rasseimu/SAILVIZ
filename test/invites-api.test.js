// test/invites-api.test.js — 招待コード(repo と API)。合成データのみ。node:sqlite が要る(Node 24)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

let server, base, db, accounts, clock, issueAuthToken, seq = 0;

const mkUser = (verified = true) => {
  seq += 1;
  const u = accounts.createUser({ email: `inv${seq}@example.test`, name: `I${seq}`, passwordHash: 'x', now: clock });
  if (verified) accounts.markEmailVerified(u.id, clock);
  return { user: u, tok: issueAuthToken(accounts, u.id, clock).token };
};
const mkOrg = () => {
  const admin = mkUser();
  const org = accounts.createOrg({ name: 'テスト組織', adminUserIds: [admin.user.id], now: clock });
  accounts.linkMember({ orgId: org.id, userId: admin.user.id, rosterId: null, now: clock });
  return { admin, org };
};
const call = (method, path, tok, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const mkInvite = async (org, admin, body = {}) => (await call('POST', `/api/orgs/${org.id}/invites`, admin.tok, body)).json();

before(async () => {
  if (skip) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  ({ issueAuthToken } = await import('../server/accountAuth.js'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  accounts = createAccountsRepo({ db });
  clock = 1_000_000;
  const api = createApi({
    repo: {}, token: 'shared-secret', accounts, baseUrl: 'https://example.test/', authOptions: { now: () => clock },
  });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  db.close();
});

// ---------- repo ----------
test('repo: createInvite は inv_ の id・member・use_count 0、code は一意', { skip }, () => {
  const { admin, org } = mkOrg();
  const a = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  const b = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  assert.match(a.id, /^inv_/);
  assert.equal(a.role, 'member');
  assert.equal(a.use_count, 0);
  assert.equal(a.expires_at, null);
  assert.equal(a.max_uses, null);
  assert.notEqual(a.code, b.code);
  assert.equal(accounts.getInviteByCode(a.code).id, a.id);
});

test('repo: acceptInvite は use_count を加算し roster_id=NULL で参加させる', { skip }, () => {
  const { admin, org } = mkOrg();
  const inv = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  const u = mkUser();
  const r = accounts.acceptInvite({ code: inv.code, userId: u.user.id, now: clock });
  assert.deepEqual(r, { status: 'joined', orgId: org.id });
  assert.equal(accounts.getInvite(inv.id).use_count, 1);
  const m = accounts.listMembers(org.id).find((x) => x.user_id === u.user.id);
  assert.equal(m.roster_id, null);
  assert.equal(m.linked_at, clock);
});

test('repo: 既参加は already で加算しない', { skip }, () => {
  const { admin, org } = mkOrg();
  const inv = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  assert.equal(accounts.acceptInvite({ code: inv.code, userId: admin.user.id, now: clock }).status, 'already');
  assert.equal(accounts.getInvite(inv.id).use_count, 0);
});

test('repo: max_uses は超えない(上限で exhausted、参加も増えない)', { skip }, () => {
  const { admin, org } = mkOrg();
  const inv = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, maxUses: 2, now: clock });
  const us = [mkUser(), mkUser(), mkUser()];
  const out = us.map((u) => accounts.acceptInvite({ code: inv.code, userId: u.user.id, now: clock }).status);
  assert.deepEqual(out, ['joined', 'joined', 'exhausted']);
  assert.equal(accounts.getInvite(inv.id).use_count, 2);
  assert.equal(accounts.isMember(org.id, us[2].user.id), false);
});

test('repo: 失敗(挿入エラー)なら use_count の加算も巻き戻る', { skip }, () => {
  const { admin, org } = mkOrg();
  const inv = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  assert.throws(() => accounts.acceptInvite({ code: inv.code, userId: undefined, now: clock })); // user_id NOT NULL 違反
  assert.equal(accounts.getInvite(inv.id).use_count, 0);
});

test('repo: revokeInvite は組織を縛る。listActiveInvites は無効なものを除く', { skip }, () => {
  const { admin, org } = mkOrg();
  const other = mkOrg();
  const live = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  const dead = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  const exp = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, expiresAt: clock + 10, now: clock });
  const full = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, maxUses: 1, now: clock });
  accounts.acceptInvite({ code: full.code, userId: mkUser().user.id, now: clock });
  assert.equal(accounts.revokeInvite(other.org.id, dead.id, clock), false); // 他組織からは失効できない
  assert.equal(accounts.revokeInvite(org.id, dead.id, clock), true);
  assert.equal(accounts.revokeInvite(org.id, dead.id, clock), false);
  const ids = (t) => accounts.listActiveInvites(org.id, t).map((i) => i.id).sort();
  assert.deepEqual(ids(clock), [exp.id, live.id].sort());
  assert.deepEqual(ids(clock + 10), [live.id]);
});

// ---------- API: 作成・一覧・失効 ----------
test('POST invites: 未認証 401・共有トークン 401・一般メンバー 403・未知の組織 404', { skip }, async () => {
  const { org } = mkOrg();
  const member = mkUser();
  accounts.linkMember({ orgId: org.id, userId: member.user.id, rosterId: null, now: clock });
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites`, null, {})).status, 401);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites`, 'shared-secret', {})).status, 401);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites`, member.tok, {})).status, 403);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites`, mkUser().tok, {})).status, 403);
  assert.equal((await call('POST', '/api/orgs/o_none/invites', member.tok, {})).status, 404);
});

test('POST invites: 管理者は発行でき、応答は {id,code,url,expiresAt,maxUses}', { skip }, async () => {
  const { admin, org } = mkOrg();
  const r = await call('POST', `/api/orgs/${org.id}/invites`, admin.tok, { expiresInDays: 7, maxUses: 5 });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ['code', 'expiresAt', 'id', 'maxUses', 'url']);
  assert.match(j.id, /^inv_/);
  assert.equal(j.expiresAt, clock + 7 * DAY);
  assert.equal(j.maxUses, 5);
  assert.equal(j.url, `https://example.test/?invite=${j.code}`);
  const none = await mkInvite(org, admin, {});
  assert.equal(none.expiresAt, null);
  assert.equal(none.maxUses, null);
});

test('POST invites: 範囲外・型違い・配列本文は 422', { skip }, async () => {
  const { admin, org } = mkOrg();
  for (const b of [{ expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: '7' }, { maxUses: 0 }, { maxUses: 1001 }, { maxUses: 1.5 }]) {
    const r = await call('POST', `/api/orgs/${org.id}/invites`, admin.tok, b);
    assert.equal(r.status, 422, JSON.stringify(b));
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites`, admin.tok, [])).status, 422);
});

test('GET invites: 管理者だけ。有効なものだけ useCount 付きで返す', { skip }, async () => {
  const { admin, org } = mkOrg();
  const a = await mkInvite(org, admin, { maxUses: 3 });
  const b = await mkInvite(org, admin, {});
  await call('POST', `/api/orgs/${org.id}/invites/${b.id}/revoke`, admin.tok);
  await call('POST', `/api/invites/${a.code}/accept`, mkUser().tok);
  assert.equal((await call('GET', `/api/orgs/${org.id}/invites`, null)).status, 401);
  assert.equal((await call('GET', `/api/orgs/${org.id}/invites`, mkUser().tok)).status, 403);
  const r = await call('GET', `/api/orgs/${org.id}/invites`, admin.tok);
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: a.id, code: a.code, url: a.url, expiresAt: null, maxUses: 3, useCount: 1 });
});

test('revoke: 管理者は失効でき {ok:true}。他組織の管理者は 403 で失効できない', { skip }, async () => {
  const { admin, org } = mkOrg();
  const other = mkOrg();
  const inv = await mkInvite(org, admin);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites/${inv.id}/revoke`, null)).status, 401);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites/${inv.id}/revoke`, other.admin.tok)).status, 403);
  // 自組織の URL に他組織の招待 ID を混ぜても失効しない
  const mine = await mkInvite(other.org, other.admin);
  assert.equal((await call('POST', `/api/orgs/${other.org.id}/invites/${inv.id}/revoke`, other.admin.tok)).status, 404);
  assert.equal(accounts.getInvite(inv.id).revoked_at, null);
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites/inv_none/revoke`, admin.tok)).status, 404);
  const r = await call('POST', `/api/orgs/${org.id}/invites/${inv.id}/revoke`, admin.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await call('POST', `/api/orgs/${org.id}/invites/${inv.id}/revoke`, admin.tok)).status, 200); // 冪等
  assert.equal(accounts.getInvite(mine.id).revoked_at, null);
});

// ---------- API: プレビュー・参加 ----------
test('GET /api/invites/:code: 401・未確認 403・未知 404、有効なら秘密なしで返す', { skip }, async () => {
  const { admin, org } = mkOrg();
  const inv = await mkInvite(org, admin);
  assert.equal((await call('GET', `/api/invites/${inv.code}`, null)).status, 401);
  const un = await call('GET', `/api/invites/${inv.code}`, mkUser(false).tok);
  assert.equal(un.status, 403);
  assert.equal((await un.json()).error.code, 'email_not_verified');
  const u = mkUser();
  assert.equal((await call('GET', '/api/invites/nope', u.tok)).status, 404);
  const r = await call('GET', `/api/invites/${inv.code}`, u.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { orgId: org.id, orgName: 'テスト組織', valid: true });
  assert.equal(accounts.isMember(org.id, u.user.id), false); // プレビューでは参加しない
});

test('GET /api/invites/:code: 失効/期限切れ/上限超過は valid:false と reason', { skip }, async () => {
  const { admin, org } = mkOrg();
  const u = mkUser();
  const rev = await mkInvite(org, admin);
  await call('POST', `/api/orgs/${org.id}/invites/${rev.id}/revoke`, admin.tok);
  const exp = await mkInvite(org, admin, { expiresInDays: 1 });
  const full = await mkInvite(org, admin, { maxUses: 1 });
  await call('POST', `/api/invites/${full.code}/accept`, mkUser().tok);
  clock += 2 * DAY;
  try {
    const reason = async (i) => (await (await call('GET', `/api/invites/${i.code}`, u.tok)).json());
    assert.deepEqual(await reason(rev), { orgId: org.id, orgName: 'テスト組織', valid: false, reason: 'revoked' });
    assert.equal((await reason(exp)).reason, 'expired');
    assert.equal((await reason(full)).reason, 'exhausted');
  } finally { clock -= 2 * DAY; }
});

test('accept: 401・未確認 403(参加しない)・未知 404', { skip }, async () => {
  const { admin, org } = mkOrg();
  const inv = await mkInvite(org, admin);
  assert.equal((await call('POST', `/api/invites/${inv.code}/accept`, null)).status, 401);
  const un = mkUser(false);
  const r = await call('POST', `/api/invites/${inv.code}/accept`, un.tok);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'email_not_verified');
  assert.equal(accounts.isMember(org.id, un.user.id), false);
  assert.equal(accounts.getInvite(inv.id).use_count, 0);
  assert.equal((await call('POST', '/api/invites/nope/accept', mkUser().tok)).status, 404);
});

test('accept: 参加できて {orgId}、use_count が増え、2回目は冪等 200(加算なし)', { skip }, async () => {
  const { admin, org } = mkOrg();
  const inv = await mkInvite(org, admin, { maxUses: 5 });
  const u = mkUser();
  const r = await call('POST', `/api/invites/${inv.code}/accept`, u.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { orgId: org.id });
  assert.equal(accounts.isMember(org.id, u.user.id), true);
  assert.equal(accounts.isOrgAdmin(org.id, u.user.id), false); // 管理者にはならない
  assert.equal(accounts.getInvite(inv.id).use_count, 1);
  const r2 = await call('POST', `/api/invites/${inv.code}/accept`, u.tok);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { orgId: org.id });
  assert.equal(accounts.getInvite(inv.id).use_count, 1);
  // 管理者(既参加)も 200
  assert.equal((await call('POST', `/api/invites/${inv.code}/accept`, admin.tok)).status, 200);
});

test('accept: 失効・期限切れ・上限超過は 410(理由別の code)で参加しない', { skip }, async () => {
  const { admin, org } = mkOrg();
  const rev = await mkInvite(org, admin);
  await call('POST', `/api/orgs/${org.id}/invites/${rev.id}/revoke`, admin.tok);
  const exp = await mkInvite(org, admin, { expiresInDays: 1 });
  const full = await mkInvite(org, admin, { maxUses: 1 });
  await call('POST', `/api/invites/${full.code}/accept`, mkUser().tok);
  clock += 2 * DAY;
  try {
    for (const [inv, code] of [[rev, 'invite_revoked'], [exp, 'invite_expired'], [full, 'invite_exhausted']]) {
      const u = mkUser();
      const r = await call('POST', `/api/invites/${inv.code}/accept`, u.tok);
      assert.equal(r.status, 410, code);
      assert.equal((await r.json()).error.code, code);
      assert.equal(accounts.isMember(org.id, u.user.id), false);
    }
  } finally { clock -= 2 * DAY; }
});

test('accept: 既参加者は失効・期限切れ・上限超過の招待でも 200(use_count 不変。既参加の判定が先)', { skip }, async () => {
  const { admin, org } = mkOrg();
  const rev = await mkInvite(org, admin);
  const exp = await mkInvite(org, admin, { expiresInDays: 1 });
  const full = await mkInvite(org, admin, { maxUses: 1 });
  await call('POST', `/api/invites/${full.code}/accept`, mkUser().tok);
  const member = mkUser();
  accounts.linkMember({ orgId: org.id, userId: member.user.id, rosterId: null, now: clock });
  await call('POST', `/api/orgs/${org.id}/invites/${rev.id}/revoke`, admin.tok);
  clock += 2 * DAY;
  try {
    for (const inv of [rev, exp, full]) {
      const before = accounts.getInvite(inv.id).use_count;
      const r = await call('POST', `/api/invites/${inv.code}/accept`, member.tok);
      assert.equal(r.status, 200, inv.id);
      assert.deepEqual(await r.json(), { orgId: org.id });
      assert.equal(accounts.getInvite(inv.id).use_count, before);
    }
  } finally { clock -= 2 * DAY; }
});

test('repo: 再判定が valid でも invite_valid(410)にせず、再試行して参加できる', { skip }, async () => {
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  const { admin, org } = mkOrg();
  const inv = accounts.createInvite({ orgId: org.id, createdByUserId: admin.user.id, now: clock });
  const flaky = (failures) => {
    let left = failures;
    return new Proxy(db, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        if (k !== 'prepare') return v.bind(t);
        return (sql) => {
          const st = t.prepare(sql);
          if (!/UPDATE org_invites SET use_count/.test(sql) || left <= 0) return st;
          return { run: (...a) => { if (left > 0) { left -= 1; return { changes: 0 }; } return st.run(...a); }, all: (...a) => st.all(...a), get: (...a) => st.get(...a) };
        };
      },
    });
  };
  const u1 = mkUser();
  const r1 = createAccountsRepo({ db: flaky(1) }).acceptInvite({ code: inv.code, userId: u1.user.id, now: clock });
  assert.equal(r1.status, 'joined');
  assert.equal(accounts.getInvite(inv.id).use_count, 1);
  assert.equal(accounts.isMember(org.id, u1.user.id), true);
  // 2回続けて失敗しても 'valid' は返さず例外(参加も加算も残らない)
  const u2 = mkUser();
  assert.throws(() => createAccountsRepo({ db: flaky(2) }).acceptInvite({ code: inv.code, userId: u2.user.id, now: clock }));
  assert.equal(accounts.getInvite(inv.id).use_count, 1);
  assert.equal(accounts.isMember(org.id, u2.user.id), false);
});

test('accept: 同時に上限を超えて参加できない', { skip }, async () => {
  const { admin, org } = mkOrg();
  const inv = await mkInvite(org, admin, { maxUses: 2 });
  const users = Array.from({ length: 6 }, () => mkUser());
  const rs = await Promise.all(users.map((u) => call('POST', `/api/invites/${inv.code}/accept`, u.tok)));
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 410, 410, 410, 410]);
  assert.equal(accounts.getInvite(inv.id).use_count, 2);
});
