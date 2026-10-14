import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoMailer, createMailer } from '../server/mail.js';

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
