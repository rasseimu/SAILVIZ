// 今日の練習サマリの状態遷移のテスト。compute は呼び出し回数と失敗を制御できる偽物に差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshDaySummary, daySummaryAfterGpsLoad, daySummaryAfterPracticeLoad, runDaySummaryAction,
} from '../src/daysummaryflow.js';
import { daySummarySourceKey, boatLabel } from '../src/daysummary.js';

function track(id, n = 3) {
  const points = Array.from({ length: n }, (_, i) => ({
    t: 1_787_000_000_000 + i * 1000, lat: 35.3 + i * 1e-5, lon: 139.48,
  }));
  return { id, name: id, color: '#1c72b8', points, tRange: { start: points[0].t, end: points[n - 1].t } };
}

// computeDaySummary の代わり。sourceKey と艇ラベルだけ本物と同じ形で持つ。
function fakeCompute() {
  const f = (tracks) => {
    f.calls++;
    if (f.fail) throw new Error('boom');
    return {
      sourceKey: daySummarySourceKey(tracks),
      boats: tracks.map((t, index) => ({ index, ...boatLabel(t) })),
      comparison: null,
    };
  };
  f.calls = 0;
  f.fail = false;
  return f;
}
const EMPTY = { summary: null, saved: false };

// --- GPS 読込(loadFiles) ---

test('GPS読込: 初回は計算して自動表示する(未保存)', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterGpsLoad(EMPTY, [track('a')], 0, { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, true);
  assert.equal(r.saved, false);
  assert.ok(r.summary);
});

test('GPS読込: GPS が増えなければ(タグCSVだけ等)計算も自動表示もしない', () => {
  const compute = fakeCompute();
  const cur = { summary: { sourceKey: 'x' }, saved: true };
  const r = daySummaryAfterGpsLoad(cur, [track('a')], 1, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, cur.summary);
  assert.equal(r.saved, true);
});

test('GPS読込: 保存済みの練習に GPS を後付けしたら再計算して自動表示する', () => {
  const compute = fakeCompute();
  const a = track('a');
  const first = daySummaryAfterGpsLoad(EMPTY, [a], 0, { compute });
  const r = daySummaryAfterGpsLoad({ summary: first.summary, saved: true }, [a, track('b', 4)], 1, { compute });
  assert.equal(compute.calls, 2);
  assert.equal(r.autoOpen, true);
  assert.equal(r.saved, false);
  assert.equal(r.summary.boats.length, 2);
});

test('GPS読込: 計算に失敗したら自動表示せず、サマリは null・エラーを返す', () => {
  const compute = fakeCompute();
  compute.fail = true;
  const r = daySummaryAfterGpsLoad(EMPTY, [track('a')], 0, { compute });
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, null);
  assert.ok(r.error instanceof Error);
});

// --- 保存済み練習を開く(loadPractice) ---

test('練習を開く: 保存サマリが GPS と一致すれば、そのまま使い自動表示しない', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const saved = fakeCompute()(tracks);
  const r = daySummaryAfterPracticeLoad(saved, tracks, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.autoOpen, false);
  assert.equal(r.summary, saved);
  assert.equal(r.saved, true);
});

test('練習を開く: サマリが無い(機能追加前の練習)なら黙って計算し、自動表示しない', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterPracticeLoad(null, [track('a')], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, false);
  assert.equal(r.saved, false);
  assert.ok(r.summary);
});

test('練習を開く: GPS と食い違うサマリは黙って作り直し、未保存扱いにする', () => {
  const compute = fakeCompute();
  const r = daySummaryAfterPracticeLoad({ sourceKey: 'old', boats: [], comparison: null }, [track('a')], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.autoOpen, false);
  assert.equal(r.saved, false);
});

// --- 保存直前・トップバー(refreshDaySummary) ---

