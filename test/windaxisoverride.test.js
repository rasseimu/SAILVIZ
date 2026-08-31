// 風軸 部分再推定（範囲選択リード直し）のコア純関数テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsv } from '../src/csv.js';
import { parseGpsPoints, rejectOutliers } from '../src/gps.js';
import { computeBounds } from '../src/projection.js';
import { estimateWindAxisSeries } from '../src/windaxis.js';
import { normalizeOverrides, applyWindAxisOverrides, pushOverrideRange } from '../src/windaxisoverride.js';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadTrack(fileName) {
  const text = readFileSync(join(__dir, '..', 'sample-data', fileName), 'utf8');
  const { header, rows } = parseCsv(text);
  const { points } = rejectOutliers(parseGpsPoints(header, rows));
  return {
    id: fileName, name: fileName, color: '#1c72b8', visible: true, points,
    bounds: computeBounds([{ visible: true, points }]),
    tRange: { start: points[0].t, end: points[points.length - 1].t },
  };
}

test('normalizeOverrides: start<end のみ採用しソートする', () => {
  const out = normalizeOverrides([
    { start: 50, end: 40 },   // 不正(start>=end) → 除外
    { start: 30, end: 35 },
    { start: 10, end: 20 },
  ]);
  assert.deepEqual(out, [{ start: 10, end: 20 }, { start: 30, end: 35 }]);
});

test('normalizeOverrides: 重なり/接触する範囲をマージする', () => {
  const out = normalizeOverrides([
    { start: 10, end: 20 },
    { start: 15, end: 25 }, // 重なり
    { start: 25, end: 30 }, // 接触(next.start == cur.end)
    { start: 40, end: 50 }, // 独立
  ]);
  assert.deepEqual(out, [{ start: 10, end: 30 }, { start: 40, end: 50 }]);
});

test('normalizeOverrides: 空/未定義は空配列', () => {
  assert.deepEqual(normalizeOverrides([]), []);
  assert.deepEqual(normalizeOverrides(undefined), []);
});

test('applyWindAxisOverrides: overrides なしは全体推定と一致(no-op)', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  const got = applyWindAxisOverrides(track, { marks: [], overrides: [] });
  assert.deepEqual(got, base);
});

test('applyWindAxisOverrides: トラック範囲外の override は no-op', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  const after = track.tRange.end + 60000;
  const got = applyWindAxisOverrides(track, {
    marks: [], overrides: [{ start: after, end: after + 60000 }],
  });
  assert.deepEqual(got, base);
});

test('applyWindAxisOverrides: 範囲外は不変・範囲内は分離推定に一致', () => {
  const track = loadTrack('Location0807.csv');
  const base = estimateWindAxisSeries(track, { marks: [] });
  // トラック中央の40%を補正範囲にする
  const span = track.tRange.end - track.tRange.start;
  const r = { start: track.tRange.start + span * 0.3, end: track.tRange.start + span * 0.7 };

  const got = applyWindAxisOverrides(track, { marks: [], overrides: [r] });

  const inR = (t) => t >= r.start && t <= r.end;
  // 範囲外: base と一致
  assert.deepEqual(
    got.filter((s) => !inR(s.tMs)),
    base.filter((s) => !inR(s.tMs)),
  );
  // 範囲内: 分離推定(その範囲の点だけ)の範囲内サンプルと一致
  const subset = track.points.filter((p) => inR(p.t));
  const local = estimateWindAxisSeries({ ...track, points: subset }, { marks: [] });
  assert.deepEqual(
    got.filter((s) => inR(s.tMs)),
    local.filter((s) => inR(s.tMs)),
  );
  // 全体は tMs 昇順
  for (let i = 1; i < got.length; i++) assert.ok(got[i].tMs >= got[i - 1].tMs);
});

test('applyWindAxisOverrides: 分離推定が空の範囲はギャップになる(補充されない)', () => {
  // 合成トラック: マニューバの無い一直線 → 分離推定は空
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    pts.push({ t: i * 1000, lat: 35.0 + i * 0.0001, lon: 139.0, speed: 4 });
  }
  const track = {
    id: 't', name: 't', color: '#1c72b8', visible: true, points: pts,
    bounds: computeBounds([{ visible: true, points: pts }]),
    tRange: { start: 0, end: 60000 },
  };
  const r = { start: 20000, end: 40000 };
  const got = applyWindAxisOverrides(track, { marks: [], overrides: [r] });
  // 範囲内サンプルは存在しない(ギャップ)
  assert.equal(got.filter((s) => s.tMs >= r.start && s.tMs <= r.end).length, 0);
});

test('pushOverrideRange: 未定義配列に範囲を足すと正規化した1件になる', () => {
  assert.deepEqual(pushOverrideRange(undefined, { start: 10, end: 20 }), [{ start: 10, end: 20 }]);
});

test('pushOverrideRange: 既存と重なる範囲はマージされる', () => {
  const out = pushOverrideRange([{ start: 10, end: 20 }], { start: 15, end: 30 });
  assert.deepEqual(out, [{ start: 10, end: 30 }]);
});

test('pushOverrideRange: 不正な範囲(start>=end)は無視される', () => {
  assert.deepEqual(pushOverrideRange([{ start: 10, end: 20 }], { start: 40, end: 40 }), [{ start: 10, end: 20 }]);
});

test('pushOverrideRange: 元配列を破壊しない', () => {
  const orig = [{ start: 10, end: 20 }];
  pushOverrideRange(orig, { start: 30, end: 40 });
  assert.deepEqual(orig, [{ start: 10, end: 20 }]);
});
