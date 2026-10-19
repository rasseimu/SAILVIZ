// test/server-orgs-api.test.js — POST /api/orgs(組織の作成)。合成データのみ。node:sqlite が要る(Node 24)。
// 各テストは自分専用のユーザーを作る(回数制限・上限は本人ごとなので、テスト間で状態を共有しない)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
const hasSqlite = major >= 24;
const skip = hasSqlite ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
const HOUR = 60 * 60 * 1000;

let server, base, db, accounts, clock, issueAuthToken;
let failServer, failBase, failLink = false;
let seq = 0;

// 確認済み(または未確認)のユーザーと、そのトークンを作る。
const mkUser = (verified = true) => {
  seq += 1;
  const u = accounts.createUser({ email: `t${seq}@example.test`, name: `T${seq}`, passwordHash: 'x', now: clock });
  if (verified) accounts.markEmailVerified(u.id, clock);
  return { user: u, tok: issueAuthToken(accounts, u.id, clock).token };
};
const postTo = (url, body, tok, raw) => fetch(`${url}/api/orgs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: raw ?? JSON.stringify(body),
});
const post = (body, tok, raw) => postTo(base, body, tok, raw);
const listen = async (api) => {
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
};

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
  const authOptions = { now: () => clock };
  server = await listen(createApi({ repo: {}, token: 'shared-secret', accounts, authOptions }));
  base = `http://127.0.0.1:${server.address().port}`;
  // linkMember だけ失敗させられる版(巻き戻しの確認用)
  const flaky = Object.create(accounts);
  flaky.linkMember = (...a) => {
    if (failLink) throw new Error('linkMember failed (test)');
    return accounts.linkMember(...a);
  };
  failServer = await listen(createApi({ repo: {}, token: 'shared-secret', accounts: flaky, authOptions }));
  failBase = `http://127.0.0.1:${failServer.address().port}`;
});
after(async () => {
  if (!hasSqlite) return;
  await new Promise((r) => server.close(r));
  await new Promise((r) => failServer.close(r));
  db.close();
});

test('未認証は 401、不正なトークンも 401', { skip }, async () => {
  const r = await post({ name: 'A' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
  assert.equal((await post({ name: 'A' }, 'bogus')).status, 401);
});

test('共有トークンはアカウントではないので 401(S2.3 の requireUser と同じ)', { skip }, async () => {
  assert.equal((await post({ name: 'A' }, 'shared-secret')).status, 401);
});

test('メール未確認は 403', { skip }, async () => {
  const { user, tok } = mkUser(false);
  const r = await post({ name: 'A' }, tok);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'email_not_verified');
  assert.equal(accounts.countOrgsAdministeredBy(user.id), 0);
});

test('名前が空・長すぎ・非文字列・本文なし・壊れた JSON は 422', { skip }, async () => {
  const { user, tok } = mkUser();
  for (const body of [{ name: '' }, { name: '   ' }, { name: 'あ'.repeat(81) }, { name: 5 }, {}]) {
    const r = await post(body, tok);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal((await r.json()).error.code, 'invalid_name');
  }
  assert.equal((await post(null, tok, '{bad')).status, 422);
  assert.equal(accounts.countOrgsAdministeredBy(user.id), 0);
});

test('制御文字(C0・DEL・C1)・向きを変える文字を含む名前は 422', { skip }, async () => {
  const { user, tok } = mkUser();
  const cc = (...cps) => `a${String.fromCodePoint(...cps)}b`; // 見えない文字を符号位置で書く
  const bad = [cc(0x00), cc(0x0a), cc(0x7f), cc(0x85), cc(0x9f), cc(0x202e), cc(0x2066), cc(0x200f)];
  for (const name of bad) {
    const r = await post({ name }, tok);
    assert.equal(r.status, 422, JSON.stringify(name));
    assert.equal((await r.json()).error.code, 'invalid_name');
  }
  assert.equal(accounts.countOrgsAdministeredBy(user.id), 0);
  assert.equal((await post({ name: '芝浦 セーリング部' }, tok)).status, 201); // 普通の名前は通る
});

test('成功は 201 で { org }。作成者は管理者かつメンバー(名簿には紐付かない)', { skip }, async () => {
  const { user, tok } = mkUser();
  const r = await post({ name: '  テスト部 ' }, tok);
  assert.equal(r.status, 201);
  const { org } = await r.json();
  assert.match(org.id, /^o_/);
  assert.equal(org.name, 'テスト部');
  assert.equal(org.createdAt, clock);
  assert.equal(accounts.isOrgAdmin(org.id, user.id), true);
  assert.equal(accounts.isMember(org.id, user.id), true);
  assert.equal(accounts.listMembers(org.id)[0].roster_id, null);
  assert.deepEqual(accounts.listRoster(org.id), []);
});

test('上限 5 件を超えると 409(上限は作成成功の数で決まる)', { skip }, async () => {
  const { user, tok } = mkUser();
  for (let i = 0; i < 5; i += 1) {
    clock += 1000;
    assert.equal((await post({ name: `org${i}` }, tok)).status, 201);
  }
  clock += 1000;
  const over = await post({ name: 'over' }, tok);
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, 'org_limit_reached');
  assert.equal(accounts.countOrgsAdministeredBy(user.id), 5);
});

