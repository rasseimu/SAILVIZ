// test/speedchart.test.js
// 速度の推移パネル用の純関数(座標はダミー)。速度は座標±5秒に統一しているため、記録 speed は使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MPS_TO_KT, windowedSpeedsMps, diffSpeedsMps, cachedWindowedSpeedsMps, windowedSpeedAt,
  bucketMsFor, speedSeries, speedChartDatasets,
} from '../src/speedchart.js';

const DEG = 1 / 111195; // 緯度 1m 相当
const pt = (t, speed, lat = 0, lon = 0) => ({ t, lat, lon, speed });
// 北へ一定速度 mps で 1Hz・n 点(t は t0 から)。記録 speed は意図的に別の値(99)にする
const run = (mps, n, t0 = 0) => Array.from({ length: n }, (_, i) => pt(t0 + i * 1000, 99, mps * i * DEG));

test('windowedSpeedsMps: 位置の揺れ(±数m)を窓で均す。1点差分より真値に近い', () => {
  // 真値 2 m/s で北へ 1Hz・60秒。各点に緯度方向 ±3m の交互誤差を足す
  const pts = Array.from({ length: 61 }, (_, i) => pt(i * 1000, null, (2 * i + (i % 2 ? 3 : -3)) * DEG));
  const w = windowedSpeedsMps(pts, { halfWindowMs: 5000 });
  for (let i = 5; i <= 55; i++) assert.ok(Math.abs(w[i] - 2) < 0.7, `${i}: ${w[i]}`);
  // 1点差分(直前の点との距離/dt)だと 2±6 m/s で揺れる
  const one = (pts[10].lat - pts[9].lat) / DEG;
  assert.ok(Math.abs(one - 2) > 3, String(one));
});

test('windowedSpeedsMps: 端は片側だけの窓、窓内に他の点がなければ隣接点で求める', () => {
  const w = windowedSpeedsMps([pt(0, null, 0), pt(1000, null, 2 * DEG), pt(60000, null, 61 * DEG)]);
  assert.ok(Math.abs(w[0] - 2) < 0.01);
  assert.ok(Math.abs(w[1] - 2) < 0.01);
  assert.ok(Math.abs(w[2] - 1) < 0.01, String(w[2])); // ±5秒に他の点がない → 直前の点から
});

test('windowedSpeedsMps: 求められない点(1点だけ・同時刻)は null', () => {
  assert.deepEqual(windowedSpeedsMps([pt(0, 1)]), [null]);
  assert.deepEqual(windowedSpeedsMps([pt(0, 1), pt(0, 1, 0.001)]), [null, null]);
});

test('cachedWindowedSpeedsMps: 同じ points 配列なら同じ結果を返す', () => {
  const pts = run(2, 10);
  assert.equal(cachedWindowedSpeedsMps(pts), cachedWindowedSpeedsMps(pts));
  assert.notEqual(cachedWindowedSpeedsMps(pts), cachedWindowedSpeedsMps(run(2, 10)));
});

test('windowedSpeedAt: 記録 speed ではなく座標±5秒の値。点の間は補間、範囲外は null', () => {
  const pts = run(3, 30);
  assert.ok(Math.abs(windowedSpeedAt(pts, 10500) - 3) < 0.01);
  assert.equal(windowedSpeedAt(pts, -1), null);
  assert.equal(windowedSpeedAt(pts, 30000), null);
  assert.equal(windowedSpeedAt([], 0), null);
});

test('diffSpeedsMps: 直前の点との距離/時間。先頭と dt<=0 は null', () => {
  const s = diffSpeedsMps([pt(0, 9, 0), pt(1000, 9, 2 * DEG), pt(1000, 9, 3 * DEG), pt(3000, 9, 7 * DEG)]);
  assert.equal(s[0], null);
  assert.ok(Math.abs(s[1] - 2) < 0.01);
  assert.equal(s[2], null);
  assert.ok(Math.abs(s[3] - 2) < 0.01);
});

test('bucketMsFor: 点数上限で幅を決め、最小幅を下回らない', () => {
  assert.equal(bucketMsFor({ start: 0, end: 60000 }), 2000);
  assert.equal(bucketMsFor({ start: 0, end: 3600000 }), 12000); // 1時間 / 300点
  assert.equal(bucketMsFor({ start: 5, end: 5 }), 2000);
});

test('speedSeries: 座標±5秒の区間平均を kt で返し、点の無い区間は null', () => {
  // 0〜4秒に 2 m/s で5点、間を空けて 20 秒以降に 4 m/s で5点
  const pts = [...run(2, 5), ...run(4, 5, 20000).map((p) => ({ ...p, lat: p.lat + 1000 * DEG }))];
  const out = speedSeries(pts, { range: { start: 0, end: 26000 }, bucketMs: 2000 });
  assert.equal(out.length, 13);
  assert.equal(out[0].x, 1000);
  assert.ok(Math.abs(out[0].y - 2 * MPS_TO_KT) < 0.01, String(out[0].y)); // 記録 speed(99)は使わない
  assert.equal(out[5].y, null);
  assert.ok(Math.abs(out[11].y - 4 * MPS_TO_KT) < 0.01, String(out[11].y));
});

test('speedSeries: offset で軸時刻へずらし、範囲外の点は数えない', () => {
  const pts = run(2, 30, 10000);
  const out = speedSeries(pts, { range: { start: 0, end: 4000 }, bucketMs: 2000, offset: 10000 });
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => Math.abs(p.y - 2 * MPS_TO_KT) < 0.01));
});

test('speedSeries: 範囲終端ちょうどの点は最後の区間に入る / 空入力は []', () => {
  const out = speedSeries(run(2, 5), { range: { start: 0, end: 4000 }, bucketMs: 2000 });
  assert.ok(out[1].y > 0);
  assert.deepEqual(speedSeries([], { range: { start: 0, end: 4000 }, bucketMs: 2000 }), []);
  assert.deepEqual(speedSeries(run(2, 2), { range: { start: 0, end: 0 }, bucketMs: 2000 }), []);
});

test('speedChartDatasets: 可視・データありの艇だけ、トラック色で。elapsed は各艇自身の開始を0に', () => {
  const a = { name: 'A', color: '#ff0000', visible: true, tRange: { start: 100000 }, points: run(1, 5, 100000) };
  const b = { name: 'B', color: '#00ff00', visible: false, tRange: { start: 0 }, points: run(1, 5) };
  const c = { name: 'C', color: '#0000ff', visible: true, tRange: { start: 500000 }, points: run(2, 5, 500000) };
  const ds = speedChartDatasets([a, b, c], { range: { start: 0, end: 4000 }, mode: 'elapsed', bucketMs: 2000 });
  assert.deepEqual(ds.map((d) => d.label), ['A', 'C']);
  assert.equal(ds[0].borderColor, '#ff0000');
  assert.equal(ds[0].fill, false);
  assert.ok(Math.abs(ds[1].data[0].y - 2 * MPS_TO_KT) < 0.01);
  // absolute では C の点は範囲外になり除外される
  const abs = speedChartDatasets([a, c], { range: { start: 100000, end: 104000 }, mode: 'absolute', bucketMs: 2000 });
  assert.deepEqual(abs.map((d) => d.label), ['A']);
});
