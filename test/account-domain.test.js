// test/account-domain.test.js
// 回数制限・入力検証・メールアダプタの純関数テスト(S2.3)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../server/domain/rateLimit.js';
import { validateRegister, validateProfilePatch, isValidEmail, normalizeEmail } from '../server/domain/accountInput.js';
import { buildLink, createLogMailer, createStubMailer, createMailer } from '../server/mail.js';

test('rateLimit: 上限で limited、窓が過ぎれば解除、clear で解除', () => {
  const rl = createRateLimiter({ max: 3, windowMs: 1000 });
  assert.equal(rl.check('k', 0).limited, false);
  rl.record('k', 0); rl.record('k', 100); rl.record('k', 200);
  const r = rl.check('k', 300);
  assert.equal(r.limited, true);
  assert.equal(r.retryAfterMs, 700); // 最古(0)+1000-300
  assert.equal(rl.check('other', 300).limited, false);
  assert.equal(rl.check('k', 1001).limited, false); // 0 の分が窓から出る
  rl.clear('k');
  assert.equal(rl.check('k', 300).limited, false);
});

test('rateLimit: キー数が上限を超えたら古いものから捨てる', () => {
  const rl = createRateLimiter({ max: 1, windowMs: 1000, maxKeys: 3 });
  for (let i = 0; i < 10; i++) rl.record(`k${i}`, 0);
  assert.ok(rl.size <= 3);
});

const okReg = { email: ' A@Example.test ', password: '12345678', name: ' テスト太郎 ', affiliationText: 'テスト部', agreedAt: 1_700_000_000_000 };

test('validateRegister: 正常は正規化した値、欠落・不正は message', () => {
  const v = validateRegister(okReg);
  assert.equal(v.ok, true);
  assert.equal(v.value.email, 'a@example.test');
  assert.equal(v.value.name, 'テスト太郎');
  for (const patch of [{ email: 'x' }, { password: '1234567' }, { name: ' ' }, { affiliationText: '' }, { agreedAt: undefined }, { agreedAt: 'now' }, { agreedAt: 0 }]) {
    const r = validateRegister({ ...okReg, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.message);
  }
  assert.equal(validateRegister(null).ok, false);
});

test('validateProfilePatch: 渡したキーだけ検証、空は不可', () => {
  assert.deepEqual(validateProfilePatch({ name: ' 新 ', defaultVisibility: 'org' }).value, { name: '新', defaultVisibility: 'org' });
  assert.equal(validateProfilePatch({ defaultVisibility: 'everyone' }).ok, false);
  assert.equal(validateProfilePatch({ email: 'bad' }).ok, false);
  assert.equal(validateProfilePatch({}).ok, false);
  assert.equal(validateProfilePatch({ email: 'B@Example.test' }).value.email, 'b@example.test');
});

test('isValidEmail / normalizeEmail', () => {
  assert.equal(isValidEmail('a@example.test'), true);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail('a b@example.test'), false);
  assert.equal(isValidEmail(`${'a'.repeat(250)}@example.test`), false);
  assert.equal(normalizeEmail(undefined), '');
});

test('mail: リンクは Web のページ、トークンは URL エンコード', () => {
  assert.equal(buildLink('https://app.example.test/', 'verify', 'a_b-c'), 'https://app.example.test/verify-email?token=a_b-c');
  assert.equal(buildLink('http://localhost:8000', 'reset', 'x y'), 'http://localhost:8000/reset-password?token=x%20y');
});

test('rateLimit: maxKeys 溢れでは期限切れを先に掃除し、残りは最近動いていないキーから捨てる', () => {
  const rl = createRateLimiter({ max: 2, windowMs: 1000, maxKeys: 3 });
  rl.record('old', 0); rl.record('a', 5000);
  rl.record('b', 5001); rl.record('b', 5001);
  rl.record('c', 5002); // 溢れ: 期限切れの old だけが消え、a・b・c は残る
  rl.record('c', 5002);
  assert.equal(rl.size, 3);
  assert.equal(rl.check('old', 5002).limited, false);
  rl.record('a', 5003); // a は最近動いた(古い順: b, c, a)
  rl.record('d', 5005); rl.record('d', 5005); // 溢れ: 期限切れは無い → 最近動いていない b から捨てる
  assert.equal(rl.size, 3);
  assert.equal(rl.check('b', 5006).limited, false); // b は捨てられた(残っていれば2回で limited)
  assert.equal(rl.check('c', 5006).limited, true); // c の回数は残っている
  assert.equal(rl.check('d', 5006).limited, true); // d の回数は残っている
  assert.equal(rl.check('a', 5006).limited, true); // a も残っている(5000, 5003 の2回)
});

test('mail: redactToken(本番)ではリンクのトークンを伏せる。既定は出す', async () => {
  const lines = [];
  const m = createMailer({ provider: 'log', logger: (l) => lines.push(l), redactToken: true });
  await m.send({ to: 'taro@example.test', kind: 'reset', url: 'https://x.test/reset-password?token=SECRET_abc-1' });
  assert.ok(!lines[0].includes('SECRET_abc-1'));
  assert.match(lines[0], /reset-password\?token=<redacted>/);
  await createMailer({ logger: (l) => lines.push(l) }).send({ to: 'a@example.test', kind: 'verify', url: 'https://x.test/verify-email?token=VISIBLE' });
  assert.match(lines[1], /token=VISIBLE/);
});

test('mail: log アダプタはリンクを出し、宛先はマスクする。stub は溜める。未実装 provider は例外', async () => {
  const lines = [];
  await createLogMailer({ logger: (l) => lines.push(l) }).send({ to: 'taro@example.test', kind: 'verify', url: 'http://x/verify-email?token=t' });
  assert.match(lines[0], /url=http:\/\/x\/verify-email\?token=t/);
  assert.ok(!lines[0].includes('taro@'));
  const stub = createStubMailer();
  await stub.send({ to: 'a@example.test', kind: 'reset', url: 'u' });
  assert.equal(stub.last('reset').url, 'u');
  assert.equal(stub.last('verify'), null);
  assert.ok(createMailer({}).send); // 既定は log
  assert.throws(() => createMailer({ provider: 'nope' }), /未実装/);
});
