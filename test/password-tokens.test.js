// test/password-tokens.test.js
// scrypt パスワード・トークン・Bearer 抽出・アカウントトークンの照合(S2.2)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  hashPassword, verifyPassword, needsRehash, validatePassword, SCRYPT_PARAMS,
} from '../server/domain/password.js';
import { generateToken, hashToken, TOKEN_BYTES, AUTH_TOKEN_TTL_MS } from '../server/domain/tokens.js';
import { extractBearer, extractAuth, extractToken } from '../server/auth.js';
import {
  issueAuthToken, authenticateToken, revokeToken, issueEmailToken, consumeEmailToken, resolveIdentity,
} from '../server/accountAuth.js';

const FAST = { N: 1024, r: 8, p: 1, keyLen: 32, saltLen: 16 }; // テストを速くするため

test('hashPassword: 形式にパラメータとソルトを含み、同じ入力でも毎回違う', async () => {
  const a = await hashPassword('correct horse', FAST);
  const b = await hashPassword('correct horse', FAST);
  assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes('correct horse'));
});

test('verifyPassword: 一致 true / 不一致・壊れた保存値 false', async () => {
  const h = await hashPassword('pass-word-1', FAST);
  assert.equal(await verifyPassword('pass-word-1', h), true);
  assert.equal(await verifyPassword('pass-word-2', h), false);
  for (const bad of [null, '', 'x', 'bcrypt$1$2$3$a$b', 'scrypt$1000$8$1$aa$bb', 'scrypt$2147483648$8$1$aa$bb', 'scrypt$1024$8$1$$']) {
    assert.equal(await verifyPassword('pass-word-1', bad), false);
  }
  assert.equal(await verifyPassword(undefined, h), false);
});

test('verifyPassword: 現行パラメータ(本番値)で往復できる', async () => {
  const h = await hashPassword('日本語のパスワード');
  assert.ok(h.startsWith(`scrypt$${SCRYPT_PARAMS.N}$`));
  assert.equal(await verifyPassword('日本語のパスワード', h), true);
  assert.equal(needsRehash(h), false);
});

test('S2.2-P3 本番値は N=2^15・r=8・p=3。保存形式にパラメータが入る', async () => {
  assert.deepEqual([SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p], [32768, 8, 3]);
  const h = await hashPassword('pass-word-1');
  assert.match(h, /^scrypt\$32768\$8\$3\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('pass-word-1', h), true);
  assert.equal(needsRehash(h), false);
});

test('S2.2-P3 既存の p=1 ハッシュは保存されたパラメータで照合でき、needsRehash=true(p=3 で作り直せる)', async () => {
  const p1 = { N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16 };
  const old = await hashPassword('pass-word-1', p1);
  assert.match(old, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('pass-word-1', old), true);
  assert.equal(await verifyPassword('wrong-pass-1', old), false);
  assert.equal(needsRehash(old), true);
  const fresh = await hashPassword('pass-word-1');
  assert.equal(needsRehash(fresh), false);
});

test('verifyPassword: 1024 文字を超える入力は scrypt を呼ばずに false', async () => {
  const h = await hashPassword('pass-word-1', FAST);
  assert.equal(await verifyPassword('x'.repeat(1025), h), false);
  // scrypt が走らないこと: 重いパラメータで、長すぎる入力は通常の不一致より桁違いに速く返る
  const heavy = await hashPassword('pass-word-1', { N: 32768, r: 8, p: 1, keyLen: 32, saltLen: 16 });
  const t0 = process.hrtime.bigint();
  assert.equal(await verifyPassword('wrong-pass-1', heavy), false);
  const tWrong = process.hrtime.bigint() - t0;
  const t1 = process.hrtime.bigint();
  assert.equal(await verifyPassword('x'.repeat(1025), heavy), false);
  const tLong = process.hrtime.bigint() - t1;
  assert.ok(tLong * 4n < tWrong, `long=${tLong} wrong=${tWrong}`);
});

