// test/policy.test.js
// 設計書 v2 §5.8 の表を1セル1ケースで検証(純関数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonymous, user, legacy, LEGACY_ORG_ID,
  canRead, canWrite, canReadReflectionExtras, canComment, canUpdateProgress,
  visibleDayItems, canSeeDayContainer,
} from '../server/domain/policy.js';

const ORG = 'org-a';
const ACTORS = {
  creator: user('u-owner', [ORG]),
  crew: user('u-crew', ['org-x']), // 乗員(組織は別にして列を独立させる)
  orgMember: user('u-member', [ORG]),
  otherLoggedIn: user('u-other', ['org-x']),
  anon: anonymous(),
};
const mk = (kind, extra = {}) => ({ kind, ownerId: 'u-owner', crewIds: ['u-crew'], orgId: ORG, ...extra });

// [名前, 対象, {作成者, 乗員, 同じ組織, 他者, 未ログイン}] (null は表の「—」＝検証しない)
const TABLE = [
  ['セッション private', mk('session', { visibility: 'private' }), [true, true, false, false, false]],
  ['セッション org', mk('session', { visibility: 'org' }), [true, true, true, false, false]],
  ['セッション public', mk('session', { visibility: 'public' }), [true, true, true, true, true]],
  ['反省 private', mk('reflection', { visibility: 'private' }), [true, null, false, false, false]],
  ['反省 org', mk('reflection', { visibility: 'org' }), [true, null, true, false, false]],
  ['反省 public', mk('reflection', { visibility: 'public' }), [true, null, true, true, true]],
  ['レースのセッション・記録', mk('race'), [true, true, true, true, true]],
  ['声の反省', mk('voice'), [true, null, false, false, false]],
  ['練習日の議事録', mk('minutes'), [true, null, true, false, false]],
];
const COLS = ['creator', 'crew', 'orgMember', 'otherLoggedIn', 'anon'];

for (const [name, target, expected] of TABLE) {
  COLS.forEach((col, i) => {
    if (expected[i] === null) return;
    test(`§5.8 表: ${name} × ${col} → ${expected[i] ? '○' : '×'}`, () => {
      assert.equal(canRead(ACTORS[col], target), expected[i]);
    });
  });
}

test('乗員でない同組織外ユーザーは private セッションを読めない (crewIds が効いている)', () => {
  assert.equal(canRead(user('u-zzz', []), mk('session', { visibility: 'private' })), false);
});

test('未知の kind・公開範囲は拒否', () => {
  assert.equal(canRead(ACTORS.creator, mk('unknown')), false);
  assert.equal(canRead(ACTORS.creator, mk('session', { visibility: 'weird' })), false);
  assert.equal(canRead(ACTORS.creator, mk('reflection')), false);
  assert.equal(canWrite(ACTORS.creator, mk('unknown')), false);
  assert.equal(canRead(ACTORS.creator, null), false);
});

test('orgId なしの対象は org 公開でも組織メンバー扱いにならない', () => {
  const t = mk('session', { visibility: 'org', orgId: null });
  assert.equal(canRead(ACTORS.orgMember, t), false);
  assert.equal(canRead(ACTORS.creator, t), true);
});

// ---- 箇条書きのルール ----

test('書き込みは作成者だけ (セッション・反省・ロードマップ・声の反省)', () => {
  for (const kind of ['session', 'reflection', 'roadmap', 'voice']) {
    const t = mk(kind, { visibility: 'public' });
    assert.equal(canWrite(ACTORS.creator, t), true, `${kind} 作成者`);
    for (const c of ['crew', 'orgMember', 'otherLoggedIn', 'anon']) {
      assert.equal(canWrite(ACTORS[c], t), false, `${kind} ${c}`);
    }
    assert.equal(canWrite(legacy(), t), false, `${kind} 旧共有ログイン`);
  }
});

test('乗員でも他人のセッションのメタは書けない', () => {
  assert.equal(canWrite(ACTORS.crew, mk('session', { visibility: 'org' })), false);
});

test('練習日の議事録は組織メンバーなら誰でも作り直せる。他者・未ログインは不可', () => {
  const t = mk('minutes');
  assert.equal(canWrite(ACTORS.creator, t), true);
  assert.equal(canWrite(ACTORS.orgMember, t), true);
  assert.equal(canWrite(ACTORS.otherLoggedIn, t), false);
  assert.equal(canWrite(ACTORS.anon, t), false);
});