test('回数制限は 10 回で 429(Retry-After 付き)、窓が過ぎれば戻る。他のユーザーには及ばない', { skip }, async () => {
  const { tok } = mkUser();
  const other = mkUser();
  for (let i = 0; i < 10; i += 1) assert.equal((await post({ name: '' }, tok)).status, 422); // 失敗も数える
  const r = await post({ name: 'ok' }, tok);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, 'rate_limited');
  const ra = r.headers.get('retry-after');
  assert.match(ra, /^\d+$/);
  assert.ok(Number(ra) >= 1 && Number(ra) <= 3600, `retry-after=${ra}`);
  assert.equal((await post({ name: 'ok' }, other.tok)).status, 201);
  clock += 2 * HOUR;
  assert.equal((await post({ name: 'ok' }, tok)).status, 201);
});

test('linkMember が失敗したら組織・管理者の作成も巻き戻る(部分的な組織を残さない)', { skip }, async () => {
  const { user, tok } = mkUser();
  const orgsBefore = db.prepare('SELECT COUNT(*) AS n FROM orgs').get().n;
  failLink = true;
  try {
    const r = await postTo(failBase, { name: '巻き戻し' }, tok);
    assert.ok(r.status >= 500, `status=${r.status}`);
  } finally { failLink = false; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orgs').get().n, orgsBefore);
  assert.equal(accounts.countOrgsAdministeredBy(user.id), 0);
  assert.equal(db.isTransaction, false);
  assert.equal((await postTo(failBase, { name: '再試行' }, tok)).status, 201); // 次は通る
});

test('組織名にゼロ幅文字・タグ文字 → 422 invalid_name', { skip }, async () => {
  const { tok } = mkUser();
  for (const ch of ['\u{200b}', '\u{2060}', '\u{feff}', '\u{e0067}']) {
    const r = await post({ name: `部${ch}名` }, tok);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'invalid_name');
  }
});

test('500 の本文に内部の例外メッセージを出さない(汎用メッセージ・詳細はサーバログのみ)', { skip }, async () => {
  const { tok } = mkUser();
  const secret = 'SECRET-internal-detail';
  const boom = Object.create(accounts);
  boom.countOrgsAdministeredBy = () => { throw new Error(secret); };
  const s = await listen(createApi({ repo: {}, token: 'shared-secret', accounts: boom, authOptions: { now: () => clock } }));
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const r = await postTo(`http://127.0.0.1:${s.address().port}`, { name: '内部エラー' }, tok);
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.equal(text.includes(secret), false);
    assert.deepEqual(JSON.parse(text), { error: 'internal_error' });
    assert.ok(logged.some((l) => l.includes('-> 500: Error')), 'ログには例外名とフレームが残る');
    assert.equal(logged.some((l) => l.includes(secret)), false, 'ログにも e.message は出さない');
  } finally {
    console.error = orig;
    await new Promise((r) => s.close(r));
  }
});

test('壊れた JSON は 500 にならず 400、ログに本文の断片が出ない(旧 API 経路)', { skip }, async () => {
  const frag = 'hunter2x';
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const r = await fetch(`${base}/api/sensor-imports`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shared-secret' },
      body: `{"password":"${frag}}`,
    });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: 'bad json' });
    assert.equal(text.includes(frag), false);
    assert.equal(logged.some((l) => l.includes(frag)), false);
  } finally {
    console.error = orig;
  }
});

test('GET /api/orgs は未対応(404)', { skip }, async () => {
  const { tok } = mkUser();
  const r = await fetch(`${base}/api/orgs`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 404);
});

test('accounts 無し(STORAGE=file)は /api/orgs 配下のどれも 503', async () => {
  const s = await listen(createApi({ repo: {}, token: 't' }));
  try {
    const u = `http://127.0.0.1:${s.address().port}`;
    for (const [m, p] of [['POST', '/api/orgs'], ['GET', '/api/orgs'], ['GET', '/api/orgs/o_x'], ['POST', '/api/orgs/o_x/roster'],
      ['GET', '/api/invites/abc'], ['POST', '/api/invites/abc/accept']]) {
      const r = await fetch(u + p, { method: m, body: m === 'POST' ? '{"name":"a"}' : undefined });
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.equal((await r.json()).error.code, 'accounts_unavailable');
    }
  } finally { await new Promise((r) => s.close(r)); }
});