test('verifyPassword: r=1 かつ N>=65536 の保存値(OpenSSL が拒否)は例外でなく false', async () => {
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA';
  const hash = 'A'.repeat(43);
  assert.equal(await verifyPassword('pass-word-1', `scrypt$65536$1$1$${salt}$${hash}`), false);
  assert.equal(await verifyPassword('pass-word-1', `scrypt$131072$1$1$${salt}$${hash}`), false);
  assert.equal(needsRehash(`scrypt$65536$1$1$${salt}$${hash}`), true);
});

test('verifyPassword: NFKC で同じになる入力(全角/半角 ASCII)は一致する', async () => {
  const h = await hashPassword('pass-word-1', FAST);
  assert.equal(await verifyPassword('ｐａｓｓ－ｗｏｒｄ－１', h), true);
});

test('verifyPassword: 保存値のパラメータ・hash 長が上限を超えれば例外でなく false', async () => {
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA';
  const hash = 'A'.repeat(43);
  for (const bad of [
    `scrypt$1024$64$1$${salt}$${hash}`, // r 上限超
    `scrypt$1024$8$32$${salt}$${hash}`, // p 上限超
    `scrypt$1048576$8$1$${salt}$${hash}`, // N 上限超
    `scrypt$32768$8$6$${salt}$${hash}`, // 作業量 128*N*r*p = 192MiB > 128MiB(p=4 までは許す)
    `scrypt$524288$8$1$${salt}$${hash}`, // メモリ 128*N*r = 512MiB > 64MiB
    `scrypt$1024$8$1$${salt}$${'A'.repeat(100)}`, // hash 長 75 バイト > 64
  ]) {
    assert.equal(await verifyPassword('pass-word-1', bad), false, bad);
  }
});

test('verifyPassword: 上限ちょうどのパラメータは受け付ける(作業量 128MiB・メモリ 64MiB)', async () => {
  for (const params of [
    { N: 32768, r: 8, p: 4, keyLen: 32, saltLen: 16 }, // 128*N*r*p = 128MiB(MAX_COST_BYTES ちょうど)
    { N: 65536, r: 8, p: 1, keyLen: 32, saltLen: 16 }, // 128*N*r = 64MiB(MAX_MEM_BYTES ちょうど)
  ]) {
    const h = await hashPassword('pass-word-1', params);
    assert.ok(h.startsWith(`scrypt$${params.N}$${params.r}$${params.p}$`), h);
    assert.equal(await verifyPassword('pass-word-1', h), true, h);
    assert.equal(await verifyPassword('wrong-pass-1', h), false, h);
  }
});

test('needsRehash: パラメータが古い・壊れていれば true(強度を後から上げられる)', async () => {
  const old = await hashPassword('pass-word-1', FAST);
  assert.equal(needsRehash(old), true);
  assert.equal(needsRehash(old, FAST), false);
  assert.equal(needsRehash('garbage'), true);
  assert.equal(await verifyPassword('pass-word-1', old), true); // 旧パラメータでも照合できる
});

test('validatePassword: 8文字以上', () => {
  assert.equal(validatePassword('1234567').ok, false);
  assert.equal(validatePassword('12345678').ok, true);
  assert.equal(validatePassword('あいうえおかきく').ok, true);
  assert.equal(validatePassword(12345678).ok, false);
  assert.equal(validatePassword('x'.repeat(2000)).ok, false);
});

test('generateToken / hashToken', () => {
  const t = generateToken();
  assert.ok(Buffer.from(t, 'base64url').length >= 32);
  assert.equal(TOKEN_BYTES, 32);
  assert.notEqual(t, generateToken());
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(t), hashToken(t));
  assert.notEqual(hashToken(t), t);
});

