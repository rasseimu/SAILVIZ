// test/maneuverspeed.test.js
// タック/ジャイブ前後の減速(座標はダミー)。検出は test/maneuverdetect.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speedAround, maneuverSpeedRows, topByKind, dropImplausibleManeuvers, maneuverAxisMarks } from '../src/maneuverspeed.js';
import { MPS_TO_KT } from '../src/speedchart.js';

const DEG = 1 / 111195; // 緯度 1m 相当

test('speedAround: 前後3秒の入り・最低・出と減速', () => {
  const points = Array.from({ length: 11 }, (_, i) => ({ t: i * 1000 }));
  const speeds = [9, 9, 4, 3, 2, 1.5, 2, 3, 3.5, 9, 9];
  const s = speedAround(points, speeds, 5000);
  assert.deepEqual(s, { entry: 4, min: 1.5, exit: 3.5, drop: 2.5 }); // 窓は 2〜8 秒
});

test('speedAround: 片側に点が無い・点不足・速度 null は除外して判断', () => {
  const points = Array.from({ length: 4 }, (_, i) => ({ t: i * 1000 }));
  assert.equal(speedAround(points, [1, 1, 1, 1], 10000), null); // 窓に点が無い
  assert.equal(speedAround(points, [1, null, null, null], 1000), null); // 有効な点が1点
  assert.equal(speedAround(points, [null, null, 2, 2], 1000), null); // 時刻より前に点が無い
  assert.deepEqual(speedAround(points, [null, 2, 1, 3], 1000), { entry: 2, min: 1, exit: 3, drop: 1 });
});

// 1Hz・41秒。20秒で進路を before → after に変え、その前後2秒は dipMps に減速(速度は座標から求まる)
function trackWithDip(name, dipMps, { before = 315, after = 45 } = {}) {
  const points = [];
  let lat = 0, lon = 0;
  for (let i = 0; i <= 40; i++) {
    const v = Math.abs(i - 20) <= 2 ? dipMps : 3;
    const h = (i <= 20 ? before : after) * Math.PI / 180;
    lat += v * Math.cos(h) * DEG; lon += v * Math.sin(h) * DEG;
    points.push({ t: i * 1000, lat, lon, speed: 99 });
  }
  return { name, points };
}

test('maneuverSpeedRows: マニューバの時刻で前後3秒を切り出し、種別・位置はそのまま。切り出せないものは除外', () => {
  const tr = trackWithDip('t', 1);
  const rows = maneuverSpeedRows(tr, [
    { tMs: 20000, lat: 1, lon: 2, kind: 'tack' },
    { tMs: 39000, lat: 0, lon: 0, kind: 'tack' }, // 後ろ3秒が記録の外 → 窓の端に点がある限りは切り出す
    { tMs: 90000, lat: 0, lon: 0, kind: 'gybe' }, // 記録の外
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].track, tr);
  assert.deepEqual([rows[0].tMs, rows[0].lat, rows[0].lon, rows[0].kind], [20000, 1, 2, 'tack']);
  assert.ok(rows[0].dropKt > 2, String(rows[0].dropKt)); // 3 → 1 m/s の減速(±2秒で均しても残る)
  assert.ok(rows[0].entryKt < 99 * MPS_TO_KT); // 記録 speed(99)は使わない
});

test('topByKind: 種別ごとに減速の小さい順、件数で切り、同じ減速なら入りの速い方が上', () => {
  const r = (kind, dropKt, entryKt) => ({ kind, dropKt, entryKt });
  const rows = [r('tack', 1, 5), r('tack', 0.5, 4), r('gybe', 0.1, 6), r('tack', 0.5, 6), r('tack', 2, 6), r('gybe', 0.3, 6)];
  assert.deepEqual(topByKind(rows, 'tack', 3).map((x) => [x.dropKt, x.entryKt]), [[0.5, 6], [0.5, 4], [1, 5]]);
  assert.deepEqual(topByKind(rows, 'gybe', 3).map((x) => x.dropKt), [0.1, 0.3]);
});

test('maneuverSpeedRows / topByKind: 減速が小さい艇のタックが上', () => {
  const tackAt20 = { tMs: 20000, lat: 0, lon: 0, kind: 'tack' };
  const good = trackWithDip('good', 2.5);
  const bad = trackWithDip('bad', 0.5);
  const rows = [...maneuverSpeedRows(bad, [tackAt20]), ...maneuverSpeedRows(good, [tackAt20])];
  assert.deepEqual(topByKind(rows, 'tack').map((x) => x.track.name), ['good', 'bad']);
});

test('dropImplausibleManeuvers: 減速が 0.1kt 未満のタックは誤検出として除く。ジャイブはそのまま', () => {
  const r = (kind, dropKt) => ({ kind, dropKt });
  const rows = [r('tack', 0), r('tack', 0.04), r('tack', 0.1), r('tack', 1.2), r('gybe', 0), r('gybe', 0.3)];
  assert.deepEqual(dropImplausibleManeuvers(rows).map((x) => `${x.kind}:${x.dropKt}`), ['tack:0.1', 'tack:1.2', 'gybe:0', 'gybe:0.3']);
  assert.equal(dropImplausibleManeuvers(rows, { minTackDropKt: 0 }).length, 6);
  assert.deepEqual(dropImplausibleManeuvers(undefined), []);
});

test('maneuverAxisMarks: 表示中の艇の印を軸時刻で返す。範囲外・非表示の艇は除き、艇ごとに段を分ける', () => {
  const a = { color: '#f00', tRange: { start: 1000 } }, b = { color: '#00f', tRange: { start: 5000 } }, hidden = { tRange: { start: 0 } };
  const rows = [
    { track: a, tMs: 3000, kind: 'tack', rank: 1 },
    { track: b, tMs: 9000, kind: 'gybe' },
    { track: b, tMs: 99000, kind: 'tack' }, // 範囲外
    { track: hidden, tMs: 3000, kind: 'tack' },
  ];
  assert.deepEqual(maneuverAxisMarks(rows, [a, b], { mode: 'absolute', min: 0, max: 10000 }), [
    { x: 3000, kind: 'tack', rank: 1, color: '#f00', lane: 0 },
    { x: 9000, kind: 'gybe', rank: null, color: '#00f', lane: 1 },
  ]);
  // elapsed は各艇自身の開始を0に
  assert.deepEqual(maneuverAxisMarks(rows, [a, b], { mode: 'elapsed', min: 0, max: 5000 }).map((m) => m.x), [2000, 4000]);
});
