// test/video-comments-domain.test.js — 動画の瞬間コメントの純関数(キー・入力検証・権限)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  practiceVideoKey, practiceVideoTOf, validateCommentText, validateNewPracticeComment,
  canReadPracticeComments, canWritePracticeComment, canReadVideoComment, canEditVideoComment, canDeleteVideoComment,
  MAX_POSITION_MS, studyVideoKey, studyVideoSizeOf, validateNewStudyComment, normalizeStudyVideoName, canReadStudyComments, canWriteStudyComment,
} from '../server/domain/videoComments.js';
import { user, legacySharedPrincipal, anonymous } from '../server/domain/policy.js';
import { videoKey } from '../src/videolink.js';

const ORG = 'o_a';
const OTHER = 'o_b';
const member = user('u1', [ORG], ORG);
const member2 = user('u2', [ORG], ORG);
const outsider = user('u9', [OTHER], OTHER);
const shared = legacySharedPrincipal({ orgId: ORG, canWrite: true });
const sharedOther = legacySharedPrincipal({ orgId: OTHER, canWrite: true });
const sharedNoOrg = legacySharedPrincipal({ orgId: null, canWrite: true });
const access = (orgId, vis = 'org', ownerId = 'u1') => ({ orgId, tracks: [], reflections: [{ id: 'r1', visibility: vis, ownerId }] });

test('practiceVideoKey は①の videoKey と同じで、名前に区切り文字が入っても衝突しない', () => {
  assert.equal(practiceVideoKey('a.mp4', 1000), videoKey({ name: 'a.mp4', t: 1000 }));
  assert.notEqual(practiceVideoKey('a",1', 2), practiceVideoKey('a', 1));
  assert.notEqual(practiceVideoKey('a|1', 2), practiceVideoKey('a', 12));
  assert.notEqual(practiceVideoKey('a', 12), practiceVideoKey('a1', 2));
  assert.equal(practiceVideoTOf(practiceVideoKey('x[],"y', 1791015000123)), 1791015000123);
  assert.equal(practiceVideoTOf('not json'), null);
  assert.equal(practiceVideoTOf('["a"]'), null);
});

test('validateCommentText: 1〜1000字(.length)で空白だけは不可', () => {
  assert.equal(validateCommentText('a'), null);
  assert.equal(validateCommentText('あ'.repeat(1000)), null);
  for (const bad of ['', '   ', '\n\t', 'a'.repeat(1001), null, 1, undefined, ['a']]) {
    assert.ok(validateCommentText(bad), `不可: ${JSON.stringify(bad)}`);
  }
});

test('validateNewPracticeComment: 境界', () => {
  const ok = { videoName: 'a.mp4', videoT: 0, positionMs: 0, text: 'タックが遅い' };
  assert.equal(validateNewPracticeComment(ok), null);
  assert.equal(validateNewPracticeComment({ ...ok, videoName: 'n'.repeat(255), positionMs: MAX_POSITION_MS, videoT: Number.MAX_SAFE_INTEGER }), null);
  const bads = [
    null, [], 'x',
    { ...ok, videoName: '' }, { ...ok, videoName: 'n'.repeat(256) }, { ...ok, videoName: 1 },
    { ...ok, videoT: -1 }, { ...ok, videoT: 1.5 }, { ...ok, videoT: '1' }, { ...ok, videoT: Number.MAX_SAFE_INTEGER + 1 }, { ...ok, videoT: null },
    { ...ok, positionMs: -1 }, { ...ok, positionMs: 1.5 }, { ...ok, positionMs: MAX_POSITION_MS + 1 }, { ...ok, positionMs: '0' },
    { ...ok, text: ' ' }, { ...ok, text: 'a'.repeat(1001) },
  ];
  for (const b of bads) assert.ok(validateNewPracticeComment(b), `不可: ${JSON.stringify(b)}`);
});

test('canReadPracticeComments / canWritePracticeComment: 主体ごと', () => {
  const a = access(ORG);
  assert.equal(canReadPracticeComments(member, a), true);
  assert.equal(canWritePracticeComment(member, a), true);
  // 自組織の共有ログインは読めるが書けない
  assert.equal(canReadPracticeComments(shared, a), true);
  assert.equal(canWritePracticeComment(shared, a), false);
  // 組織未設定の共有ログイン・他組織・未ログイン
  for (const s of [sharedNoOrg, outsider, sharedOther, null, anonymous()]) {
    assert.equal(canReadPracticeComments(s, a), false);
    assert.equal(canWritePracticeComment(s, a), false);
  }
  // メンバーだが表示中の組織が別
  const multi = user('u1', [ORG, OTHER], OTHER);
  assert.equal(canReadPracticeComments(multi, a), false);
  // 組織を抜けた本人(自分の private 反省でも、組織の外になったので読めない)
  assert.equal(canReadPracticeComments(user('u1', [], null), access(ORG, 'private')), false);
  // 他人の private だけの練習は読めない
  assert.equal(canReadPracticeComments(member2, access(ORG, 'private')), false);
  // 練習が無い
  assert.equal(canReadPracticeComments(member, null), false);
});