test('extractBearer / extractAuth: Bearer を優先し Cookie と共存、extractToken は不変', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractBearer({ headers: { authorization: 'bearer   abc  ' } }), 'abc');
  assert.equal(extractBearer({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Bearer a b' } }), null);
  assert.equal(extractBearer({ headers: { cookie: 'sailviz_token=c' } }), null);
  assert.deepEqual(extractAuth({ headers: { authorization: 'Bearer abc', cookie: 'sailviz_token=c' } }), { token: 'abc', source: 'bearer' });
  assert.deepEqual(extractAuth({ headers: { cookie: 'sailviz_session=s' } }), { token: 's', source: 'cookie' });
  // アカウントの Cookie は旧共有ログインの sailviz_token と別名(両方あれば session を優先)
  assert.deepEqual(extractAuth({ headers: { cookie: 'sailviz_token=c; sailviz_session=s' } }), { token: 's', source: 'cookie' });
  assert.deepEqual(extractAuth({ headers: { cookie: 'sailviz_token=c' } }), { token: 'c', source: 'legacy-cookie' });
  assert.deepEqual(extractAuth({ headers: {} }), { token: null, source: null });
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc', cookie: 'sailviz_token=c' } }), 'abc');
});

test('extractAuth: 不正な Bearer と Cookie 併用は Cookie にフォールバック(extractToken は "a b")', () => {
  const req = { headers: { authorization: 'Bearer a b', cookie: 'sailviz_token=c' } };
  assert.deepEqual(extractAuth(req), { token: 'c', source: 'legacy-cookie' });
  assert.equal(extractToken(req), 'a b');
  assert.deepEqual(extractAuth({ headers: { authorization: 'Bearer a b' } }), { token: null, source: null });
});

// ---- DB を使う部分(Node 24) ----
const [major] = process.versions.node.split('.').map(Number);
const hasSqlite = major >= 24;
const skip = hasSqlite ? undefined : 'node:sqlite の isTransaction が要る(Node >=24)';
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
  const repo = createAccountsRepo({ db });
  const user = repo.createUser({ email: 'a@example.test', name: 'テスト太郎', passwordHash: 'x' });
  return { db, repo, user };
}
const T0 = 1_700_000_000_000;

test('issueAuthToken: DB にはハッシュだけ、期限は60日後', { skip }, () => {
  const { db, repo, user } = setup();
  const { token, expiresAt } = issueAuthToken(repo, user.id, T0);
  assert.equal(expiresAt, T0 + AUTH_TOKEN_TTL_MS);
  const rows = db.prepare('SELECT * FROM auth_tokens').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashToken(token));
  assert.ok(!JSON.stringify(rows[0]).includes(token));
});

test('authenticateToken: 有効なら user を返し、最終使用から60日にスライド', { skip }, () => {
  const { repo, user } = setup();
  const { token, id } = issueAuthToken(repo, user.id, T0);
  const day = 24 * 60 * 60 * 1000;
  const hit = authenticateToken(repo, token, T0 + 50 * day);
  assert.equal(hit.user.id, user.id);
  assert.equal(hit.tokenId, id);
  const row = repo.getAuthTokenByHash(hashToken(token));
  assert.equal(row.last_used_at, T0 + 50 * day);
  assert.equal(row.expires_at, T0 + 110 * day);
  // 元の期限(T0+60日)を過ぎても、スライド済みなので有効
  assert.ok(authenticateToken(repo, token, T0 + 100 * day));
});

test('authenticateToken: 期限切れ・失効・未知・削除済みユーザーは null', { skip }, () => {
  const { repo, user } = setup();
  const day = 24 * 60 * 60 * 1000;
  const a = issueAuthToken(repo, user.id, T0);
  assert.equal(authenticateToken(repo, a.token, T0 + 60 * day), null); // 期限ちょうど
  const b = issueAuthToken(repo, user.id, T0);
  assert.equal(revokeToken(repo, b.token, T0 + 1), true);
  assert.equal(revokeToken(repo, b.token, T0 + 2), false);
  assert.equal(authenticateToken(repo, b.token, T0 + 3), null);
  assert.equal(authenticateToken(repo, 'unknown', T0), null);
  assert.equal(authenticateToken(repo, '', T0), null);
  const c = issueAuthToken(repo, user.id, T0);
  repo.markUserDeleted(user.id, T0 + 5);
  assert.equal(authenticateToken(repo, c.token, T0 + 6), null);
});

