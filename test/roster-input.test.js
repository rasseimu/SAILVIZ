// test/roster-input.test.js — 名簿の入力検証(純関数)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRosterRows, ROSTER_MAX_ROWS } from '../server/domain/rosterInput.js';

test('正常: trim・メール小文字化・空の legacyName は null', () => {
  const r = validateRosterRows([
    { name: ' 部員A ', email: ' A@Example.TEST ', legacyName: ' 旧A ' },
    { name: '部員B', email: 'b@example.test' },
    { name: '部員C', email: 'c@example.test', legacyName: '  ' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, [
    { name: '部員A', email: 'a@example.test', legacyName: '旧A' },
    { name: '部員B', email: 'b@example.test', legacyName: null },
    { name: '部員C', email: 'c@example.test', legacyName: null },
  ]);
});

test('空配列は有効(名簿を空にする)', () => {
  assert.deepEqual(validateRosterRows([]), { ok: true, rows: [] });
});

test('配列でない・行がオブジェクトでない・件数超過は不正', () => {
  assert.equal(validateRosterRows(undefined).ok, false);
  assert.equal(validateRosterRows({}).ok, false);
  assert.equal(validateRosterRows(['x']).ok, false);
  assert.equal(validateRosterRows([null]).ok, false);
  const many = Array.from({ length: ROSTER_MAX_ROWS + 1 }, (_, i) => ({ name: 'n', email: `u${i}@example.test` }));
  assert.equal(validateRosterRows(many).ok, false);
});

test('氏名が空・非文字列・長すぎは不正', () => {
  for (const name of ['', '  ', 5, undefined, 'あ'.repeat(201)]) {
    assert.equal(validateRosterRows([{ name, email: 'a@example.test' }]).ok, false, String(name));
  }
});

test('メールの形式が不正なら不正。メールなし(空・未指定)は許す(照合されないだけ)', () => {
  assert.equal(validateRosterRows([{ name: 'A', email: 'not-an-email' }]).ok, false);
  assert.equal(validateRosterRows([{ name: 'A', email: 5 }]).ok, false);
  const r = validateRosterRows([{ name: 'A', email: '' }, { name: 'B' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.email), [null, null]);
});

test('legacyName が文字列でない・長すぎは不正', () => {
  assert.equal(validateRosterRows([{ name: 'A', email: 'a@example.test', legacyName: 5 }]).ok, false);
  assert.equal(validateRosterRows([{ name: 'A', email: 'a@example.test', legacyName: 'あ'.repeat(201) }]).ok, false);
});

test('メール重複(正規化後)は不正で、どの行かをメッセージに含む', () => {
  const r = validateRosterRows([
    { name: 'A', email: 'a@example.test' }, { name: 'B', email: ' A@EXAMPLE.test ' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'duplicate_email');
  assert.match(r.message, /2/);
});
