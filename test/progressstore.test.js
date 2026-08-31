import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, WIND_BINS, loadProgress, saveProgress,
  setIssueStage, setGoalDone, setTextOverride, windBinKey, summarize,
  addComment, hasAiComment,
} from '../src/progressstore.js';

test('addComment: metaなしは{text,ts}のまま(後方互換)', () => {
  const o = addComment({}, 'r1', 'goal', 'やる', 111);
  assert.deepEqual(o.r1.comments.goal, [{ text: 'やる', ts: 111 }]);
});

test('addComment: metaでai/url/titleを付与', () => {
  const o = addComment({}, 'r1', 'issue', 'AI助言', 222, { ai: true, url: 'u', title: 't' });
  assert.deepEqual(o.r1.comments.issue, [{ text: 'AI助言', ts: 222, ai: true, url: 'u', title: 't' }]);
});

test('hasAiComment: 同reflId×field×urlの既存AIコメントを検知', () => {
  let o = addComment({}, 'r1', 'goal', 'x', 1, { ai: true, url: 'U1', title: 't' });
  assert.equal(hasAiComment(o, 'r1', 'goal', 'U1'), true);
  assert.equal(hasAiComment(o, 'r1', 'goal', 'U2'), false);
  assert.equal(hasAiComment(o, 'r1', 'issue', 'U1'), false);
  // 人間コメント(ai無し・url無し)は対象外
  o = addComment(o, 'r1', 'goal', 'human', 2);
  assert.equal(hasAiComment(o, 'r1', 'goal', undefined), false);
});

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// 反省の最小スタブ(progress が使う field のみ)。
function refl(id, fullName, dateMs, { goal = '', issue = '', discovery = '', speed = null } = {}) {
  return {
    id, people: [fullName], practice: { date: '2026-08-28', startMs: dateMs },
    createdAt: dateMs, notes: { goal, issue, discovery }, wind: speed == null ? null : { speed },
  };
}

test('load/save 往復', () => {
  const st = memStorage();
  saveProgress({ r1: { issueStage: 2, goalDone: true } }, st);
  assert.equal(st.getItem(STORAGE_KEY), '{"r1":{"issueStage":2,"goalDone":true}}');
  assert.deepEqual(loadProgress(st), { r1: { issueStage: 2, goalDone: true } });
});

test('loadProgress は空/壊れ入力で {} を返す', () => {
  assert.deepEqual(loadProgress(memStorage()), {});
  assert.deepEqual(loadProgress(memStorage({ [STORAGE_KEY]: 'not json' })), {});
});

test('setIssueStage/setGoalDone は不変更新で新オブジェクトを返す', () => {
  const a = {};
  const b = setIssueStage(a, 'r1', 1);
  assert.notEqual(a, b);
  assert.deepEqual(b, { r1: { issueStage: 1, goalDone: false } });
  const c = setGoalDone(b, 'r1', true);
  assert.deepEqual(c.r1, { issueStage: 1, goalDone: true });
  assert.deepEqual(b.r1, { issueStage: 1, goalDone: false }); // b は不変
});

test('setTextOverride は不変更新で reflId 単位に field を上書き保存', () => {
  const a = {};
  const b = setTextOverride(a, 'r1', 'goal', '直したい目標');
  assert.notEqual(a, b);
  assert.deepEqual(b, { r1: { issueStage: 0, goalDone: false, text: { goal: '直したい目標' } } });
  // 既存の進捗トグルは保持しつつ別 field を足す
  const c = setTextOverride(setIssueStage(b, 'r1', 2), 'r1', 'issue', '直した課題');
  assert.equal(c.r1.issueStage, 2);
  assert.deepEqual(c.r1.text, { goal: '直したい目標', issue: '直した課題' });
  // 空文字は上書きを削除(元テキストに戻す)
  const d = setTextOverride(c, 'r1', 'goal', '');
  assert.deepEqual(d.r1.text, { issue: '直した課題' });
  assert.deepEqual(b.r1.text, { goal: '直したい目標' }); // b は不変
});

test('summarize は text オーバーレイがあれば反省テキストより優先する', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { goal: '元目標', issue: '元課題', discovery: '元発見', speed: 2 }),
  ];
  const progress = { r1: { text: { goal: '新目標', issue: '新課題', discovery: '新発見' } } };
  const s = summarize(reflections, progress);
  const b = s.byMember['本間 由真'];
  assert.equal(b.goals[0].text, '新目標');
  assert.equal(b.issues[0].text, '新課題');
  assert.equal(b.discoveriesByBin[WIND_BINS[0].key][0].text, '新発見');
});

