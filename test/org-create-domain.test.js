// test/org-create-domain.test.js — 組織作成の純粋な規則(DB 不要)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrgName, ORG_NAME_MAX } from '../server/domain/orgCreate.js';

test('validateOrgName: C1 制御文字・向きを変える文字・行区切りも拒否', () => {
  for (const cp of [0x85, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.equal(validateOrgName(`a${String.fromCodePoint(cp)}b`).ok, false, cp.toString(16));
  }
  assert.equal(validateOrgName('芝浦 部 (2026)').ok, true);
});

test('validateOrgName: trim して受理、空・非文字列・長すぎ・制御文字は拒否', () => {
  assert.deepEqual(validateOrgName('  テスト部 '), { ok: true, name: 'テスト部' });
  assert.equal(validateOrgName('').ok, false);
  assert.equal(validateOrgName('   ').ok, false);
  assert.equal(validateOrgName(undefined).ok, false);
  assert.equal(validateOrgName(123).ok, false);
  assert.equal(validateOrgName('あ'.repeat(ORG_NAME_MAX)).ok, true);
  assert.equal(validateOrgName('あ'.repeat(ORG_NAME_MAX + 1)).ok, false);
  assert.equal(validateOrgName('a\nb').ok, false);
});

test('validateOrgName: ゼロ幅・BOM・タグ文字・対になっていないサロゲートも拒否', () => {
  const bad = [0x200b, 0x2060, 0x2061, 0x2064, 0xfeff, 0xe0000, 0xe0067, 0xe007f, 0xd800, 0xdbff, 0xdc00, 0xdfff];
  for (const cp of bad) {
    const ch = String.fromCodePoint(cp); // サロゲート単独は 1 コード単位の文字列になる
    assert.equal(validateOrgName(`a${ch}b`).ok, false, cp.toString(16));
  }
  assert.equal(validateOrgName('a\ud83dX').ok, false, '上位サロゲートの直後が下位でない');
  assert.equal(validateOrgName('a\ude00X').ok, false, '下位サロゲートが単独');
});

test('validateOrgName: ZWJ(U+200D)・ZWNJ(U+200C)は許可のまま', () => {
  assert.equal(validateOrgName('a‍b').ok, true);
  assert.equal(validateOrgName('a‌b').ok, true);
});

test('validateOrgName: 絵文字(ZWJ 結合を含む)が通る。文字数はコードポイント数で数える', () => {
  assert.equal(validateOrgName('セーリング部⛵').ok, true);
  assert.equal(validateOrgName('😀').ok, true);
  const family = '👨‍👩‍👧'; // 5 コードポイント(UTF-16 では 8 単位)
  assert.equal([...family].length, 5);
  assert.deepEqual(validateOrgName(family), { ok: true, name: family });
  // 80 文字ちょうどは通り、81 文字は拒否(絵文字はサロゲートペアでも 1 文字)
  assert.equal(validateOrgName('😀'.repeat(80)).ok, true);
  assert.equal(validateOrgName('😀'.repeat(81)).ok, false);
  // ZWJ 結合は結合後ではなくコードポイントごとに数える: 家族 16 個 = 80、さらに 1 文字で 81
  assert.equal(validateOrgName(family.repeat(16)).ok, true);
  assert.equal(validateOrgName(family.repeat(16) + 'a').ok, false);
  assert.equal(validateOrgName('あ'.repeat(79) + '😀').ok, true);
  assert.equal(validateOrgName('あ'.repeat(80) + '😀').ok, false);
});
