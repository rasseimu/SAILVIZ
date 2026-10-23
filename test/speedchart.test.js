// test/speedchart.test.js
// 速度の推移パネル用の純関数(座標はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MPS_TO_KT, windowedSpeedsMps, diffSpeedsMps, speedsBySource, pointSpeedsMps, bucketMsFor, speedSeries, speedChartDatasets } from '../src/speedchart.js';

const pt = (t, speed, lat = 0, lon = 0) => ({ t, lat, lon, speed });

test('pointSpeedsMps: 有効な記録 speed はそのまま、負値・null は座標から補う', () => {
  // 緯度 0.001° ≒ 111.2m を 10 秒 → 約 11.1 m/s
  const s = pointSpeedsMps([pt(0, 2), pt(10000, -1, 0.001), pt(20000, null, 0.002), pt(30000, 3, 0.003)]);
  assert.equal(s[0], 2);
  assert.ok(Math.abs(s[1] - 11.12) < 0.05, String(s[1]));
  assert.ok(Math.abs(s[2] - 11.12) < 0.05, String(s[2]));
  assert.equal(s[3], 3);
});

test('pointSpeedsMps: 求められない点(1点だけ・同時刻)は null', () => {
  assert.deepEqual(pointSpeedsMps([pt(0, -1)]), [null]);
  assert.deepEqual(pointSpeedsMps([pt(0, -1), pt(0, null, 0.001)]), [null, null]);
});

test('windowedSpeedsMps: 位置の揺れ(±数m)を窓で均す。1点差分より真値に近い', () => {
  // 真値 2 m/s で北へ 1Hz・60秒。各点に緯度方向 ±3m の交互誤差を足す
  const deg = 1 / 111195;
  const pts = Array.from({ length: 61 }, (_, i) => pt(i * 1000, null, (2 * i + (i % 2 ? 3 : -3)) * deg));
  const w = windowedSpeedsMps(pts, { halfWindowMs: 5000 });
  for (let i = 5; i <= 55; i++) assert.ok(Math.abs(w[i] - 2) < 0.7, `${i}: ${w[i]}`);
  // 1点差分(直前の点との距離/dt)だと 2±6 m/s で揺れる
  const one = (pts[10].lat - pts[9].lat) / deg;
  assert.ok(Math.abs(one - 2) > 3, String(one));
});

test('windowedSpeedsMps: 端は片側だけの窓、窓内に他の点がなければ隣接点で求める', () => {
  const deg = 1 / 111195;
  const w = windowedSpeedsMps([pt(0, null, 0), pt(1000, null, 2 * deg), pt(60000, null, 61 * deg)]);
  assert.ok(Math.abs(w[0] - 2) < 0.01);
  assert.ok(Math.abs(w[1] - 2) < 0.01);
  assert.ok(Math.abs(w[2] - 1) < 0.01, String(w[2])); // ±5秒に他の点がない → 直前の点から
});

test('bucketMsFor: 点数上限で幅を決め、最小幅を下回らない', () => {
  assert.equal(bucketMsFor({ start: 0, end: 60000 }), 2000);
  assert.equal(bucketMsFor({ start: 0, end: 3600000 }), 12000); // 1時間 / 300点
  assert.equal(bucketMsFor({ start: 5, end: 5 }), 2000);
});

