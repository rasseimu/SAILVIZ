// test/server-auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, extractToken, isAuthorized, isViewer } from '../server/auth.js';

test('parseCookies splits pairs', () => {
  assert.deepEqual(parseCookies('a=1; sailviz_token=xyz'), { a: '1', sailviz_token: 'xyz' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('extractToken prefers Authorization bearer', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractToken({ headers: { cookie: 'sailviz_token=c' } }), 'c');
  assert.equal(extractToken({ headers: {} }), null);
});

test('isAuthorized matches token, false when unset', () => {
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=s3cret' } }, 's3cret'), true);
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=wrong' } }, 's3cret'), false);
  assert.equal(isAuthorized({ headers: { cookie: 'sailviz_token=x' } }, ''), false);
});

test('isViewer: gate disabled (no secret) → always true', () => {
  assert.equal(isViewer({ headers: {} }, null, 'wtok'), true);
});

test('isViewer: view cookie matching secret unlocks viewing', () => {
  assert.equal(isViewer({ headers: { cookie: 'sailviz_view=vs' } }, 'vs', 'wtok'), true);
  assert.equal(isViewer({ headers: { cookie: 'sailviz_view=nope' } }, 'vs', 'wtok'), false);
  assert.equal(isViewer({ headers: {} }, 'vs', 'wtok'), false);
});

test('isViewer: edit mode (write token) implies viewing', () => {
  assert.equal(isViewer({ headers: { cookie: 'sailviz_token=wtok' } }, 'vs', 'wtok'), true);
  assert.equal(isViewer({ headers: { authorization: 'Bearer wtok' } }, 'vs', 'wtok'), true);
});
