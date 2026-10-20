import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoMailer, createMailer, mailProviderWarning, DEFAULT_BREVO_TIMEOUT_MS } from '../server/mail.js';

const KEY = 'dummy-brevo-key-123';
const mk = (fetchImpl, extra = {}) =>
  createBrevoMailer({ apiKey: KEY, from: 'noreply@example.com', fetchImpl, ...extra });

function fakeFetch(status = 201, body = { messageId: 'x' }) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  f.calls = calls;
  return f;
}

test('brevo: URL・ヘッダ・本文(宛先・件名・リンク)', async () => {
  const f = fakeFetch();
  await mk(f).send({ to: 'user@example.com', kind: 'verify', url: 'https://app.example.com/verify-email?token=abc' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['api-key'], KEY);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.accept, 'application/json');
  const b = JSON.parse(init.body);
  assert.equal(b.sender.email, 'noreply@example.com');
  assert.deepEqual(b.to, [{ email: 'user@example.com' }]);
  assert.match(b.subject, /確認/);
  assert.ok(b.textContent.includes('https://app.example.com/verify-email?token=abc'));
});

test('brevo: reset は再設定の件名', async () => {
  const f = fakeFetch();
  await mk(f).send({ to: 'u@example.com', kind: 'reset', url: 'https://a.example.com/reset-password?token=t' });
  assert.match(JSON.parse(f.calls[0].init.body).subject, /再設定/);
});

test('brevo: 非 2xx は例外(API キーを含まない)', async () => {
  const f = fakeFetch(401, { message: 'Key not found' });
  await assert.rejects(
    mk(f).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' }),
    (e) => /401/.test(e.message) && !e.message.includes(KEY));
});

test('brevo: 通信例外は例外(API キーを含まない)', async () => {
  const f = async () => { throw new Error(`boom ${KEY}`); };
  await assert.rejects(
    mk(f).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' }),
    (e) => !e.message.includes(KEY));
});

test('brevo: 本文に出た宛先・トークンをエラーに含めない', async () => {
  const f = fakeFetch(400, { message: 'bad to u@example.com' });
  await assert.rejects(
    mk(f).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=SECRET' }),
    (e) => !e.message.includes('SECRET') && !e.message.includes('u@example.com'));
});

test('createMailer: brevo は API キー・MAIL_FROM が無いと起動時に例外', () => {
  assert.throws(() => createMailer({ provider: 'brevo', from: 'a@example.com' }), /BREVO_API_KEY/);
  assert.throws(() => createMailer({ provider: 'brevo', apiKey: KEY }), /MAIL_FROM/);
  const m = createMailer({ provider: 'brevo', apiKey: KEY, from: 'a@example.com', fetchImpl: fakeFetch() });
  assert.equal(typeof m.send, 'function');
});

test('createMailer: 未知の provider は例外、log が既定', () => {
  assert.throws(() => createMailer({ provider: 'nope' }), /MAIL_PROVIDER=nope/);
  assert.equal(typeof createMailer({}).send, 'function');
});

test('brevo: タイムアウト(signal の abort)で reject する(API キーを含まない)', async () => {
  const f = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error(`aborted ${KEY}`);
      e.name = 'TimeoutError';
      reject(e);
    });
  });
  await assert.rejects(
    mk(f, { timeoutMs: 20 }).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' }),
    (e) => /接続に失敗/.test(e.message) && /TimeoutError/.test(e.message) && !e.message.includes(KEY));
});

test('brevo: timeoutMs を省くと既定(5 秒)の AbortSignal.timeout が fetch に渡る', async () => {
  assert.equal(DEFAULT_BREVO_TIMEOUT_MS, 5000);
  const orig = AbortSignal.timeout;
  const used = [];
  AbortSignal.timeout = (ms) => { used.push(ms); return orig.call(AbortSignal, ms); }; // 実時間は待たない(呼ばれた値だけ見る)
  try {
    await mk(fakeFetch()).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' });
    await mk(fakeFetch(), { timeoutMs: 20 }).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' });
  } finally { AbortSignal.timeout = orig; }
  assert.deepEqual(used, [5000, 20]);
});

test('brevo: 非 2xx の応答本文は body.cancel() で捨てる', async () => {
  let cancelled = 0;
  const f = async () => ({ ok: false, status: 500, body: { cancel: async () => { cancelled++; } } });
  await assert.rejects(mk(f).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' }), /500/);
  assert.equal(cancelled, 1);
});

test('brevo: body が無い応答でも非 2xx は status の例外', async () => {
  const f = async () => ({ ok: false, status: 503 });
  await assert.rejects(mk(f).send({ to: 'u@example.com', kind: 'verify', url: 'https://a.example.com/x?token=t' }), /503/);
});

test('createMailer: brevo の MAIL_FROM に @ が無ければ起動時に例外', () => {
  assert.throws(() => createMailer({ provider: 'brevo', apiKey: KEY, from: 'noreply' }), /MAIL_FROM/);
  assert.throws(() => createMailer({ provider: 'brevo', apiKey: KEY, from: '@' }), /MAIL_FROM/);
  assert.equal(typeof createMailer({ provider: 'brevo', apiKey: KEY, from: 'a@example.com' }).send, 'function');
});

test('mailProviderWarning: 本番・アカウント機能ありで未設定・log のときだけ WARN 文字列', () => {
  for (const provider of [undefined, '', 'log']) {
    const w = mailProviderWarning({ nodeEnv: 'production', provider, accountsEnabled: true });
    assert.match(w, /^WARN:/);
    assert.match(w, /MAIL_PROVIDER/);
  }
  assert.equal(mailProviderWarning({ nodeEnv: 'production', provider: 'brevo', accountsEnabled: true }), null);
  assert.equal(mailProviderWarning({ nodeEnv: 'development', provider: 'log', accountsEnabled: true }), null);
  assert.equal(mailProviderWarning({ nodeEnv: undefined, provider: undefined, accountsEnabled: true }), null);
});

test('mailProviderWarning: アカウント機能が無い(STORAGE≠db)なら本番・未設定でも出さない', () => {
  assert.equal(mailProviderWarning({ nodeEnv: 'production', provider: undefined, accountsEnabled: false }), null);
  assert.equal(mailProviderWarning({ nodeEnv: 'production', provider: 'log' }), null);
});
