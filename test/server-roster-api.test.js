// test/server-roster-api.test.js — 名簿 API と照合の通し(§10.3・§4.4)。合成データのみ。Node 24 が要る。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let server, base, db, accounts, clock, issueAuthToken, issueEmailToken;
let admin, adminTok, member, memberTok, outsider, outsiderTok, org;
const sentMails = [];

const call = (method, path, tok, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});
const mk = (email, name, verified = true) => {
  const u = accounts.createUser({ email, name, passwordHash: 'x', now: clock });
  if (verified) accounts.markEmailVerified(u.id, clock);
  return { u, tok: issueAuthToken(accounts, u.id, clock).token };
};

before(async () => {
  if (skip) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  ({ issueAuthToken, issueEmailToken } = await import('../server/accountAuth.js'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  accounts = createAccountsRepo({ db });
  clock = 1_000_000;
  ({ u: admin, tok: adminTok } = mk('admin@example.test', '管理者'));
  ({ u: member, tok: memberTok } = mk('m@example.test', '部員'));
  ({ u: outsider, tok: outsiderTok } = mk('out@example.test', '部外者'));
  org = accounts.createOrg({ name: 'テスト部', adminUserIds: [admin.id], now: clock });
  accounts.linkMember({ orgId: org.id, userId: admin.id, rosterId: null, now: clock });
  const mailer = { send: async (m) => { sentMails.push(m); } };
  const api = createApi({
    repo: {}, token: 'shared-secret', accounts, mailer, baseUrl: 'http://x.test', authOptions: { now: () => clock },
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

const R = () => `/api/orgs/${org.id}/roster`;

test('認可: 未認証 401・共有トークン 401・非管理者 403・存在しない組織 404(GET/PUT 共通)', { skip }, async () => {
  for (const [m, body] of [['GET'], ['PUT', { roster: [] }]]) {
    assert.equal((await call(m, R(), null, body)).status, 401);
    assert.equal((await call(m, R(), 'shared-secret', body)).status, 401);
    const r = await call(m, R(), memberTok, body);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'forbidden');
    assert.equal((await call(m, '/api/orgs/o_nope/roster', adminTok, body)).status, 404);
  }
});

test('PUT: 不正な入力は 422(roster が配列でない・氏名なし・メール不正・重複)', { skip }, async () => {
  for (const body of [{}, { roster: 'x' }, { roster: [{ email: 'a@example.test' }] },
    { roster: [{ name: 'A', email: 'bad' }] },
    { roster: [{ name: 'A', email: 'a@example.test' }, { name: 'B', email: 'A@example.test' }] }]) {
    const r = await call('PUT', R(), adminTok, body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
  assert.equal((await call('PUT', R(), adminTok, '{bad')).status, 422);
  assert.deepEqual(accounts.listRoster(org.id), []);
});

test('PUT: 提出→確認済みユーザーが紐付く・未確認は紐付かない。GET に linkedUserId が出る', { skip }, async () => {
  const unv = mk('unv@example.test', '未確認', false);
  const r = await call('PUT', R(), adminTok, { roster: [
    { name: '部員', email: 'M@Example.test', legacyName: '旧部員' },
    { name: '未確認', email: 'unv@example.test' },
    { name: '未登録', email: 'nobody@example.test' },
  ] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.linked, [{ userId: member.id, name: '部員' }]);
  assert.deepEqual(j.unlinked, []);
  const g = await (await call('GET', R(), adminTok)).json();
  assert.deepEqual(g.roster.map((x) => [x.name, x.email, x.legacyName, x.linkedUserId]), [
    ['部員', 'm@example.test', '旧部員', member.id],
    ['未確認', 'unv@example.test', null, null],
    ['未登録', 'nobody@example.test', null, null],
  ]);
  // 冪等: 同じ内容をもう一度 → 新規リンクなし
  const again = await (await call('PUT', R(), adminTok, { roster: g.roster })).json();
  assert.deepEqual(again, { linked: [], unlinked: [] });
  // 未確認ユーザーがメール確認 → 自動で紐付く(verify-email 経路)
  const t = issueEmailToken(accounts, { userId: unv.u.id, purpose: 'verify', newEmail: unv.u.email, now: clock });
  const v = await call('POST', '/api/auth/verify-email', null, { verifyToken: t.token });
  assert.equal(v.status, 200);
  assert.equal(accounts.isMember(org.id, unv.u.id), true);
});

test('GET /members: 組織メンバーは見られる(紐付け済み・{userId,name})。非メンバーは 403', { skip }, async () => {
  const r = await call('GET', `/api/orgs/${org.id}/members`, memberTok);
  assert.equal(r.status, 200);
  const ids = (await r.json()).members.map((x) => x.userId);
  assert.ok(ids.includes(member.id) && ids.includes(admin.id));
  assert.equal((await call('GET', `/api/orgs/${org.id}/members`, outsiderTok)).status, 403);
  assert.equal((await call('GET', `/api/orgs/${org.id}/members`, null)).status, 401);
  assert.equal((await call('GET', '/api/orgs/o_nope/members', memberTok)).status, 404);
});

test('名簿から外すと解除(unlinked)。作成者・管理者は残り、旧メンバーは members から消える', { skip }, async () => {
  const r = await call('PUT', R(), adminTok, { roster: [{ name: '未登録', email: 'nobody@example.test' }] });
  const j = await r.json();
  assert.deepEqual(j.unlinked.map((x) => x.userId).sort(), [member.id, accounts.getUserByEmail('unv@example.test').id].sort());
  assert.equal(accounts.isMember(org.id, member.id), false);
  assert.equal(accounts.isMember(org.id, admin.id), true);
  assert.equal((await call('GET', `/api/orgs/${org.id}/members`, memberTok)).status, 403);
});

test('メール確認後に名簿へ追加された場合も PUT で紐付く(名簿更新時の照合)', { skip }, async () => {
  const r = await (await call('PUT', R(), adminTok, { roster: [{ name: '部員', email: 'm@example.test' }] })).json();
  assert.deepEqual(r.linked, [{ userId: member.id, name: '部員' }]);
});

test('名簿 GET/PUT・members に対応しないメソッドは 404', { skip }, async () => {
  assert.equal((await call('POST', R(), adminTok, {})).status, 404);
  assert.equal((await call('DELETE', R(), adminTok)).status, 404);
});

test('accounts 無し(STORAGE=file)は /api/orgs 配下も 503', async () => {
  const api = createApi({ repo: {}, token: 't' });
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    for (const [m, p] of [['GET', '/api/orgs/o_x/roster'], ['PUT', '/api/orgs/o_x/roster'], ['GET', '/api/orgs/o_x/members']]) {
      const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`, { method: m });
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.equal((await r.json()).error.code, 'accounts_unavailable');
    }
  } finally { await new Promise((r) => s.close(r)); }
});
