import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpsPoints } from '../src/gps.js';

const HEADER = ['time', 'latitude', 'longitude', 'speed', 'bearing', 'horizontalAccuracy'];

test('parses rows into sorted points with ns->ms', () => {
  // 実データ相当の Sensor Logger ns（いずれも >1e15 で ns->ms 変換が一様に効く）
  const rows = [
    ['1786078534949943000', '35.3', '139.48', '1.5', '90', '20'], // 後 -> pts[1]
    ['1786078509603689000', '35.1', '139.40', '2.5', '80', '30'], // 先 -> pts[0]
  ];
  const pts = parseGpsPoints(HEADER, rows);
  assert.equal(pts.length, 2);
  assert.ok(pts[0].t < pts[1].t, 'sorted ascending by t');
  assert.equal(pts[0].lat, 35.1);
  assert.equal(pts[0].speed, 2.5);
  assert.equal(pts[1].accuracy, 20);
});

test('skips rows with invalid lat/lon/time', () => {
  const rows = [
    ['1000000000000000', '35.3', '139.48', '', '', ''],
    ['bad', '35.3', '139.48', '', '', ''],
    ['1000000000000001', '999', '139.48', '', '', ''],   // lat out of range
    ['1000000000000002', '35.3', '', '', '', ''],         // lon NaN
  ];
  const pts = parseGpsPoints(HEADER, rows);
  assert.equal(pts.length, 1);
});

test('optional missing columns become null', () => {
  const pts = parseGpsPoints(['time', 'latitude', 'longitude'],
    [['1000000000000000', '35.3', '139.48']]);
  assert.equal(pts[0].speed, null);
  assert.equal(pts[0].bearing, null);
  assert.equal(pts[0].accuracy, null);
});

import { rejectOutliers, haversineMeters, MAX_SPEED_MPS } from '../src/gps.js';

test('haversine ~111km per degree latitude', () => {
  const d = haversineMeters({ lat: 35, lon: 139 }, { lat: 36, lon: 139 });
  assert.ok(Math.abs(d - 111000) < 500, `got ${d}`);
});

test('rejects a spike point', () => {
  // 1秒ごとに緯度がわずかに動く現実的な列に、1点だけ遠方スパイクを差し込む
  const base = [
    { t: 0, lat: 35.300, lon: 139.480 },
    { t: 1000, lat: 35.3001, lon: 139.4801 },
    { t: 2000, lat: 40.000, lon: 145.000 }, // spike (>25 m/s)
    { t: 3000, lat: 35.3002, lon: 139.4802 },
  ];
  const { points, removed } = rejectOutliers(base);
  assert.equal(removed, 1);
  assert.equal(points.length, 3);
  assert.ok(!points.some((p) => p.lat === 40));
});

test('drops duplicate/backwards timestamps', () => {
  const { points, removed } = rejectOutliers([
    { t: 0, lat: 35.30, lon: 139.48 },
    { t: 0, lat: 35.30, lon: 139.48 }, // dt<=0
  ]);
  assert.equal(points.length, 1);
  assert.equal(removed, 1);
});

test('MAX_SPEED_MPS is 25', () => {
  assert.equal(MAX_SPEED_MPS, 25);
});
