import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVmgChartSeries, buildVmgRankTable } from '../src/vmgview.js';

test('buildVmgChartSeries: 走種で絞りレグ中点に点を置く', () => {
  const legs = [
    { boatId: 'A', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.5 },
    { boatId: 'A', startT: 200, endT: 300, pointOfSail: 'downwind', meanVmg: 3.1 },
  ];
  const up = buildVmgChartSeries(legs, 'upwind');
  assert.deepEqual(up.boats, ['A']);
  assert.equal(up.series.A.length, 1);
  assert.equal(up.series.A[0].tMs, 50);
  assert.equal(up.series.A[0].value, 2.5);
});

test('buildVmgRankTable: 首位艇に is-top を付与', () => {
  const rows = [
    { boatId: 'A', pointOfSail: 'upwind', meanVmg: 2.5, winRatio: 1, legCount: 1, bestLegVmg: 2.5 },
    { boatId: 'B', pointOfSail: 'upwind', meanVmg: 2.0, winRatio: 0, legCount: 1, bestLegVmg: 2.0 },
  ];
  const html = buildVmgRankTable(rows, { colors: { A: '#a', B: '#b' }, pointOfSail: 'upwind' });
  assert.ok(html.includes('is-top'));
  assert.ok(html.indexOf('A') < html.indexOf('B')); // 先頭がA
});