test('全端末ログアウト(revokeAllAuthTokens)で全トークンが無効', { skip }, () => {
  const { repo, user } = setup();
  const a = issueAuthToken(repo, user.id, T0);
  const b = issueAuthToken(repo, user.id, T0);
  assert.equal(repo.revokeAllAuthTokens(user.id, T0 + 1), 2);
  assert.equal(authenticateToken(repo, a.token, T0 + 2), null);
  assert.equal(authenticateToken(repo, b.token, T0 + 2), null);
});

test('メールトークン: 目的一致・一度きり・期限内', { skip }, () => {
  const { repo, user } = setup();
  const v = issueEmailToken(repo, { userId: user.id, purpose: 'verify', now: T0 });
  assert.equal(consumeEmailToken(repo, v.token, 'reset', T0 + 1), null); // 目的違いは消費しない
  assert.deepEqual(consumeEmailToken(repo, v.token, 'verify', T0 + 1), { userId: user.id, newEmail: null });
  assert.equal(consumeEmailToken(repo, v.token, 'verify', T0 + 2), null); // 二重使用
  const r = issueEmailToken(repo, { userId: user.id, purpose: 'reset', now: T0 });
  assert.equal(consumeEmailToken(repo, r.token, 'reset', r.expiresAt), null); // 期限切れ
  const c = issueEmailToken(repo, { userId: user.id, purpose: 'change', newEmail: 'b@example.test', now: T0 });
  assert.equal(consumeEmailToken(repo, c.token, 'change', T0 + 1).newEmail, 'b@example.test');
  assert.throws(() => issueEmailToken(repo, { userId: user.id, purpose: 'bogus' }));
});

test('resolveIdentity: 共有トークン・アカウントのトークン・どちらでもない', { skip }, () => {
  const { repo, user } = setup();
  const { token } = issueAuthToken(repo, user.id, T0);
  const opts = { writeToken: 'dummy-write', repo, now: T0 + 1 };
  assert.deepEqual(resolveIdentity({ headers: { authorization: 'Bearer dummy-write' } }, opts), { kind: 'shared' });
  assert.deepEqual(resolveIdentity({ headers: { cookie: 'sailviz_token=dummy-write' } }, opts), { kind: 'shared' });
  const u = resolveIdentity({ headers: { authorization: `Bearer ${token}` } }, opts);
  assert.equal(u.kind, 'user');
  assert.equal(u.user.id, user.id);
  // Web のアカウントは Cookie sailviz_session。旧共有の Cookie と同居しても両方判定できる
  const w = resolveIdentity({ headers: { cookie: `sailviz_session=${token}` } }, opts);
  assert.equal(w.kind, 'user');
  assert.deepEqual(resolveIdentity({ headers: { cookie: `sailviz_session=${token}; sailviz_token=dummy-write` } }, opts), { kind: 'shared' });
  assert.equal(resolveIdentity({ headers: { cookie: `sailviz_token=${token}` } }, opts), null); // アカウントのトークンを旧 Cookie 名では受けない
  assert.equal(resolveIdentity({ headers: { authorization: 'Bearer nope' } }, opts), null);
  assert.equal(resolveIdentity({ headers: {} }, opts), null);
  // 書込トークン未設定でも、空トークンが共有扱いにならない
  assert.equal(resolveIdentity({ headers: { authorization: 'Bearer x' } }, { repo, now: T0 }), null);
  // repo 無しなら共有トークンだけ
  assert.equal(resolveIdentity({ headers: { authorization: `Bearer ${token}` } }, { writeToken: 'dummy-write' }), null);
});
