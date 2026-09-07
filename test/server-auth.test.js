// test/server-auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, extractToken, isAuthorized } from '../server/auth.js';

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
