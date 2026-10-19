import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, respondStaticError } from '../server/domain/errorLog.js';

test('describeError: メッセージ中の「改行+空白+at 」はフレーム扱いにしない', () => {
  const e = new Error('first\n    at fake (evil.js:1:1)\nlast');
  const { name, frames } = describeError(e);
  assert.equal(name, 'Error');
  assert.equal(frames.includes('fake'), false);
  assert.ok(/^\s+at /m.test(frames), '本物のフレームは残る');
});

test('describeError: Error 以外は型名(message 相当は出さない)', () => {
  assert.deepEqual(describeError('SECRET'), { name: 'string', frames: '' });
  assert.deepEqual(describeError(42), { name: 'number', frames: '' });
  assert.deepEqual(describeError(null), { name: 'null', frames: '' });
  assert.deepEqual(describeError(undefined), { name: 'undefined', frames: '' });
});

test('describeError: サブクラスは e.name', () => {
  assert.equal(describeError(new TypeError('x')).name, 'TypeError');
});

test('respondStaticError: 本文は汎用メッセージ・ステータス 500・ログに例外文字列を出さない', () => {
  const calls = {};
  const res = { writeHead(s, h) { calls.status = s; calls.headers = h; return this; }, end(b) { calls.body = b; } };
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try { respondStaticError(res, new Error('SECRET-detail'), 'GET /x'); } finally { console.error = orig; }
  assert.equal(calls.status, 500);
  assert.equal(calls.body.includes('SECRET'), false);
  assert.equal(calls.body, 'Internal Server Error');
  assert.equal(logged.some((l) => l.includes('SECRET')), false);
  assert.ok(logged.some((l) => l.includes('-> 500: Error')));
});
