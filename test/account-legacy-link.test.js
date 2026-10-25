// test/account-legacy-link.test.js — 組織管理の「旧名簿の氏名」の紐付けの選択肢(src/account/logic.js legacyLinkRows)。名前はダミー。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyLinkRows } from '../src/account/logic.js';

test('legacyLinkRows: 紐付け済みは選択肢なし。未紐付けには、未付け替えの記録があり誰にも紐付いていない氏名だけ', () => {
  const members = [
    { userId: 'u1', name: '部員 一郎', legacyName: '旧 一郎' },
    { userId: 'u2', name: 'ニックネーム', legacyName: null },
  ];
  const names = [
    { name: '旧 一郎', unclaimed: 1, linkedUserIds: [] }, // u1 に紐付き済み(メンバー一覧で分かる)
    { name: '旧 二郎', unclaimed: 3, linkedUserIds: [] },
    { name: '旧 三郎', unclaimed: 0, linkedUserIds: ['u9'] }, // 付け替え済み
    { name: '旧 四郎', unclaimed: 2, linkedUserIds: ['u9'] }, // 一部が別の人に付け替え済み
  ];
  assert.deepEqual(legacyLinkRows(members, names), [
    { userId: 'u1', name: '部員 一郎', legacyName: '旧 一郎', options: [] },
    { userId: 'u2', name: 'ニックネーム', legacyName: null, options: ['旧 二郎'] },
  ]);
});

test('legacyLinkRows: 不正な入力は空として扱う', () => {
  assert.deepEqual(legacyLinkRows(null, null), []);
  assert.deepEqual(legacyLinkRows([{ userId: 'u1', name: 'A' }], undefined), [{ userId: 'u1', name: 'A', legacyName: null, options: [] }]);
});
