// test/account-web.test.js
// アカウント画面(S2.7)の純関数: ページ判定・トークン取り出し・エラー文言・名簿の CSV 変換。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pageModeForPath, tokenFromSearch, apiErrorMessage, parseRosterText, rosterToText, checkNewPassword, checkRegisterForm, membersView, orgSwitchItems,
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

test('parseRosterText: ヘッダは「氏名+メール」の2列が揃うときだけ。氏名が "name" の人は読み飛ばさない', () => {
  assert.deepEqual(parseRosterText('Name,Email\nA,a@example.com').rows, [{ name: 'A', email: 'a@example.com', legacyName: null }]);
  assert.deepEqual(parseRosterText('name,a@example.com').rows, [{ name: 'name', email: 'a@example.com', legacyName: null }]);
  assert.deepEqual(parseRosterText('氏名').rows, [{ name: '氏名', email: null, legacyName: null }]);
});

test('membersView: 200 以外はエラー(0人とは区別)、200 は一覧', () => {
  for (const [s, j] of [[401, null], [403, null], [500, null], [0, null], [200, { x: 1 }]]) {
    const v = membersView(s, j);
    assert.equal(v.kind, 'error', `status ${s}`);
    assert.match(v.message, /読み込めませんでした/);
  }
  assert.deepEqual(membersView(200, []), { kind: 'list', members: [] });
  assert.equal(membersView(200, [{ name: 'A' }]).members.length, 1);
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

test('orgSwitchItems: 所属 1 つなら空', () => {
  assert.deepEqual(orgSwitchItems([{ id: 'o1', name: '部A' }], 'o1'), []);
  assert.deepEqual(orgSwitchItems([], null), []);
  assert.deepEqual(orgSwitchItems(null, null), []);
});

test('orgSwitchItems: 表示中に active', () => {
  const orgs = [{ id: 'o1', name: '部A', isAdmin: true }, { id: 'o2', name: '部B', isAdmin: false }];
  assert.deepEqual(orgSwitchItems(orgs, 'o2'), [{ id: 'o1', name: '部A', active: false }, { id: 'o2', name: '部B', active: true }]);
});

// このリポジトリのアカウント画面テストは DOM を使わない(account-roster-note.test.js と同じ流儀)ので、画面コードの配線を文字列で確かめる。
test('組織の画面: 切り替えボタン群を先頭に出し、押すと覚えて描き直す', () => {
  const main = readFileSync(new URL('../src/account/main.js', import.meta.url), 'utf8');
  assert.match(main, /id: 'ac-org-switch'/);
  assert.match(main, /'data-org-id': it\.id, 'aria-pressed': String\(it\.active\)/);
  assert.match(main, /setActiveOrgId\(it\.id\);[\s\S]*renderOrgHome\(encodeURIComponent\(it\.id\)\)/);
  assert.match(main, /mount\(\.\.\.\[orgSwitchBar\(\)\]\.filter\(Boolean\), /);
  assert.match(main, /resolveActiveOrg\(me\.orgs\)/);
});
