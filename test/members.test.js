import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBERS, memberList, toHiragana, filterMembers, legacyMemberList, orgRoster, setMemberRoster, memberLabel,
} from '../src/members.js';

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

// ===== 組織の名簿(名前はダミー) =====

test('orgRoster: アカウント名を表示名・キーにし、空白で姓と名に分ける。名前の無い人・同じキーは除く', () => {
  const r = orgRoster([
    { userId: 'u1', name: '山田 太郎' },
    { userId: 'u2', name: 'Hanako' },
    { userId: 'u3', name: '  ' },
    { userId: 'u4', name: '山田 太郎' },
  ]);
  assert.deepEqual(r.map((m) => [m.id, m.fullName, m.displayName, m.family, m.given, m.kana]), [
    ['u1', '山田 太郎', '山田 太郎', '山田', '太郎', ''],
    ['u2', 'Hanako', 'Hanako', '', 'Hanako', ''],
  ]);
});

test('orgRoster: 旧名簿の氏名があればそれをキーにし(既存の記録を引き継ぐ)、従来の名簿の姓・名・読みを使う', () => {
  const old = legacyMemberList()[0];
  const [m] = orgRoster([{ userId: 'u9', name: 'アカウント名', legacyName: old.fullName }]);
  assert.equal(m.fullName, old.fullName);
  assert.equal(m.displayName, 'アカウント名');
  assert.deepEqual([m.family, m.given, m.kana], [old.family, old.given, old.kana]);
  // 従来の名簿に無い旧名簿の氏名: キーはその名前、姓名はアカウント名から
  const [x] = orgRoster([{ userId: 'u8', name: '佐々木 次郎', legacyName: '旧 名前' }]);
  assert.deepEqual([x.fullName, x.displayName, x.family, x.given], ['旧 名前', '佐々木 次郎', '佐々木', '次郎']);
});

test('setMemberRoster / memberList / memberLabel: 組織の名簿があればそれ(空も空のまま)、null なら従来の名簿', () => {
  try {
    setMemberRoster(orgRoster([{ userId: 'u1', name: '山田 太郎', legacyName: '旧 太郎' }]));
    assert.deepEqual(memberList().map((m) => m.fullName), ['旧 太郎']);
    assert.equal(memberLabel('旧 太郎'), '山田 太郎');
    assert.equal(memberLabel('名簿外'), '名簿外');
    setMemberRoster([]); // 空(組織に所属していないアカウント)は空のまま。従来の名簿へ戻さない
    assert.deepEqual(memberList(), []);
  } finally {
    setMemberRoster(null);
  }
  assert.equal(memberList().length, MEMBERS.length);
});

test('filterMembers: 組織の名簿でも、姓・名・表示名の前方一致。読みや姓が空の人は空文字で一致しない', () => {
  const list = orgRoster([{ userId: 'u1', name: '山田 太郎' }, { userId: 'u2', name: 'Hanako' }]);
  assert.deepEqual(filterMembers('山', list).map((m) => m.id), ['u1']);
  assert.deepEqual(filterMembers('太', list).map((m) => m.id), ['u1']);
  assert.deepEqual(filterMembers('Ha', list).map((m) => m.id), ['u2']);
  assert.deepEqual(filterMembers('x', list), []);
  assert.equal(filterMembers('', list).length, 2);
});

test('filterMembers: 旧名簿の氏名で結び付いた人は、アカウント名の名でも一致する', () => {
  const old = legacyMemberList()[0];
  const list = orgRoster([{ userId: 'u1', name: '佐々木 花子', legacyName: old.fullName }]);
  assert.equal(filterMembers('花', list).length, 1);
  assert.equal(filterMembers('佐々', list).length, 1);
});

test('filterMembers: 英字は大文字・小文字を区別しない', () => {
  const list = orgRoster([{ userId: 'u1', name: 'Hanako Yamada' }]);
  assert.equal(filterMembers('ha', list).length, 1);
  assert.equal(filterMembers('YAM', list).length, 1);
});
