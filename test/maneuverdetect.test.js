// test/maneuverdetect.test.js
// 風軸からのタック/ジャイブ検出と、風軸が無い艇の代わりの経路(座標はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeCourses, sideRuns, detectManeuversByWind, turnAcrossDeg, turnCenterMs, maneuverKind,
  legacyManeuverEvents, detectManeuverEvents, excludeManeuvers, addManeuverExclusion, removeManeuverExclusions,
} from '../src/maneuverdetect.js';

const DEG = 1 / 111195; // 緯度 1m 相当
const NORTH = [{ tMs: 0, windFromDeg: 0 }]; // 北風

// legs: [{sec, hdg}]。leg の切り替わりで turnSec 秒かけて前の進路から次の進路へ旋回する(via で回り方を指定)。
// 1Hz・3 m/s(旋回中は slowMps)。真の旋回の中心時刻を centers に返す。
function course(legs, { turnSec = 6, slowMps = 1.5 } = {}) {
  const points = [], centers = [];
  let lat = 0, lon = 0, t = 0;
  const step = (hdg, v) => {
    const r = hdg * Math.PI / 180;
    lat += v * Math.cos(r) * DEG; lon += v * Math.sin(r) * DEG;
    points.push({ t: t * 1000, lat, lon, speed: 99 }); t++;
  };
  legs.forEach((leg, k) => {
    if (k > 0) {
      const from = legs[k - 1].hdg;
      const d = leg.via ?? (((leg.hdg - from + 540) % 360) - 180);
      centers.push((t + turnSec / 2 - 1.5) * 1000); // 進路が中間の向きになる区間の中ほど
      for (let j = 0; j < turnSec; j++) step(from + d * ((j + 1) / turnSec), slowMps);
    }
    for (let j = 0; j < leg.sec; j++) step(leg.hdg, 3);
  });
  return { points, centers };
}

test('relativeCourses: 風位に対する進路の角度。右(ポート)が正、ほぼ止まっている点は null', () => {
  const { points } = course([{ sec: 30, hdg: 45 }]);
  const rel = relativeCourses(points, NORTH);
  assert.ok(Math.abs(rel[15] - 45) < 0.5);
  assert.ok(Math.abs(relativeCourses(points, [{ tMs: 0, windFromDeg: 90 }])[15] + 45) < 0.5);
  const still = Array.from({ length: 20 }, (_, i) => ({ t: i * 1000, lat: 0, lon: 0 }));
  assert.ok(relativeCourses(still, NORTH).every((r) => r === null));
});

test('sideRuns: 短い舷のふらつきは捨て、前後の同じ舷はつなぐ。風位付近(不定)は区間を切らない', () => {
  const points = Array.from({ length: 40 }, (_, i) => ({ t: i * 1000 }));
  const rel = points.map((_, i) => (i >= 15 && i < 18 ? -40 : i === 20 ? 3 : 40)); // 3秒だけ反対舷、1点だけ風位
  assert.deepEqual(sideRuns(points, rel).map((r) => r.side), [1]);
  const rel2 = points.map((_, i) => (i < 20 ? 40 : -40));
  assert.deepEqual(sideRuns(points, rel2).map((r) => [r.side, r.start, r.end]), [[1, 0, 19], [-1, 20, 39]]);
});

test('detectManeuversByWind: タックは艇首が風位を横切った時刻、ジャイブは艇尾が横切った時刻', () => {
  const up = course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 45 }, { sec: 40, hdg: 315 }]);
  const tacks = detectManeuversByWind(up.points, NORTH);
  assert.deepEqual(tacks.map((m) => m.kind), ['tack', 'tack']);
  tacks.forEach((m, i) => assert.ok(Math.abs(m.tMs - up.centers[i]) <= 1500, `${m.tMs} vs ${up.centers[i]}`));
  assert.ok(tacks.every((m) => Math.abs(m.turnDeg - 90) < 10));
  const down = course([{ sec: 40, hdg: 135 }, { sec: 40, hdg: 225 }]);
  assert.deepEqual(detectManeuversByWind(down.points, NORTH).map((m) => m.kind), ['gybe']);
});

test('detectManeuversByWind: ゆっくりしたタック(12秒で90°)・短いレグも拾う', () => {
  const slow = course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 45 }], { turnSec: 12 });
  assert.equal(detectManeuversByWind(slow.points, NORTH).length, 1);
  const legs = Array.from({ length: 8 }, (_, i) => ({ sec: 12, hdg: i % 2 ? 45 : 315 }));
  assert.equal(detectManeuversByWind(course(legs).points, NORTH).length, 7);
});

test('detectManeuversByWind: 回航(舷が変わらない)・1回転(風位と真追っ手を両方横切る)は数えない', () => {
  const rounding = course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 225 }]); // ポートのままベアウェイ
  assert.equal(detectManeuversByWind(rounding.points, NORTH).length, 0);
  const penalty = course([{ sec: 40, hdg: 45 }, { sec: 40, hdg: 45, via: 360 }], { turnSec: 12 });
  assert.equal(detectManeuversByWind(penalty.points, NORTH).length, 0);
});

test('detectManeuversByWind: 風軸がずれていても 30° までならタックを拾う / 風軸が無ければ []', () => {
  const up = course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 45 }]);
  assert.deepEqual(detectManeuversByWind(up.points, [{ tMs: 0, windFromDeg: 30 }]).map((m) => m.kind), ['tack']);
  assert.deepEqual(detectManeuversByWind(up.points, []), []);
});

