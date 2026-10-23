// test/speedchart.test.js
// VMG 凡例内の速度推移グラフ用の純関数(座標はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MPS_TO_KT, pointSpeedsMps, bucketMsFor, speedSeries, speedChartDatasets } from '../src/speedchart.js';

const pt = (t, speed, lat = 0, lon = 0) => ({ t, lat, lon, speed });

test('pointSpeedsMps: 有効な記録 speed はそのまま、負値・null は直前点からの距離/時間', () => {
  // 緯度 0.001° ≒ 111.2m を 10 秒 → 約 11.1 m/s
  const s = pointSpeedsMps([pt(0, 2), pt(10000, -1, 0.001), pt(20000, null, 0.002), pt(30000, 3, 0.003)]);
  assert.equal(s[0], 2);
  assert.ok(Math.abs(s[1] - 11.12) < 0.05, String(s[1]));
  assert.ok(Math.abs(s[2] - 11.12) < 0.05, String(s[2]));
  assert.equal(s[3], 3);
});

test('pointSpeedsMps: 先頭の無効 speed と dt<=0 は null', () => {
  const s = pointSpeedsMps([pt(0, -1), pt(0, null, 0.001)]);
  assert.deepEqual(s, [null, null]);
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
