import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPoints, buildLineChart } from '../src/linechart.js';

test('projectPoints: 値→座標(y反転)・範囲外除外', () => {
  const pts = [{ tMs: 0, value: 0 }, { tMs: 10, value: 10 }, { tMs: 20, value: 5 }];
  const out = projectPoints(pts, { from: 0, to: 20, minY: 0, maxY: 10, width: 100, height: 50, pad: 0 });
  assert.deepEqual(out[0], { x: 0, y: 50 });   // value 0 → 下端
  assert.deepEqual(out[1], { x: 50, y: 0 });   // value 10 → 上端
  assert.equal(out.length, 3);
});

test('projectPoints: from/to 外は除外', () => {
  const pts = [{ tMs: 0, value: 1 }, { tMs: 100, value: 2 }];
  const out = projectPoints(pts, { from: 50, to: 100, minY: 0, maxY: 2, width: 10, height: 10, pad: 0 });
  assert.equal(out.length, 1);
});

test('buildLineChart: 艇ごとに polyline を含むSVG文字列', () => {
  const svg = buildLineChart({
    series: { 4899: [{ tMs: 0, value: 1 }, { tMs: 10, value: 3 }], 4304: [{ tMs: 0, value: 2 }] },
    boats: [4899, 4304], colors: { 4899: '#f00', 4304: '#00f' },
    from: 0, to: 10, width: 100, height: 40, pad: 2,
  });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('polyline'));
  assert.ok(svg.includes('#f00'));
  assert.ok(svg.includes('#00f'));
});

test('buildLineChart: 空系列でも <svg> を返す(polylineなし)', () => {
  const svg = buildLineChart({ series: {}, boats: [], colors: {}, from: 0, to: 1, width: 10, height: 10, pad: 1 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('polyline'));
});
