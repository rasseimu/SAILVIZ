import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, WIND_BINS, loadProgress, saveProgress,
  setIssueStage, setGoalDone, windBinKey, summarize,
} from '../src/progressstore.js';

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
