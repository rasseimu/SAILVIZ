// test/policy.test.js
// 設計書 v2 §5.8 の表を1セル1ケースで検証(純関数)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonymous, user, legacySharedPrincipal, isMemberOfOrg,
  canRead, canWrite, canReadReflectionExtras, canComment, canUpdateProgress,
  visibleDayItems, canSeeDayContainer,
} from '../server/domain/policy.js';

const ORG = 'org-a';
const LEGACY_ORG_ID = 'org-shibaura';
// 旧 legacy() の代わり: 書込トークンなしの共有ログイン(userId なし)
const legacy = () => legacySharedPrincipal({ orgId: LEGACY_ORG_ID, canWrite: false });
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

test('書込トークン付きの共有ログインは芝浦の議事録を書ける・進捗を更新できる・コメントできる', () => {
  const L = legacySharedPrincipal({ orgId: LEGACY_ORG_ID, canWrite: true });
  assert.equal(canWrite(L, mk('minutes', { orgId: LEGACY_ORG_ID })), true);
  assert.equal(canWrite(L, mk('minutes', { orgId: 'other-org' })), false);
  const refl = mk('reflection', { visibility: 'org', orgId: LEGACY_ORG_ID });
  assert.equal(canUpdateProgress(L, refl), true);
  assert.equal(canComment(L, refl), true);
});

test('旧共有ログイン(トークンなし)は書けない。userId を持たず、作成者としては扱われない', () => {
  const L = legacy();
  assert.equal(canWrite(L, mk('session', { visibility: 'org', orgId: LEGACY_ORG_ID })), false);
  assert.equal(canRead(L, mk('voice', { orgId: LEGACY_ORG_ID })), false);
  assert.equal(canWrite(L, { kind: 'session', visibility: 'org', ownerId: undefined, orgId: LEGACY_ORG_ID }), false);
});

// ---- S2.5: 旧共有ログインの主体 (MIGRATION_ORG_ID の組織メンバー + 書込トークン) ----

const SH = 'org-shibaura';
const W = legacySharedPrincipal({ orgId: SH, canWrite: true });
const R = legacySharedPrincipal({ orgId: SH, canWrite: false });
const mkS = (kind, extra = {}) => ({ kind, ownerId: 'u-x', crewIds: [], orgId: SH, ...extra });

test('legacySharedPrincipal: 既定は書込トークン無し・組織未設定', () => {
  assert.deepEqual(legacySharedPrincipal(), { kind: 'legacy', shared: true, orgId: null, canWrite: false });
});

test('共有ログインの読み取り: §5.8 の表 (private は読めない・org/public は読める)', () => {
  for (const P of [W, R]) {
    assert.equal(canRead(P, mkS('session', { visibility: 'private' })), false);
    assert.equal(canRead(P, mkS('session', { visibility: 'org' })), true);
    assert.equal(canRead(P, mkS('session', { visibility: 'public' })), true);
    assert.equal(canRead(P, mkS('reflection', { visibility: 'private' })), false);
    assert.equal(canRead(P, mkS('reflection', { visibility: 'org' })), true);
    assert.equal(canRead(P, mkS('reflection', { visibility: 'public' })), true);
    assert.equal(canRead(P, mkS('race')), true);
    assert.equal(canRead(P, mkS('voice')), false);
    assert.equal(canRead(P, mkS('minutes')), true);
    assert.equal(canRead(P, mkS('session', { visibility: 'org', orgId: 'other' })), false);
  }
});

test('共有ログインの書き込み: トークンがあれば自組織の見える対象を書ける (private は不可)', () => {
  for (const kind of ['session', 'reflection', 'race', 'roadmap', 'minutes']) {
    assert.equal(canWrite(W, mkS(kind, { visibility: 'org' })), true, `${kind} トークンあり`);
    assert.equal(canWrite(R, mkS(kind, { visibility: 'org' })), false, `${kind} トークンなし`);
    assert.equal(canWrite(W, mkS(kind, { orgId: 'other', visibility: 'org' })), false, `${kind} 他組織`);
  }
  for (const kind of ['session', 'reflection']) {
    assert.equal(canWrite(W, mkS(kind, { visibility: 'private' })), false, `${kind} private は書けない`);
    assert.equal(canWrite(W, mkS(kind, { visibility: 'public' })), true, `${kind} public`);
  }
  assert.equal(canWrite(W, mkS('voice')), false);
  assert.equal(canWrite(W, { kind: 'unknown', orgId: SH }), false);
});

test('共有ログイン: トークンなしはコメント・進捗更新もできない', () => {
  const refl = mkS('reflection', { visibility: 'org' });
  assert.equal(canComment(W, refl), true);
  assert.equal(canUpdateProgress(W, refl), true);
  assert.equal(canComment(R, refl), false);
  assert.equal(canUpdateProgress(R, refl), false);
});