// ===== 風軸が無い艇の代わりの経路 =====

// 1Hz・41秒。20秒で進路を before → after に変える
function turnAt20({ before = 315, after = 45, turn = true } = {}) {
  const points = [];
  let lat = 0, lon = 0;
  for (let i = 0; i <= 40; i++) {
    const h = (!turn || i <= 20 ? before : after) * Math.PI / 180;
    lat += 3 * Math.cos(h) * DEG; lon += 3 * Math.sin(h) * DEG;
    points.push({ t: i * 1000, lat, lon, speed: 99 });
  }
  return points;
}

test('turnAcrossDeg: 窓の外側の前後で進路がどれだけ変わったか', () => {
  assert.ok(Math.abs(turnAcrossDeg(turnAt20(), 20000) - 90) < 1);
  assert.ok(turnAcrossDeg(turnAt20({ turn: false }), 20000) < 1);
  assert.equal(turnAcrossDeg(turnAt20(), 2000), null); // 前の区間が記録の外
});

test('turnCenterMs: 検出時刻が数秒ずれていても、実際に向きを変えた時刻へ寄せる', () => {
  const pts = turnAt20();
  assert.ok(Math.abs(turnCenterMs(pts, 14000) - 20000) <= 1000, String(turnCenterMs(pts, 14000)));
  assert.ok(Math.abs(turnCenterMs(pts, 25000) - 20000) <= 1000);
  assert.equal(turnCenterMs([], 0), null);
});

test('maneuverKind: 前後とも風上ならタック、前後とも風下ならジャイブ(減速率の判別に依らない)', () => {
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 45, type: 'gybe' }, 0), 'tack');
  assert.equal(maneuverKind({ headingBefore: 135, headingAfter: 225, type: 'tack' }, 0), 'gybe');
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 225, type: 'tack' }, 5), null); // ベアウェイ
  assert.equal(maneuverKind({ headingBefore: 90, headingAfter: 270, type: 'tack' }, 0), null); // リーチ
  assert.equal(maneuverKind({ headingBefore: 315, headingAfter: 45, type: 'gybe' }, null), 'gybe'); // 風軸なし
  assert.equal(maneuverKind({}, null), null);
});

test('legacyManeuverEvents: 時刻を旋回の中心へ寄せ、向きが変わっていない検出は除外', () => {
  const m = { tMs: 14000, lat: 0, lon: 0, headingBefore: 315, headingAfter: 45, type: 'tack' };
  const [e] = legacyManeuverEvents(turnAt20(), [m], NORTH);
  assert.equal(e.kind, 'tack');
  assert.ok(Math.abs(e.tMs - 20000) <= 1000);
  assert.deepEqual(legacyManeuverEvents(turnAt20({ turn: false }), [m], NORTH), []);
});

test('detectManeuverEvents: 風軸があれば舷の入れ替わりから、無ければ detectManeuvers から', () => {
  const up = course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 45 }, { sec: 40, hdg: 315 }], { turnSec: 12 });
  assert.equal(detectManeuverEvents({ points: up.points }, NORTH).length, 2);
  // 風軸が無い: detectManeuvers の結果(ここでは減速率判別)を整えたもの。形は同じ
  const legacy = detectManeuverEvents({ points: course([{ sec: 40, hdg: 315 }, { sec: 40, hdg: 45 }]).points }, []);
  assert.ok(legacy.every((e) => ['tack', 'gybe'].includes(e.kind) && Number.isFinite(e.tMs)));
  assert.deepEqual(detectManeuverEvents({ points: [] }, []), []);
});

// ===== 誤検出の除外 =====

test('excludeManeuvers: 除外区間(両端を含む)に時刻があるマニューバを外す。区間なし・壊れた値は無視', () => {
  const ev = [{ tMs: 100 }, { tMs: 200 }, { tMs: 300 }, { tMs: 400 }];
  assert.deepEqual(excludeManeuvers(ev, [{ start: 200, end: 300 }]).map((e) => e.tMs), [100, 400]);
  assert.deepEqual(excludeManeuvers(ev, [{ start: 50, end: 120 }, { start: 390, end: 999 }]).map((e) => e.tMs), [200, 300]);
  assert.equal(excludeManeuvers(ev, []), ev);
  assert.equal(excludeManeuvers(ev, undefined), ev); // 旧データ
  assert.deepEqual(excludeManeuvers(ev, [{ start: 300, end: 200 }, null, { start: 'x', end: 1 }]).length, 4);
});

test('addManeuverExclusion: 足す・同じ区間は重ねない・不正な区間は無視。元の配列は変えない', () => {
  const a = [{ start: 1, end: 2 }];
  const b = addManeuverExclusion(a, { start: 5, end: 9 });
  assert.deepEqual(b, [{ start: 1, end: 2 }, { start: 5, end: 9 }]);
  assert.deepEqual(a, [{ start: 1, end: 2 }]);
  assert.equal(addManeuverExclusion(b, { start: 5, end: 9 }).length, 2);
  assert.equal(addManeuverExclusion(b, { start: 9, end: 5 }).length, 2);
  assert.deepEqual(addManeuverExclusion(undefined, { start: 0, end: 1 }), [{ start: 0, end: 1 }]);
});

test('removeManeuverExclusions: 指定範囲と重なる区間だけを取り除く', () => {
  const list = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  assert.deepEqual(removeManeuverExclusions(list, { start: 25, end: 45 }), [{ start: 0, end: 10 }]);
  assert.deepEqual(removeManeuverExclusions(list, { start: 11, end: 19 }), list);
});
