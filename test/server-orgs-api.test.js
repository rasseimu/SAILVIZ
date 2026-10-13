// test/server-orgs-api.test.js — POST /api/orgs(組織の作成)。合成データのみ。node:sqlite が要る(Node 24)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
const hasSqlite = major >= 24;
const skip = hasSqlite ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let server, base, db, accounts, clock, verified, unverified, vTok, uTok;
let issueAuthToken;

const post = (body, tok, raw) => fetch(`${base}/api/orgs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: raw ?? JSON.stringify(body),
});

before(async () => {
  if (!hasSqlite) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  ({ issueAuthToken } = await import('../server/accountAuth.js'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  accounts = createAccountsRepo({ db });
  clock = 1_000_000;
  verified = accounts.createUser({ email: 'v@example.test', name: 'V', passwordHash: 'x', now: clock });
  accounts.markEmailVerified(verified.id, clock);
  unverified = accounts.createUser({ email: 'u@example.test', name: 'U', passwordHash: 'x', now: clock });
  vTok = issueAuthToken(accounts, verified.id, clock).token;
  uTok = issueAuthToken(accounts, unverified.id, clock).token;
  const api = createApi({ repo: {}, token: 'shared-secret', accounts, now: () => clock });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (!hasSqlite) return;
  await new Promise((r) => server.close(r));
  db.close();
});

test('未認証は 401、不正なトークンも 401', { skip }, async () => {
  const r = await post({ name: 'A' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
  assert.equal((await post({ name: 'A' }, 'bogus')).status, 401);
});

test('共有トークンはアカウントではないので 403', { skip }, async () => {
  assert.equal((await post({ name: 'A' }, 'shared-secret')).status, 403);
});

test('メール未確認は 403', { skip }, async () => {
  const r = await post({ name: 'A' }, uTok);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'email_not_verified');
  assert.equal(accounts.countOrgsAdministeredBy(unverified.id), 0);
});

test('名前が空・長すぎ・非文字列・本文なし・壊れた JSON は 422', { skip }, async () => {
  for (const body of [{ name: '' }, { name: '   ' }, { name: 'あ'.repeat(81) }, { name: 5 }, {}]) {
    const r = await post(body, vTok);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal((await r.json()).error.code, 'invalid_name');
  }
  assert.equal((await post(null, vTok, '{bad')).status, 422);
  assert.equal(accounts.countOrgsAdministeredBy(verified.id), 0);
});

test('成功は 201 で { org }。作成者は管理者かつメンバー(名簿には紐付かない)', { skip }, async () => {
  clock += 2 * 60 * 60 * 1000; // 直前の 422 の試行(回数制限に数える)を窓の外へ
  const r = await post({ name: '  テスト部 ' }, vTok);
  assert.equal(r.status, 201);
  const { org } = await r.json();
  assert.match(org.id, /^o_/);
  assert.equal(org.name, 'テスト部');
  assert.equal(org.createdAt, clock);
  assert.equal(accounts.isOrgAdmin(org.id, verified.id), true);
  assert.equal(accounts.isMember(org.id, verified.id), true);
  assert.equal(accounts.listMembers(org.id)[0].roster_id, null);
  assert.deepEqual(accounts.listRoster(org.id), []);
});

test('上限 5 件を超えると 409、回数制限を超えると 429、窓が過ぎれば戻る', { skip }, async () => {
  // 既に 1 件作成済み(前のテスト)。あと 4 件で上限。
  for (let i = 0; i < 4; i += 1) {
    clock += 1000;
    assert.equal((await post({ name: `org${i}` }, vTok)).status, 201);
  }
  clock += 1000;
  const over = await post({ name: 'over' }, vTok);
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, 'org_limit_reached');
  assert.equal(accounts.countOrgsAdministeredBy(verified.id), 5);
  // 窓内の試行は 成功1+成功4+409 の6回。残り4回で 10 回に達して 429 になる。
  let last;
  for (let i = 0; i < 10; i += 1) { clock += 1000; last = await post({ name: 'x' }, vTok); if (last.status === 429) break; }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'rate_limited');
  clock += 2 * 60 * 60 * 1000;
  assert.equal((await post({ name: 'x' }, vTok)).status, 409); // 窓が過ぎて制限は解け、上限だけが残る
});

test('GET は 405', { skip }, async () => {
  const r = await fetch(`${base}/api/orgs`, { headers: { authorization: `Bearer ${vTok}` } });
  assert.equal(r.status, 405);
});

test('accounts 無し(STORAGE=file)は 503', async () => {
  const api = createApi({ repo: {}, token: 't' });
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/orgs`, { method: 'POST', body: '{"name":"a"}' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'accounts_unavailable');
  } finally { await new Promise((r) => s.close(r)); }
});