// 2026-10-19 利用者決定 (b): MIGRATION_ORG_ID 未設定の共有ログインは何も読めない・書けない。
test('(b) 組織未設定の共有ログインは何も読めない・書けない (組織なしの旧データ・public・race も)', () => {
  for (const orgId of [null, '', undefined]) {
    for (const canW of [true, false]) {
      const U = legacySharedPrincipal({ orgId, canWrite: canW });
      for (const kind of ['session', 'reflection', 'race', 'roadmap', 'minutes', 'voice']) {
        for (const o of [null, 'other', undefined]) {
          for (const visibility of ['private', 'org', 'public']) {
            const t = mkS(kind, { visibility, orgId: o });
            assert.equal(canRead(U, t), false, `read ${kind} ${visibility} org=${o}`);
            assert.equal(canWrite(U, t), false, `write ${kind} ${visibility} org=${o}`);
            assert.equal(canComment(U, t), false);
            assert.equal(canUpdateProgress(U, t), false);
          }
        }
      }
      assert.equal(isMemberOfOrg(U, 'other'), false);
      assert.equal(canSeeDayContainer(U, [mkS('session', { visibility: 'public', orgId: null })]), false);
    }
  }
});

test('共有ログインは他組織の public セッション・反省を書けない (読めても書けない)', () => {
  for (const P of [W]) {
    for (const kind of ['session', 'reflection']) {
      const other = mkS(kind, { visibility: 'public', orgId: 'other' });
      assert.equal(canRead(P, other), true);
      assert.equal(canWrite(P, other), false, `${kind} 他組織 public`);
    }
  }
  for (const kind of ['session', 'reflection']) {
    assert.equal(canWrite(W, mkS(kind, { visibility: 'public' })), true);
    assert.equal(canWrite(W, mkS(kind, { visibility: 'org' })), true);
  }
});

// ---- S2.5-P2 利用者決定 (c)(d)(e) ----

test('(c) 進捗の更新: 読めない反省 (他人の private) の進捗は組織メンバーでも更新できない', () => {
  const priv = mk('reflection', { visibility: 'private' });
  assert.equal(canUpdateProgress(ACTORS.creator, priv), true, '作成者は自分の private を更新できる');
  assert.equal(canUpdateProgress(ACTORS.orgMember, priv), false, '同組織でも他人の private は不可');
  assert.equal(canUpdateProgress(W, mkS('reflection', { visibility: 'private' })), false, '共有ログインも不可');
  assert.equal(canUpdateProgress(W, mkS('reflection', { visibility: 'org' })), true);
});

test('(d) 共有ログインのコメントは自分の組織の反省だけ (他組織の public には書けない)', () => {
  assert.equal(canComment(W, mkS('reflection', { visibility: 'org' })), true);
  assert.equal(canComment(W, mkS('reflection', { visibility: 'public' })), true);
  const other = mkS('reflection', { visibility: 'public', orgId: 'other' });
  assert.equal(canRead(W, other), true, '読めはする');
  assert.equal(canComment(W, other), false, 'コメントは不可');
  assert.equal(canComment(W, mkS('reflection', { visibility: 'private' })), false);
  // ログインユーザーは従来どおり (見られる反省なら書ける)
  assert.equal(canComment(ACTORS.otherLoggedIn, mk('reflection', { visibility: 'public' })), true);
});

test('(e) ロードマップの読み取りは本人と組織メンバーだけ', () => {
  const t = mk('roadmap');
  assert.equal(canRead(ACTORS.creator, t), true);
  assert.equal(canRead(ACTORS.orgMember, t), true);
  assert.equal(canRead(ACTORS.otherLoggedIn, t), false);
  assert.equal(canRead(ACTORS.crew, t), false);
  assert.equal(canRead(ACTORS.anon, t), false);
  assert.equal(canRead(W, mkS('roadmap')), true);
  assert.equal(canRead(R, mkS('roadmap')), true, 'トークンなしでも組織メンバーなら読める');
  assert.equal(canRead(W, mkS('roadmap', { orgId: 'other' })), false);
  assert.equal(canRead(W, mkS('roadmap', { orgId: null })), false);
});

test('isMemberOfOrg: ユーザー・共有ログインの所属判定', () => {
  assert.equal(isMemberOfOrg(ACTORS.orgMember, ORG), true);
  assert.equal(isMemberOfOrg(ACTORS.otherLoggedIn, ORG), false);
  assert.equal(isMemberOfOrg(W, SH), true);
  assert.equal(isMemberOfOrg(W, 'other'), false);
  assert.equal(isMemberOfOrg(W, null), false);
  assert.equal(isMemberOfOrg(ACTORS.anon, ORG), false);
});

test('userId なしの user は作成者に一致しない', () => {
  const s = user(undefined, [ORG]);
  assert.equal(canRead(s, { kind: 'voice', ownerId: undefined, orgId: ORG }), false);
});