test('summarize は元反省に無い項目は text オーバーレイでも新規追加しない', () => {
  const reflections = [refl('r1', '本間 由真', 1000, { goal: '目標のみ' })];
  const progress = { r1: { text: { issue: '存在しない課題' } } };
  const s = summarize(reflections, progress);
  const b = s.byMember['本間 由真'];
  assert.equal(b.goals.length, 1);
  assert.equal(b.issues.length, 0);
});

test('windBinKey は境界とnullを正しく分類', () => {
  assert.equal(windBinKey(2.9), WIND_BINS[0].key);
  assert.equal(windBinKey(3), WIND_BINS[1].key);
  assert.equal(windBinKey(6), WIND_BINS[2].key);
  assert.equal(windBinKey(null), 'unknown');
});

test('summarize は部員別に目標/課題/発見(風速ビン)を束ねる', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { goal: 'ジャイブ', issue: '起こし', discovery: '微風は無操作', speed: 2 }),
    refl('r2', '本間 由真', 2000, { goal: 'クローズ', issue: '角度', discovery: 'ブロー対応', speed: 7 }),
    refl('r3', '風間 大煕', 1000, { goal: 'リーチ', issue: '閉じ過ぎ', discovery: '', speed: 5 }),
  ];
  const progress = { r1: { issueStage: 2, goalDone: true }, r2: { issueStage: 1, goalDone: false } };
  const s = summarize(reflections, progress);
  const yuma = s.byMember['本間 由真'];
  assert.equal(yuma.issues.length, 2);
  assert.equal(yuma.issues[0].stage, 2);
  assert.equal(yuma.goals[0].done, true);
  assert.equal(yuma.discoveriesByBin[WIND_BINS[0].key][0].text, '微風は無操作'); // speed2 → <3
  assert.equal(yuma.discoveriesByBin[WIND_BINS[2].key][0].text, 'ブロー対応');   // speed7 → >=6
});

test('summarize.resolutionSeries は解決課題の累計を練習日昇順で出す', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { issue: 'a' }),
    refl('r2', '本間 由真', 2000, { issue: 'b' }),
    refl('r3', '風間 大煕', 1500, { issue: 'c' }),
  ];
  const progress = { r1: { issueStage: 2 }, r2: { issueStage: 2 }, r3: { issueStage: 2 } };
  const s = summarize(reflections, progress);
  assert.deepEqual(s.resolutionSeries.all.map((p) => p.value), [1, 2, 3]); // 1000,1500,2000 で累計
  assert.deepEqual(s.resolutionSeries['本間 由真'].map((p) => p.value), [1, 2]);
});

test('summarize.issueAddedSeries は課題追加(ステージ無関係)の累計を練習日昇順で出す', () => {
  const reflections = [
    refl('r1', '本間 由真', 1000, { issue: 'a' }),
    refl('r2', '本間 由真', 2000, { issue: 'b' }),
    refl('r3', '風間 大煕', 1500, { issue: 'c' }),
    refl('r4', '本間 由真', 3000, { goal: '目標のみ' }), // 課題なし→加算されない
  ];
  const progress = { r1: { issueStage: 2 } }; // 解決状況に依らず追加は数える
  const s = summarize(reflections, progress);
  assert.deepEqual(s.issueAddedSeries.all.map((p) => [p.dateMs, p.value]), [[1000, 1], [1500, 2], [2000, 3]]);
  assert.deepEqual(s.issueAddedSeries['本間 由真'].map((p) => p.value), [1, 2]);
});

test('summarize.firstDateMs は scope ごとの最初の反省日(課題有無に依らない)', () => {
  const reflections = [
    refl('r1', '本間 由真', 2000, { goal: '目標のみ' }), // 課題なしでも最初の反省
    refl('r2', '本間 由真', 3000, { issue: 'b' }),
    refl('r3', '風間 大煕', 1500, { issue: 'c' }),
  ];
  const s = summarize(reflections, {});
  assert.equal(s.firstDateMs.all, 1500);        // 全体では風間の1500が最古
  assert.equal(s.firstDateMs['本間 由真'], 2000); // 本間は2000が最古
  assert.equal(s.firstDateMs['風間 大煕'], 1500);
});
