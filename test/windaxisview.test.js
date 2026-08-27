import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindAxisDatasets } from '../src/windaxisview.js';

test('buildWindAxisDatasets: 推定風向データセットを作る', () => {
  const series = [
    { tMs: 0, windFromDeg: 10, source: 'anchor', confidence: 1 },
    { tMs: 1000, windFromDeg: 12, source: 'leg', confidence: 0.4 },
  ];
  const { datasets } = buildWindAxisDatasets({ series, amedas: [] });
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].data.length, 2);
  assert.deepEqual(datasets[0].data[0], { x: 0, y: 10 });
});

test('buildWindAxisDatasets: amedas参考ラインを追加', () => {
  const { datasets } = buildWindAxisDatasets({
    series: [{ tMs: 0, windFromDeg: 10, source: 'anchor', confidence: 1 }],
    amedas: [{ obsMs: 0, dirDeg: 200 }],
  });
  assert.equal(datasets.length, 2);
  assert.ok(datasets[1].borderDash);
});
