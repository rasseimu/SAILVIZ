// test/videocommentsmodel.test.js — 動画の瞬間コメントの表示用の純関数。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  practiceVideoMatch, sortByPosition, commentsForVideo, activeCommentsAt, validateDraft, positionMsOf, seekTimeFor,
  formatCommentDate, COMMENT_SHOW_MS,
} from '../src/videocommentsmodel.js';

const c = (id, positionMs, over = {}) => ({ id, videoName: 'a.mp4', videoT: 1000, positionMs, text: id, ...over });

test('practiceVideoMatch: name と丸めた t の両方が一致するものだけ', () => {
  const m = practiceVideoMatch({ name: 'a.mp4', t: 1000.4 });
  assert.equal(m(c('x', 0)), true);
  assert.equal(m(c('x', 0, { videoT: 1001 })), false);
  assert.equal(m(c('x', 0, { videoName: 'b.mp4' })), false);
  assert.equal(m(null), false);
  assert.equal(practiceVideoMatch({ name: 'a.mp4', t: 999.6 })(c('x', 0)), true);
});

test('sortByPosition は安定で元の配列を変えない', () => {
  const list = [c('b', 5), c('a', 1), c('c', 5), c('d', 0)];
  const copy = [...list];
  assert.deepEqual(sortByPosition(list).map((x) => x.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(list, copy);
  assert.deepEqual(sortByPosition(null), []);
});

test('commentsForVideo は開いている動画の分だけを位置順に', () => {
  const list = [c('b', 5), c('other', 1, { videoName: 'b.mp4' }), c('a', 1)];
  assert.deepEqual(commentsForVideo(list, practiceVideoMatch({ name: 'a.mp4', t: 1000 })).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(commentsForVideo(list, null), []);
  assert.deepEqual(commentsForVideo(undefined, () => true), []);
});

test('activeCommentsAt は [位置, 位置 + 4000) の半開区間', () => {
  assert.equal(COMMENT_SHOW_MS, 4000);
  const list = [c('a', 1000), c('b', 3000)];
  assert.deepEqual(activeCommentsAt(list, 999).map((x) => x.id), []);
  assert.deepEqual(activeCommentsAt(list, 1000).map((x) => x.id), ['a']);
  assert.deepEqual(activeCommentsAt(list, 4999).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(activeCommentsAt(list, 5000).map((x) => x.id), ['b']);
  assert.deepEqual(activeCommentsAt(list, 7000).map((x) => x.id), []);
  assert.deepEqual(activeCommentsAt(list, 1500, 100).map((x) => x.id), []);
  assert.deepEqual(activeCommentsAt(list, NaN), []);
});

test('validateDraft: 空・空白だけ・1001字は不可', () => {
  assert.equal(validateDraft('a'), null);
  assert.equal(validateDraft('あ'.repeat(1000)), null);
  for (const bad of ['', '  \n', 'a'.repeat(1001), null, undefined]) assert.ok(validateDraft(bad));
});

test('positionMsOf / seekTimeFor', () => {
  assert.equal(positionMsOf(12.3456), 12346);
  assert.equal(positionMsOf(0), 0);
  assert.equal(positionMsOf(-1), 0);
  assert.equal(positionMsOf(NaN), 0);
  assert.equal(seekTimeFor(12_340, 60), 12.34);
  assert.equal(seekTimeFor(90_000, 60), 60, '動画の長さで丸める');
  assert.equal(seekTimeFor(90_000, NaN), 90, '長さが分からなければそのまま');
  assert.equal(seekTimeFor(-5, 60), 0);
});

test('formatCommentDate は日本時間で YYYY/MM/DD HH:MM', () => {
  assert.equal(formatCommentDate(Date.UTC(2026, 9, 28, 3, 4)), '2026/10/28 12:04');
  assert.equal(formatCommentDate(NaN), '');
  assert.equal(formatCommentDate(undefined), '');
});
