import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGpsPoints, rejectOutliers, haversineMeters, MAX_SPEED_MPS, ACCURACY_FILTER_M,
  filterPointsWithExclusions, prepareTrackPoints,
} from '../src/gps.js';

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

test('threshold is used: ~24 m/s kept, ~26 m/s rejected', () => {
  // 緯度1度 ≈ 111000 m。dt=1000ms のとき、緯度差 d 度 -> 速度 ≈ d*111000 m/s
  const dLatFor = (mps) => mps / 111000; // 目標速度に対応する緯度差
  const kept = rejectOutliers([
    { t: 0, lat: 35.0, lon: 139.0 },
    { t: 1000, lat: 35.0 + dLatFor(24), lon: 139.0 }, // ~24 m/s
  ]);
  assert.equal(kept.removed, 0, '24 m/s point kept');
  const rej = rejectOutliers([
    { t: 0, lat: 35.0, lon: 139.0 },
    { t: 1000, lat: 35.0 + dLatFor(26), lon: 139.0 }, // ~26 m/s
  ]);
  assert.equal(rej.removed, 1, '26 m/s point rejected');
});

test('ACCURACY_FILTER_M は 50m、読込時の MAX_SPEED_MPS は 25 m/s のまま', () => {
  assert.equal(ACCURACY_FILTER_M, 50);
  assert.equal(MAX_SPEED_MPS, 25);
});

// --- filterPointsWithExclusions / prepareTrackPoints(読込時の除外区間) ---
// 合成座標のみ。1秒ごとに北へ5m進む点(精度は既定 5m)。
const M_LAT = 1 / 111320;
const pt = (sec, { acc = 5, jumpM = 0 } = {}) => ({
  t: sec * 1000, lat: 35 + (sec * 5 + jumpM) * M_LAT, lon: 139, speed: 5, bearing: 0, accuracy: acc,
});

test('filterPointsWithExclusions: 正常 → 精度500m → 正常 で中間点を除き、前後の採用点の区間を accuracy で記録', () => {
  const r = filterPointsWithExclusions([pt(0), pt(1, { acc: 500 }), pt(2)], { accuracyFilter: true });
  assert.deepEqual(r.points.map((p) => p.t), [0, 2000]);
  assert.deepEqual(r.excludedIntervals, [{ lo: 0, hi: 2000, code: 'accuracy' }]);
  assert.equal(r.removed, 0, 'removed は外れ値の数(精度フィルタ分は含めない)');
});

test('filterPointsWithExclusions: 連続した複数の除外は両端の採用点どうしの区間1つに結合', () => {
  const r = filterPointsWithExclusions(
    [pt(0), pt(1, { acc: 500 }), pt(2, { acc: 80 }), pt(3, { acc: 500 }), pt(4), pt(5), pt(6, { acc: 60 }), pt(7)],
    { accuracyFilter: true },
  );
  assert.deepEqual(r.points.map((p) => p.t), [0, 4000, 5000, 7000]);
  assert.deepEqual(r.excludedIntervals, [
    { lo: 0, hi: 4000, code: 'accuracy' },
    { lo: 5000, hi: 7000, code: 'accuracy' },
  ]);
});

test('filterPointsWithExclusions: 先頭側は除外点〜次の採用点、末尾側は前の採用点〜除外点', () => {
  const r = filterPointsWithExclusions(
    [pt(0, { acc: 500 }), pt(1, { acc: 500 }), pt(2), pt(3), pt(4, { acc: 500 })],
    { accuracyFilter: true },
  );
  assert.deepEqual(r.points.map((p) => p.t), [2000, 3000]);
  assert.deepEqual(r.excludedIntervals, [
    { lo: 0, hi: 2000, code: 'accuracy' },
    { lo: 3000, hi: 4000, code: 'accuracy' },
  ]);
});

test('filterPointsWithExclusions: 速度で除いた点は speed で記録(rejectOutliers と同じ点を残す)', () => {
  const input = [pt(0), pt(1), pt(2, { jumpM: 100 }), pt(3), pt(4)]; // 2秒目だけ北へ100m跳ぶ
  const r = filterPointsWithExclusions(input);
  const ref = rejectOutliers(input);
  assert.deepEqual(r.points, ref.points);
  assert.equal(r.removed, ref.removed);
  assert.deepEqual(r.points.map((p) => p.t), [0, 1000, 3000, 4000]);
  assert.deepEqual(r.excludedIntervals, [{ lo: 1000, hi: 3000, code: 'speed' }]);
});

test('filterPointsWithExclusions: 精度と速度の区間はコードが違えば重なってよい', () => {
  // 1秒目: 精度で除外、2秒目: 0秒目から見て 100m 跳び → 速度で除外
  const r = filterPointsWithExclusions([pt(0), pt(1, { acc: 500 }), pt(2, { jumpM: 100 }), pt(3)], { accuracyFilter: true });
  assert.deepEqual(r.points.map((p) => p.t), [0, 3000]);
  assert.deepEqual(r.excludedIntervals, [
    { lo: 0, hi: 3000, code: 'accuracy' },
    { lo: 0, hi: 3000, code: 'speed' },
  ]);
});

test('filterPointsWithExclusions: accuracyFilter: false(既定)は精度で除かず、区間も記録しない', () => {
  const input = [pt(0), pt(1, { acc: 500 }), pt(2)];
  const r = filterPointsWithExclusions(input);
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.excludedIntervals, []);
  const off = filterPointsWithExclusions(input, { accuracyFilter: false });
  assert.deepEqual(off.excludedIntervals, []);
});

test('filterPointsWithExclusions: 精度 null は残す(既存 addTrack と同じ条件)', () => {
  const r = filterPointsWithExclusions([pt(0), { ...pt(1), accuracy: null }, pt(2)], { accuracyFilter: true });
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.excludedIntervals, []);
});

test('filterPointsWithExclusions: dt <= 0 で除いた点は長さ0なので記録しない', () => {
  const r = filterPointsWithExclusions([pt(0), pt(1), { ...pt(1), lat: 35 }, pt(2)]);
  assert.deepEqual(r.points.map((p) => p.t), [0, 1000, 2000]);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.excludedIntervals, []);
});

test('filterPointsWithExclusions: 空・全点除外でも例外を出さない', () => {
  assert.deepEqual(filterPointsWithExclusions([]), { points: [], removed: 0, excludedIntervals: [] });
  const all = filterPointsWithExclusions([pt(0, { acc: 500 }), pt(1, { acc: 500 })], { accuracyFilter: true });
  assert.deepEqual(all.points, []);
  assert.deepEqual(all.excludedIntervals, []);
});

test('prepareTrackPoints: CSV 行から点と除外区間を作る(精度フィルタのオン/オフ)', () => {
  const rows = [
    ['0', '35.00000', '139', '5', '0', '5'],
    ['1000', '35.00005', '139', '5', '0', '500'],
    ['2000', '35.00009', '139', '5', '0', '5'],
  ];
  const on = prepareTrackPoints(HEADER, rows, { accuracyFilter: true });
  assert.deepEqual(on.points.map((p) => p.t), [0, 2000]);
  assert.deepEqual(on.excludedIntervals, [{ lo: 0, hi: 2000, code: 'accuracy' }]);
  const off = prepareTrackPoints(HEADER, rows, { accuracyFilter: false });
  assert.equal(off.points.length, 3);
  assert.deepEqual(off.excludedIntervals, []);
});