test('speedSeries: 区間平均を kt で返し、点の無い区間は null', () => {
  const pts = [pt(1000, 1), pt(1500, 3), pt(5000, 2)];
  const out = speedSeries(pts, { range: { start: 0, end: 6000 }, bucketMs: 2000 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((p) => p.x), [1000, 3000, 5000]);
  assert.ok(Math.abs(out[0].y - 2 * MPS_TO_KT) < 1e-9);
  assert.equal(out[1].y, null);
  assert.ok(Math.abs(out[2].y - 2 * MPS_TO_KT) < 1e-9);
});

test('speedSeries: offset で軸時刻へずらし、範囲外の点は数えない', () => {
  const pts = [pt(10000, 1), pt(13000, 4), pt(30000, 9)];
  const out = speedSeries(pts, { range: { start: 0, end: 4000 }, bucketMs: 2000, offset: 10000 });
  assert.ok(Math.abs(out[0].y - 1 * MPS_TO_KT) < 1e-9);
  assert.ok(Math.abs(out[1].y - 4 * MPS_TO_KT) < 1e-9);
});

test('speedSeries: 範囲終端ちょうどの点は最後の区間に入る / 空入力は []', () => {
  const out = speedSeries([pt(4000, 1)], { range: { start: 0, end: 4000 }, bucketMs: 2000 });
  assert.ok(out[1].y > 0);
  assert.deepEqual(speedSeries([], { range: { start: 0, end: 4000 }, bucketMs: 2000 }), []);
  assert.deepEqual(speedSeries([pt(0, 1)], { range: { start: 0, end: 0 }, bucketMs: 2000 }), []);
});

test('speedChartDatasets: 可視・データありの艇だけ、トラック色で。elapsed は各艇自身の開始を0に', () => {
  const a = { name: 'A', color: '#ff0000', visible: true, tRange: { start: 100000 }, points: [pt(100000, 1), pt(101000, 1)] };
  const b = { name: 'B', color: '#00ff00', visible: false, tRange: { start: 0 }, points: [pt(0, 1)] };
  const c = { name: 'C', color: '#0000ff', visible: true, tRange: { start: 500000 }, points: [pt(500000, 2)] };
  const ds = speedChartDatasets([a, b, c], { range: { start: 0, end: 4000 }, mode: 'elapsed', bucketMs: 2000 });
  assert.deepEqual(ds.map((d) => d.label), ['A', 'C']);
  assert.equal(ds[0].borderColor, '#ff0000');
  assert.equal(ds[0].fill, false);
  assert.ok(Math.abs(ds[1].data[0].y - 2 * MPS_TO_KT) < 1e-9);
  // absolute では C の点は範囲外になり除外される
  const abs = speedChartDatasets([a, c], { range: { start: 100000, end: 104000 }, mode: 'absolute', bucketMs: 2000 });
  assert.deepEqual(abs.map((d) => d.label), ['A']);
});

test('diffSpeedsMps: 直前の点との距離/時間。先頭と dt<=0 は null', () => {
  const deg = 1 / 111195;
  const s = diffSpeedsMps([pt(0, 9, 0), pt(1000, 9, 2 * deg), pt(1000, 9, 3 * deg), pt(3000, 9, 7 * deg)]);
  assert.equal(s[0], null);
  assert.ok(Math.abs(s[1] - 2) < 0.01);
  assert.equal(s[2], null);
  assert.ok(Math.abs(s[3] - 2) < 0.01);
});

test('speedsBySource: record は記録 speed、position / diff は座標から(記録 speed を無視)', () => {
  const deg = 1 / 111195;
  const pts = [pt(0, 9, 0), pt(1000, 9, 2 * deg), pt(2000, 9, 4 * deg)];
  assert.deepEqual(speedsBySource(pts, 'record'), [9, 9, 9]);
  assert.ok(speedsBySource(pts, 'position').every((v) => Math.abs(v - 2) < 0.01));
  const d = speedsBySource(pts, 'diff');
  assert.equal(d[0], null);
  assert.ok(Math.abs(d[2] - 2) < 0.01);
});

test('speedChartDatasets: both は艇ごとに記録(実線)と座標(破線)の2本', () => {
  const deg = 1 / 111195;
  const a = { name: 'A', color: '#ff0000', visible: true, tRange: { start: 0 },
    points: [pt(0, 5, 0), pt(1000, 5, 2 * deg), pt(2000, 5, 4 * deg)] };
  const ds = speedChartDatasets([a], { range: { start: 0, end: 2000 }, mode: 'absolute', bucketMs: 2000, source: 'both' });
  assert.deepEqual(ds.map((d) => d.label), ['A', 'A(座標)']);
  assert.deepEqual(ds[0].borderDash, []);
  assert.deepEqual(ds[1].borderDash, [5, 4]);
  assert.ok(Math.abs(ds[0].data[0].y - 5 * MPS_TO_KT) < 1e-9);
  assert.ok(Math.abs(ds[1].data[0].y - 2 * MPS_TO_KT) < 0.02);
});
