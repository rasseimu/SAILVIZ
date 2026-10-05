// test/server-config.test.js
// 閲覧ゲート資格情報の env 解決。既定値の埋め込みを廃止し、本番では必須。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewGate } from '../server/config.js';

test('env に両方あればそれを返す', () => {
  const r = resolveViewGate({ SAILVIZ_VIEW_USER: 'u', SAILVIZ_VIEW_PASSWORD: 'p' });
  assert.equal(r.viewUser, 'u');
  assert.equal(r.viewPassword, 'p');
});

test('未設定(非本番)は空文字で、旧既定値を漏らさない', () => {
  const r = resolveViewGate({});
  assert.equal(r.viewUser, '');
  assert.equal(r.viewPassword, '');
  assert.notEqual(r.viewUser, '芝浦工業大学体育会ヨット部');
  assert.notEqual(r.viewPassword, '6235');
});

test('本番で資格情報が欠けると throw', () => {
  assert.throws(() => resolveViewGate({ NODE_ENV: 'production' }), /必須/);
  assert.throws(() => resolveViewGate({ NODE_ENV: 'production', SAILVIZ_VIEW_USER: 'u' }), /必須/);
  assert.throws(() => resolveViewGate({ NODE_ENV: 'production', SAILVIZ_VIEW_PASSWORD: 'p' }), /必須/);
});

test('本番で両方あれば throw しない', () => {
  const r = resolveViewGate({ NODE_ENV: 'production', SAILVIZ_VIEW_USER: 'u', SAILVIZ_VIEW_PASSWORD: 'p' });
  assert.equal(r.viewUser, 'u');
  assert.equal(r.viewPassword, 'p');
});
