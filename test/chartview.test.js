import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChartDatasets } from '../src/chartview.js';

const COLORS = { 4899: '#f00', 4304: '#00f' };

test('buildChartDatasets: 艇ごとに {label,data:{x,y},borderColor}', () => {
  const series = { 4899: [{ tMs: 100, value: 6750 }, { tMs: 200, value: 6740 }], 4304: [{ tMs: 100, value: 6800 }] };
  const ds = buildChartDatasets({ series, boats: [4899, 4304], colors: COLORS });
  assert.equal(ds.length, 2);
  assert.equal(ds[0].label, '4899');
  assert.deepEqual(ds[0].data, [{ x: 100, y: 6750 }, { x: 200, y: 6740 }]);
  assert.equal(ds[0].borderColor, '#f00');
  assert.equal(ds[1].label, '4304');
});

test('buildChartDatasets: データ無し艇は除外', () => {
  const series = { 4899: [{ tMs: 1, value: 2 }] }; // 4304 は無し
  const ds = buildChartDatasets({ series, boats: [4899, 4304], colors: COLORS });
  assert.equal(ds.length, 1);
  assert.equal(ds[0].label, '4899');
});

test('buildChartDatasets: 空でも配列を返す', () => {
  assert.deepEqual(buildChartDatasets({ series: {}, boats: [], colors: COLORS }), []);
});