test('他組織の public 練習を読める主体・組織の無い練習ではコメントを読めない', () => {
  const pub = access(ORG, 'public');
  // 他組織の共有ログインは public 練習を読めるが、組織の外なのでコメントは読めない
  assert.equal(canReadPracticeComments(sharedOther, pub), false);
  const noOrg = { orgId: null, tracks: [], reflections: [{ id: 'r1', visibility: 'public', ownerId: null }] };
  assert.equal(canReadPracticeComments(shared, noOrg), false);
  assert.equal(canWritePracticeComment(member, noOrg), false);
});

test('canReadVideoComment: practice は練習の access の組織と一致するときだけ。未知の scope は不可', () => {
  const c = { scope: 'practice', orgId: ORG, practiceDayId: 'pd_0000000001', authorUserId: 'u1' };
  assert.equal(canReadVideoComment(member, c, { practiceAccess: access(ORG) }), true);
  assert.equal(canReadVideoComment(member, c, { practiceAccess: null }), false, '練習が消えた');
  assert.equal(canReadVideoComment(member, c, {}), false);
  assert.equal(canReadVideoComment(member, { ...c, orgId: OTHER }, { practiceAccess: access(ORG) }), false);
  // study(③)は練習の access を見ず、コメントの組織が表示中の組織か(下の study のテスト)。他組織の study は不可。
  assert.equal(canReadVideoComment(member, { ...c, scope: 'study', orgId: OTHER }, { practiceAccess: access(OTHER) }), false);
  assert.equal(canReadVideoComment(member, { ...c, scope: 'x' }, { practiceAccess: access(ORG) }), false);
  assert.equal(canReadVideoComment(member, null, { practiceAccess: access(ORG) }), false);
});

test('編集は本人だけ。削除は本人か所属している組織の管理者。共有ログインはどちらも不可', () => {
  const c = { scope: 'practice', orgId: ORG, authorUserId: 'u1' };
  assert.equal(canEditVideoComment(member, c), true);
  assert.equal(canDeleteVideoComment(member, c), true);
  assert.equal(canEditVideoComment(member2, c), false);
  assert.equal(canDeleteVideoComment(member2, c), false);
  // 管理者は削除できるが編集はできない
  assert.equal(canEditVideoComment(member2, c), false);
  assert.equal(canDeleteVideoComment(member2, c, { isOrgAdmin: true }), true);
  // 管理者でも組織に所属していなければ不可
  assert.equal(canDeleteVideoComment(user('u2', [OTHER], OTHER), c, { isOrgAdmin: true }), false);
  for (const s of [shared, null, anonymous()]) {
    assert.equal(canEditVideoComment(s, c), false);
    assert.equal(canDeleteVideoComment(s, c, { isOrgAdmin: true }), false);
  }
  // 所属外ヘッダーの主体・未知の scope
  assert.equal(canEditVideoComment({ ...member, orgForbidden: true }, c), false);
  assert.equal(canEditVideoComment(member, { ...c, scope: 'x' }), false);
  assert.equal(canDeleteVideoComment(member, { ...c, scope: 'x' }), false);
});

// ===== ③ 勉強動画(scope 'study') =====

test('studyVideoKey: 名前 + サイズ。区切り文字が入っても衝突せず、サイズを取り出せる', () => {
  assert.equal(studyVideoKey('clip01.mp4', 1234), '["clip01.mp4",1234]');
  assert.notEqual(studyVideoKey('a",1', 2), studyVideoKey('a', 1));
  assert.notEqual(studyVideoKey('a', 12), studyVideoKey('a1', 2));
  assert.equal(studyVideoSizeOf(studyVideoKey('x[],"y', 9_007_199_254_740_991)), 9_007_199_254_740_991);
  assert.equal(studyVideoSizeOf(studyVideoKey('clip01.mp4', 0)), 0);
  for (const bad of ['not json', '["a"]', '["a",-1]', '["a",1.5]', '[1,2]']) assert.equal(studyVideoSizeOf(bad), null, bad);
});

