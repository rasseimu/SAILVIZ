// test/legacy-claim.test.js — 旧名簿の氏名の候補と、氏名(空白を除く)の一致(server/domain/legacyClaim.js)。名前はダミー。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyClaimView, nameKey } from '../server/domain/legacyClaim.js';

const names = [
  { name: '旧 一郎', unclaimed: 2, userIds: [] },
  { name: '旧 二郎', unclaimed: 1, userIds: ['u9'] }, // 一部が別の人に付け替え済み
  { name: '旧 三郎', unclaimed: 0, userIds: ['u1'] }, // 本人に付け替え済み(未付け替え 0)
  { name: '旧 四郎', unclaimed: 1, userIds: [] }, // 名簿行で別の人に結び付き済み
];

test('nameKey: 半角・全角の空白を除く', () => {
  assert.equal(nameKey(' 旧　一郎 '), '旧一郎');
  assert.equal(nameKey(null), '');
});

test('legacyClaimView: 候補は未付け替えがあり他人に結び付いていない旧氏名。名前の一致を提案', () => {
  const v = legacyClaimView({ names, userId: 'u1', userName: '旧一郎', linked: null, takenByOthers: new Set(['旧 四郎']) });
  assert.deepEqual(v, { linked: null, suggested: '旧 一郎', candidates: ['旧 一郎'] });
  assert.equal(legacyClaimView({ names, userId: 'u1', userName: 'ニックネーム', linked: null }).suggested, null);
  assert.deepEqual(legacyClaimView({ names, userId: 'u1', userName: '旧一郎', linked: '旧 三郎' }), { linked: '旧 三郎', suggested: null, candidates: [] });
  // 同じキーの候補が 2 つあるときは決めつけない
  const dup = legacyClaimView({ names: [{ name: '旧 一郎', unclaimed: 1, userIds: [] }, { name: '旧一郎', unclaimed: 1, userIds: [] }], userId: 'u1', userName: '旧一郎', linked: null });
  assert.equal(dup.suggested, null);
});