test('保存直前: GPS と一致していれば計算せず、保存済みのまま', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const cur = { summary: fakeCompute()(tracks), saved: true };
  const r = refreshDaySummary(cur, tracks, { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary, cur.summary);
  assert.equal(r.saved, true);
});

test('保存直前: トラック削除後は再計算する(stale のまま保存しない)', () => {
  const compute = fakeCompute();
  const a = track('a');
  const cur = { summary: fakeCompute()([a, track('b', 4)]), saved: true };
  const r = refreshDaySummary(cur, [a], { compute });
  assert.equal(compute.calls, 1);
  assert.equal(r.recomputed, true);
  assert.equal(r.summary.boats.length, 1);
  assert.equal(r.saved, false);
});

test('保存直前: 再計算に失敗したら古いサマリを残さない', () => {
  const compute = fakeCompute();
  compute.fail = true;
  const a = track('a');
  const cur = { summary: fakeCompute()([a, track('b', 4)]), saved: true };
  const r = refreshDaySummary(cur, [a], { compute });
  assert.equal(r.summary, null);
  assert.equal(r.saved, false);
  assert.ok(r.error instanceof Error);
});

test('保存直前: トラックが全部消えたらサマリは null', () => {
  const compute = fakeCompute();
  const cur = { summary: fakeCompute()([track('a')]), saved: true };
  const r = refreshDaySummary(cur, [], { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary, null);
  assert.equal(r.saved, false);
});

test('艇名・色の変更はサマリに反映し、再計算はしない(未保存になる)', () => {
  const compute = fakeCompute();
  const a = track('a');
  const cur = { summary: fakeCompute()([a]), saved: true };
  const r = refreshDaySummary(cur, [{ ...a, name: 'A艇', color: '#000000' }], { compute });
  assert.equal(compute.calls, 0);
  assert.equal(r.summary.boats[0].name, 'A艇');
  assert.equal(r.summary.boats[0].color, '#000000');
  assert.equal(r.saved, false);
});

test('再計算ボタン(force): 一致していても計算し直し、失敗なら null', () => {
  const compute = fakeCompute();
  const tracks = [track('a')];
  const cur = { summary: fakeCompute()(tracks), saved: true };
  const r = refreshDaySummary(cur, tracks, { compute, force: true });
  assert.equal(compute.calls, 1);
  assert.equal(r.saved, false);
  compute.fail = true;
  assert.equal(refreshDaySummary(cur, tracks, { compute, force: true }).summary, null);
});

// --- 導線(runDaySummaryAction) ---

function recorder(loadResult) {
  const log = [];
  const deps = {
    loadPractice: async (name) => { log.push(`load:${name}`); return loadResult; },
    showTrack: () => log.push('track'),
    setVmgOn: (on) => log.push(`vmg:${on}`),
    openReflectionEditor: async () => { log.push('reflect'); },
  };
  return { log, deps };
}

test('導線: ホームから開いて読込をキャンセルしたら軌跡画面へ行かない', async () => {
  const { log, deps } = recorder(false);
  assert.equal(await runDaySummaryAction('reflect', { fromHomeName: 'x.json' }, deps), false);
  assert.deepEqual(log, ['load:x.json']);
});

test('導線: ホームから開いたら、読み込んでから比較(VMG ON)する', async () => {
  const { log, deps } = recorder(true);
  assert.equal(await runDaySummaryAction('compare', { fromHomeName: 'x.json' }, deps), true);
  assert.deepEqual(log, ['load:x.json', 'track', 'vmg:true']);
});

test('導線: 軌跡画面から開いたときは読み込まずに反省エディタを開く', async () => {
  const { log, deps } = recorder(true);
  await runDaySummaryAction('reflect', {}, deps);
  assert.deepEqual(log, ['track', 'reflect']);
});

test('導線: 軌跡を見るは軌跡画面を出すだけ', async () => {
  const { log, deps } = recorder(true);
  await runDaySummaryAction('track', {}, deps);
  assert.deepEqual(log, ['track']);
});