test('validateNewStudyComment: 境界(videoName 255字・videoSize 安全な整数・positionMs 0 以上の整数・text 1〜1000字)', () => {
  const ok = { videoName: 'clip01.mp4', videoSize: 1024, positionMs: 0, text: 'ここ' };
  assert.equal(validateNewStudyComment(ok), null);
  assert.equal(validateNewStudyComment({ ...ok, videoName: 'n'.repeat(255), videoSize: 0, positionMs: MAX_POSITION_MS + 1, text: 'a'.repeat(1000) }), null,
    '勉強動画は位置の上限なし');
  assert.equal(validateNewStudyComment({ ...ok, videoSize: Number.MAX_SAFE_INTEGER, positionMs: Number.MAX_SAFE_INTEGER }), null);
  for (const b of [
    null, [], 'x', { ...ok, videoName: '' }, { ...ok, videoName: 'n'.repeat(256) }, { ...ok, videoName: 1 },
    { ...ok, videoSize: -1 }, { ...ok, videoSize: 1.5 }, { ...ok, videoSize: '1' }, { ...ok, videoSize: Number.MAX_SAFE_INTEGER + 1 },
    { ...ok, videoSize: undefined }, { ...ok, positionMs: -1 }, { ...ok, positionMs: 0.5 }, { ...ok, positionMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...ok, text: '' }, { ...ok, text: '  ' }, { ...ok, text: 'a'.repeat(1001) },
  ]) assert.equal(typeof validateNewStudyComment(b), 'string', JSON.stringify(b)?.slice(0, 60));
});

test('canReadStudyComments / canWriteStudyComment: 表示中の組織のメンバーだけ。共有ログインは読むだけ', () => {
  assert.equal(canReadStudyComments(member, ORG), true);
  assert.equal(canWriteStudyComment(member, ORG), true);
  // 所属しているが表示中の組織が別
  const two = user('u3', [ORG, OTHER], OTHER);
  assert.equal(canReadStudyComments(two, ORG), false);
  assert.equal(canReadStudyComments(two, OTHER), true);
  assert.equal(canReadStudyComments(outsider, ORG), false);
  // 自組織の共有ログインは読めるが書けない。組織の無い共有ログインは読めない
  assert.equal(canReadStudyComments(shared, ORG), true);
  assert.equal(canWriteStudyComment(shared, ORG), false);
  assert.equal(canReadStudyComments(sharedOther, ORG), false);
  assert.equal(canReadStudyComments(sharedNoOrg, null), false);
  // 組織の無い主体・未ログイン・所属外ヘッダー・組織 null
  assert.equal(canReadStudyComments(user('u4', [], null), null), false);
  for (const s of [null, anonymous()]) assert.equal(canReadStudyComments(s, ORG), false);
  assert.equal(canReadStudyComments({ ...member, orgForbidden: true }, ORG), false);
  assert.equal(canWriteStudyComment({ ...member, orgForbidden: true }, ORG), false);
  assert.equal(canReadStudyComments(member, null), false);
});

test('canReadVideoComment: study はコメントの組織が表示中の組織のときだけ(練習の access は見ない)', () => {
  const c = { scope: 'study', orgId: ORG, practiceDayId: null, authorUserId: 'u1' };
  assert.equal(canReadVideoComment(member, c), true);
  assert.equal(canReadVideoComment(shared, c), true);
  assert.equal(canReadVideoComment(outsider, c), false);
  assert.equal(canReadVideoComment(user('u3', [ORG, OTHER], OTHER), c), false, '表示中でない自分の別組織');
  assert.equal(canReadVideoComment(member, { ...c, orgId: OTHER }, { practiceAccess: access(OTHER) }), false);
  // 編集・削除の判定は②と同じ(本人・本人か管理者)
  assert.equal(canEditVideoComment(member, c), true);
  assert.equal(canEditVideoComment(member2, c), false);
  assert.equal(canDeleteVideoComment(member2, c, { isOrgAdmin: true }), true);
  assert.equal(canDeleteVideoComment(shared, c, { isOrgAdmin: true }), false);
});

test('studyVideoKey / normalizeStudyVideoName: 名前は NFC にそろえる(NFD と NFC の名前は同じキー)', () => {
  const nfd = 'プロのタック.mp4'.normalize('NFD');
  assert.notEqual(nfd, 'プロのタック.mp4');
  assert.equal(normalizeStudyVideoName(nfd), 'プロのタック.mp4');
  assert.equal(studyVideoKey(nfd, 10), studyVideoKey('プロのタック.mp4', 10));
  // 長さは NFC で数える(NFD で 255 字を超えても、NFC で 255 字以内なら通る)
  const longNfd = 'プ'.normalize('NFD').repeat(200);
  assert.ok(longNfd.length > 255);
  assert.equal(validateNewStudyComment({ videoName: longNfd, videoSize: 1, positionMs: 0, text: 'x' }), null);
});