test('反省の進捗・コメントは、その反省を見られる人が見られる', () => {
  const priv = mk('reflection', { visibility: 'private' });
  const org = mk('reflection', { visibility: 'org' });
  assert.equal(canReadReflectionExtras(ACTORS.creator, priv), true);
  assert.equal(canReadReflectionExtras(ACTORS.orgMember, priv), false);
  assert.equal(canReadReflectionExtras(ACTORS.orgMember, org), true);
  assert.equal(canReadReflectionExtras(ACTORS.otherLoggedIn, org), false);
  assert.equal(canReadReflectionExtras(ACTORS.anon, mk('reflection', { visibility: 'public' })), true);
  assert.equal(canReadReflectionExtras(ACTORS.creator, mk('session', { visibility: 'public' })), false);
});

test('コメントは見られるログインユーザーが書ける (未ログインは公開でも不可)', () => {
  const pub = mk('reflection', { visibility: 'public' });
  const org = mk('reflection', { visibility: 'org' });
  assert.equal(canComment(ACTORS.otherLoggedIn, pub), true);
  assert.equal(canComment(ACTORS.anon, pub), false);
  assert.equal(canComment(ACTORS.orgMember, org), true);
  assert.equal(canComment(ACTORS.otherLoggedIn, org), false);
});

test('進捗の更新は作成者と組織メンバー', () => {
  const t = mk('reflection', { visibility: 'org' });
  assert.equal(canUpdateProgress(ACTORS.creator, t), true);
  assert.equal(canUpdateProgress(ACTORS.orgMember, t), true);
  assert.equal(canUpdateProgress(ACTORS.otherLoggedIn, t), false);
  assert.equal(canUpdateProgress(ACTORS.anon, t), false);
});

test('練習日の器は、見てよい中身だけを、1つでも見られる人に返す', () => {
  const items = [
    mk('session', { visibility: 'private' }),
    mk('session', { visibility: 'org' }),
    mk('session', { visibility: 'public' }),
    mk('reflection', { visibility: 'private' }),
  ];
  assert.equal(visibleDayItems(ACTORS.creator, items).length, 4);
  assert.equal(visibleDayItems(ACTORS.orgMember, items).length, 2);
  assert.equal(visibleDayItems(ACTORS.anon, items).length, 1);
  assert.equal(canSeeDayContainer(ACTORS.anon, items), true);
  const hidden = [items[0], items[3]];
  assert.equal(canSeeDayContainer(ACTORS.anon, hidden), false);
  assert.equal(canSeeDayContainer(ACTORS.otherLoggedIn, hidden), false);
  assert.deepEqual(visibleDayItems(ACTORS.anon, undefined), []);
});

// ---- 旧共有ログイン = 芝浦の組織メンバー ----

test('旧共有ログインは芝浦組織のメンバーとして読める (org 公開・議事録)', () => {
  const L = legacy();
  assert.equal(canRead(L, mk('session', { visibility: 'org', orgId: LEGACY_ORG_ID })), true);
  assert.equal(canRead(L, mk('reflection', { visibility: 'org', orgId: LEGACY_ORG_ID })), true);
  assert.equal(canRead(L, mk('session', { visibility: 'private', orgId: LEGACY_ORG_ID })), false);
  assert.equal(canRead(L, mk('session', { visibility: 'org', orgId: 'other-org' })), false);
});

test('旧共有ログインは芝浦の議事録を書ける・進捗を更新できる・コメントできる', () => {
  const L = legacy();
  assert.equal(canWrite(L, mk('minutes', { orgId: LEGACY_ORG_ID })), true);
  assert.equal(canWrite(L, mk('minutes', { orgId: 'other-org' })), false);
  const refl = mk('reflection', { visibility: 'org', orgId: LEGACY_ORG_ID });
  assert.equal(canUpdateProgress(L, refl), true);
  assert.equal(canComment(L, refl), true);
});

test('旧共有ログインは userId を持たず、作成者としては扱われない', () => {
  const L = legacy();
  assert.equal(canWrite(L, mk('session', { visibility: 'org', orgId: LEGACY_ORG_ID })), false);
  assert.equal(canRead(L, mk('voice', { orgId: LEGACY_ORG_ID })), false);
  assert.equal(canWrite(L, { kind: 'session', visibility: 'org', ownerId: undefined, orgId: LEGACY_ORG_ID }), false);
});

test('userId なしの user は作成者に一致しない', () => {
  const s = user(undefined, [ORG]);
  assert.equal(canRead(s, { kind: 'voice', ownerId: undefined, orgId: ORG }), false);
});
