// test/account-web.test.js
// アカウント画面(S2.7)の純関数: ページ判定・トークン取り出し・エラー文言・名簿の CSV 変換。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageModeForPath, tokenFromSearch, apiErrorMessage, parseRosterText, rosterToText, checkNewPassword, checkRegisterForm,
} from '../src/account/logic.js';

test('pageModeForPath: パスで画面を決める', () => {
  assert.equal(pageModeForPath('/verify-email'), 'verify');
  assert.equal(pageModeForPath('/reset-password'), 'reset');
  assert.equal(pageModeForPath('/account'), 'account');
  assert.equal(pageModeForPath('/account/'), 'account');
  assert.equal(pageModeForPath('/anything'), 'account');
});

test('tokenFromSearch: token を取り出す。無い・空は null', () => {
  assert.equal(tokenFromSearch('?token=abc-_123'), 'abc-_123');
  assert.equal(tokenFromSearch('?x=1&token=a%2Bb'), 'a+b');
  assert.equal(tokenFromSearch('?token='), null);
  assert.equal(tokenFromSearch(''), null);
  assert.equal(tokenFromSearch('?other=1'), null);
});

test('apiErrorMessage: サーバの message を優先し、無ければ状態コードから', () => {
  assert.equal(apiErrorMessage(422, { error: { code: 'invalid_input', message: '氏名を入力してください' } }), '氏名を入力してください');
  assert.match(apiErrorMessage(401, null), /ログイン/);
  assert.match(apiErrorMessage(429, {}), /しばらく/);
  assert.match(apiErrorMessage(503, null), /アカウント機能/);
  assert.match(apiErrorMessage(500, null), /サーバ/);
  assert.match(apiErrorMessage(0, null), /通信/);
});

test('parseRosterText: カンマ・タブ区切り、ヘッダ行と空行を読み飛ばす', () => {
  const r = parseRosterText('氏名,メール,旧名簿の氏名\n部員A,a@example.com,旧A\n\n部員B\t b@example.com \t\n部員C\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, [
    { name: '部員A', email: 'a@example.com', legacyName: '旧A' },
    { name: '部員B', email: 'b@example.com', legacyName: null },
    { name: '部員C', email: null, legacyName: null },
  ]);
});

test('parseRosterText: 引用符つきの値とカンマ', () => {
  const r = parseRosterText('"部員, A","a@example.com",""\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, [{ name: '部員, A', email: 'a@example.com', legacyName: null }]);
});

test('parseRosterText: 氏名が空の行は行番号つきのエラー', () => {
  const r = parseRosterText('部員A,a@example.com\n,b@example.com\n');
  assert.equal(r.ok, false);
  assert.match(r.message, /2 行目/);
});

test('parseRosterText: 空の入力は空の名簿(全員を外す)', () => {
  assert.deepEqual(parseRosterText('  \n'), { ok: true, rows: [] });
});

test('rosterToText と parseRosterText は往復できる', () => {
  const rows = [{ name: '部員A', email: 'a@example.com', legacyName: '旧A' }, { name: '部員, B', email: null, legacyName: null }];
  assert.deepEqual(parseRosterText(rosterToText(rows)).rows, rows);
});

test('checkNewPassword: 8文字以上・確認欄と一致', () => {
  assert.equal(checkNewPassword('short', 'short').ok, false);
  assert.equal(checkNewPassword('long-enough-1', 'different-123').ok, false);
  assert.equal(checkNewPassword('long-enough-1', 'long-enough-1').ok, true);
});

test('checkRegisterForm: 必須項目と同意', () => {
  const ok = { email: 'a@example.com', password: 'long-enough-1', name: '部員A', affiliationText: '部', agreed: true };
  assert.equal(checkRegisterForm(ok).ok, true);
  assert.equal(checkRegisterForm({ ...ok, agreed: false }).ok, false);
  assert.equal(checkRegisterForm({ ...ok, email: 'x' }).ok, false);
  assert.equal(checkRegisterForm({ ...ok, name: ' ' }).ok, false);
  assert.equal(checkRegisterForm({ ...ok, affiliationText: '' }).ok, false);
  assert.equal(checkRegisterForm({ ...ok, password: 'short' }).ok, false);
});
