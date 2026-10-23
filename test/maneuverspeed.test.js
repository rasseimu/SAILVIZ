// test/maneuverspeed.test.js
// タック/ジャイブ前後の減速(座標はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maneuverKind, speedAround, turnAcrossDeg, turnCenterMs, maneuverSpeedRows, topTacks } from '../src/maneuverspeed.js';
import { MPS_TO_KT } from '../src/speedchart.js';

const DEG = 1 / 111195; // 緯度 1m 相当

test('maneuverKind: 前後とも風上ならタック、前後とも風下ならジャイブ(減速率の判別に依らない)', () => {
  // 北風(0°)。315°→45° は両方クローズ → タック。135°→225° は両方ランニング → ジャイブ
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 45, type: 'gybe' }, 0), 'tack');
  assert.equal(maneuverKind({ headingBefore: 135, headingAfter: 225, type: 'tack' }, 0), 'gybe');
});

test('maneuverKind: マーク回航(クローズ→ランニング)やリーチを含む旋回はどちらでもない', () => {
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 225, type: 'tack' }, 5), null); // ベアウェイ
  assert.equal(maneuverKind({ headingBefore: 135, headingAfter: 45, type: 'gybe' }, 0), null); // ラフアップ
  assert.equal(maneuverKind({ headingBefore: 90, headingAfter: 270, type: 'tack' }, 0), null); // リーチ
});

test('maneuverKind: 風軸が無ければ既存の判別、判別不能は null', () => {
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 45, type: 'gybe' }, null), 'gybe');
  assert.equal(maneuverKind({ type: 'tack' }, 0), 'tack');
  assert.equal(maneuverKind({}, null), null);
});

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
function trackWithDip(name, dipMps, { before = 315, after = 45, turn = true } = {}) {
  const points = [];
  let lat = 0, lon = 0;
  for (let i = 0; i <= 40; i++) {
    const v = Math.abs(i - 20) <= 2 ? dipMps : 3;
    const h = (!turn || i <= 20 ? before : after) * Math.PI / 180;
    lat += v * Math.cos(h) * DEG; lon += v * Math.sin(h) * DEG;
    points.push({ t: i * 1000, lat, lon, speed: 99 });
  }
  return { name, points };
}

test('turnAcrossDeg: 窓の外側の前後で進路がどれだけ変わったか', () => {
  assert.ok(Math.abs(turnAcrossDeg(trackWithDip('t', 3).points, 20000) - 90) < 1);
  assert.ok(turnAcrossDeg(trackWithDip('s', 3, { turn: false }).points, 20000) < 1);
  assert.equal(turnAcrossDeg(trackWithDip('t', 3).points, 2000), null); // 前の区間が記録の外
});

test('turnCenterMs: 検出時刻が数秒ずれていても、実際に向きを変えた時刻へ寄せる', () => {
  const pts = trackWithDip('t', 3).points; // 20秒で旋回
  assert.ok(Math.abs(turnCenterMs(pts, 14000) - 20000) <= 1000, String(turnCenterMs(pts, 14000)));
  assert.ok(Math.abs(turnCenterMs(pts, 25000) - 20000) <= 1000);
  assert.equal(turnCenterMs([], 0), null);
});

test('maneuverSpeedRows: 検出時刻がずれていても旋回の中心で前後3秒を切り出す', () => {
  const wind = [{ tMs: 0, windFromDeg: 0 }];
  const [row] = maneuverSpeedRows(trackWithDip('t', 1), [{ tMs: 14000, headingBefore: 315, headingAfter: 45 }], wind);
  assert.ok(Math.abs(row.tMs - 20000) <= 1000, String(row.tMs));
  assert.ok(row.dropKt > 1, String(row.dropKt));
});

test('maneuverSpeedRows / topTacks: 減速の小さいタック順に上位を返し、ジャイブは含めない', () => {
  const tackAt20 = { tMs: 20000, lat: 0, lon: 0, headingBefore: 315, headingAfter: 45 };
  const gybeAt20 = { tMs: 20000, lat: 0, lon: 0, headingBefore: 135, headingAfter: 225 };
  const wind = [{ tMs: 0, windFromDeg: 0 }];
  const good = trackWithDip('good', 2.5);
  const bad = trackWithDip('bad', 0.5);
  const gybe = trackWithDip('gybe', 3, { before: 135, after: 225 });
  const straight = trackWithDip('straight', 3, { turn: false });
  const rows = [
    ...maneuverSpeedRows(bad, [tackAt20], wind),
    ...maneuverSpeedRows(good, [tackAt20], wind),
    ...maneuverSpeedRows(gybe, [gybeAt20], wind),
    ...maneuverSpeedRows(straight, [tackAt20], wind), // 向きが変わっていない見かけのタックは除外
  ];
  assert.deepEqual(rows.map((r) => r.kind), ['tack', 'tack', 'gybe']);
  const top = topTacks(rows, 3);
  assert.deepEqual(top.map((r) => r.track.name), ['good', 'bad']);
  assert.ok(top[0].dropKt < top[1].dropKt);
  assert.ok(top[0].entryKt > 0 && top[0].entryKt < 99 * MPS_TO_KT); // 記録 speed(99)は使わない
  // 減速が大きいほど drop も大きく出る(±5秒で均すと平らになって 0 に潰れる)
  assert.ok(top[1].dropKt > 2, String(top[1].dropKt));
});

test('topTacks: 件数で切り、同じ減速なら入りの速い方が上', () => {
  const r = (dropKt, entryKt) => ({ kind: 'tack', dropKt, entryKt });
  const top = topTacks([r(1, 5), r(0.5, 4), r(0.5, 6), r(2, 6)], 3);
  assert.deepEqual(top.map((x) => [x.dropKt, x.entryKt]), [[0.5, 6], [0.5, 4], [1, 5]]);
});
