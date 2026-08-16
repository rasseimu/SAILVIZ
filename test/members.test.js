import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS, memberList, toHiragana, filterMembers } from '../src/members.js';

test('全員に family/given/kana があり kana はひらがな', () => {
  assert.ok(MEMBERS.length > 0);
  for (const m of MEMBERS) {
    assert.ok(m.family && m.given && m.kana, `不足: ${JSON.stringify(m)}`);
    assert.match(m.kana, /^[ぁ-ゖー]+$/, `kanaがひらがなでない: ${m.kana}`);
  }
});

test('memberList は id と fullName を付与する', () => {
  const list = memberList();
  assert.equal(list.length, MEMBERS.length);
  assert.equal(list[0].fullName, `${MEMBERS[0].family} ${MEMBERS[0].given}`);
  assert.equal(new Set(list.map((m) => m.id)).size, list.length); // id 一意
});

test('toHiragana はカタカナをひらがなに変換', () => {
  assert.equal(toHiragana('レイ'), 'れい');
  assert.equal(toHiragana('カホ'), 'かほ');
  assert.equal(toHiragana('れい'), 'れい'); // ひらがなはそのまま
});

test('filterMembers はひらがな前方一致で絞り込む', () => {
  const rei = filterMembers('れ');
  assert.ok(rei.some((m) => m.given === '礼'));
  assert.ok(!rei.some((m) => m.given === '咲'));
});

test('filterMembers はカタカナ入力もひらがなに寄せる', () => {
  const rei = filterMembers('レ');
  assert.ok(rei.some((m) => m.given === '礼'));
});

test('filterMembers は漢字の下の名前でも一致', () => {
  const res = filterMembers('佳穂');
  assert.ok(res.some((m) => m.given === '佳穂'));
});

test('空クエリは全員返す', () => {
  assert.equal(filterMembers('').length, MEMBERS.length);
  assert.equal(filterMembers('  ').length, MEMBERS.length);
});
