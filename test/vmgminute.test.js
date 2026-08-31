import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPointOfSail, vmgComponents, minuteWinners, boatMinuteVmg } from '../src/vmgminute.js';

const DEG = Math.PI / 180;

// --- 純関数: 走種判定 ---
test('classifyPointOfSail: 風正面付近は upwind', () => {
  assert.equal(classifyPointOfSail(0, 0), 'upwind'); // 風向と一致(真っ向)
  assert.equal(classifyPointOfSail(40, 0), 'upwind');
});

test('classifyPointOfSail: 風後方は downwind', () => {
  assert.equal(classifyPointOfSail(180, 0), 'downwind');
  assert.equal(classifyPointOfSail(140, 0), 'downwind');
});

test('classifyPointOfSail: 90°±deadband はリーチ', () => {
  assert.equal(classifyPointOfSail(90, 0), 'reach');
  assert.equal(classifyPointOfSail(85, 0), 'reach'); // 既定deadband=12
});

// --- 純関数: VMG成分 ---
test('vmgComponents: 真っ向は upwind=speed, downwind=-speed', () => {
  const c = vmgComponents(0, 5, 0);
  assert.equal(Math.round(c.delta), 0);
  assert.ok(Math.abs(c.upwind - 5) < 1e-9);
  assert.ok(Math.abs(c.downwind + 5) < 1e-9);
});

test('vmgComponents: 45°では upwind=speed*cos45', () => {
  const c = vmgComponents(45, 5, 0);
  assert.ok(Math.abs(c.upwind - 5 * Math.cos(45 * DEG)) < 1e-9);
});

// --- テスト用: 一定針路・一定速度の直線トラックを生成 ---
// bearing方向へ speed[m/s] で dt[s] 刻み、duration[s] 分の点列(各点に speed を持たせる)。
function straightTrack(id, color, { lat0 = 35, lon0 = 139, bearing, speed, startT, durationSec, dtSec = 1 }) {
  const points = [];
  let lat = lat0, lon = lon0;
  const n = Math.floor(durationSec / dtSec);
  for (let i = 0; i <= n; i++) {
    const t = startT + i * dtSec * 1000;
    points.push({ t, lat, lon, speed });
    const dNorth = speed * Math.cos(bearing * DEG) * dtSec;
    const dEast = speed * Math.sin(bearing * DEG) * dtSec;
    lat += dNorth / 111320;
    lon += dEast / (111320 * Math.cos(lat * DEG));
  }
  return { id, color, visible: true, points };
}

// segments: [{bearing, speed, durationSec}] を連続位置で繋いだトラック(各点に speed)。
function segmentedTrack(id, color, segments, { lat0 = 35, lon0 = 139, startT = 0, dtSec = 1 } = {}) {
  const points = [];
  let lat = lat0, lon = lon0, t = startT;
  points.push({ t, lat, lon, speed: segments[0].speed });
  for (const seg of segments) {
    const n = Math.floor(seg.durationSec / dtSec);
    for (let i = 0; i < n; i++) {
      const dNorth = seg.speed * Math.cos(seg.bearing * DEG) * dtSec;
      const dEast = seg.speed * Math.sin(seg.bearing * DEG) * dtSec;
      lat += dNorth / 111320;
      lon += dEast / (111320 * Math.cos(lat * DEG));
      t += dtSec * 1000;
      points.push({ t, lat, lon, speed: seg.speed });
    }
  }
  return { id, color, visible: true, points };
}

const wideWind = (deg = 0) => [{ tMs: 0, windFromDeg: deg }, { tMs: 10_000_000, windFromDeg: deg }];
const sails = (mv) => [...mv.values()].map((v) => v.pointOfSail);

// --- 除外: クローズ間の短いランニング / 風上中の一時的な下り ---
test('boatMinuteVmg: 短い風下(ランニング)区間はVMGから除外する', () => {
  // 45秒だけ真下り(bearing180, 風向0)。短いラン→除外され、バケットは空。
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 45 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.equal(mv.size, 0, '短いランは除外され集計に残らない');
});

test('boatMinuteVmg: excursionMaxSec=0 なら短い風下も残る(除外の効果を確認)', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 45 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), { excursionMaxSec: 0 });
  assert.ok(mv.size >= 1 && sails(mv).includes('downwind'), '除外を切ると風下が残る');
});

test('boatMinuteVmg: 長い風下レグ(180秒)は本物の下りとして残す', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 180, speed: 5, durationSec: 180 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(sails(mv).includes('downwind'), '長い風下レグは残る');
});

test('boatMinuteVmg: 風上レグの間に挟まれた短い下りは除外され、風上のみになる', () => {
  // クローズ(90s) → 短いラン(45s) → クローズ(90s)
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 0, speed: 5, durationSec: 90 },
    { bearing: 180, speed: 6, durationSec: 45 },
    { bearing: 0, speed: 5, durationSec: 90 },
  ]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(mv.size >= 1);
  assert.ok(sails(mv).every((p) => p === 'upwind'), '挟まれた短い下りは消えて全て風上');
});

test('boatMinuteVmg: 短いクローズ(登り)区間はVMGから除外する', () => {
  // 20秒だけクローズ(bearing0, 風向0)。短い登り→除外され、バケットは空。
  const tr = segmentedTrack('X', '#f00', [{ bearing: 0, speed: 5, durationSec: 20 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.equal(mv.size, 0, '短いクローズは除外され集計に残らない');
});

test('boatMinuteVmg: upwindExcursionMaxSec=0 なら短いクローズも残る(除外の効果を確認)', () => {
  const tr = segmentedTrack('X', '#f00', [{ bearing: 0, speed: 5, durationSec: 20 }]);
  const mv = boatMinuteVmg(tr, wideWind(0), { upwindExcursionMaxSec: 0 });
  assert.ok(mv.size >= 1 && sails(mv).includes('upwind'), '除外を切ると登りが残る');
});

test('boatMinuteVmg: ランニングレグの間に挟まれた短いクローズは除外され、風下のみになる', () => {
  // ランニング(90s) → 短いクローズ(20s) → ランニング(90s)
  const tr = segmentedTrack('X', '#f00', [
    { bearing: 180, speed: 5, durationSec: 90 },
    { bearing: 0, speed: 6, durationSec: 20 },
    { bearing: 180, speed: 5, durationSec: 90 },
  ]);
  const mv = boatMinuteVmg(tr, wideWind(0), {});
  assert.ok(mv.size >= 1);
  assert.ok(sails(mv).every((p) => p === 'downwind'), '挟まれた短いクローズは消えて全て風下');
});

const T0 = 1_700_000_000_000; // 60秒境界に揃った適当な絶対時刻
const END = T0 + 180_000; // 3分

// 風向系列は「トラックオブジェクト」をキーにしたMapで渡す(idはボート間で重複しうるため)。
const windMap = (tracks, deg = 0) => new Map(tracks.map((t) => [t, [
  { tMs: T0, windFromDeg: deg }, { tMs: END, windFromDeg: deg },
]]));

test('minuteWinners: 風上を速く詰める艇(真っ向)が毎分の勝者', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),   // delta=0, vmg=5
    straightTrack('B', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }),  // delta=45, vmg≈3.5
  ];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[0]), 'すべての勝者区間がA');
  assert.ok(segs.every(s => s.color === '#f00'), '色はAのトラック色');
  // 隣接する同一勝者は結合され、全域(約3分)を覆う
  assert.equal(segs[0].pointOfSail, 'upwind');
});

test('minuteWinners: 走種をまたいでVMG大の艇が勝者(風下艇が上回る)', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 4, startT: T0, durationSec: 180 }),    // upwind vmg=4
    straightTrack('B', '#00f', { bearing: 180, speed: 5, startT: T0, durationSec: 180 }),  // downwind vmg=5
  ];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[1]), '風下でVMG大のBが勝者');
  assert.equal(segs[0].pointOfSail, 'downwind');
});

test('minuteWinners: 対象が2艇未満の分は勝者なし', () => {
  const tracks = [straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 })];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  assert.deepEqual(segs, []);
});

test('minuteWinners: リーチ艇は対象外(2艇ともリーチなら勝者なし)', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 90, speed: 5, startT: T0, durationSec: 180 }),  // reach
    straightTrack('B', '#00f', { bearing: 90, speed: 6, startT: T0, durationSec: 180 }),  // reach
  ];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  assert.deepEqual(segs, []);
});

test('minuteWinners: 区間は時計の毎分境界に揃う', () => {
  const tracks = [
    straightTrack('A', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),
    straightTrack('B', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }),
  ];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  for (const s of segs) {
    assert.equal(s.lo % 60000, 0, 'loが分境界');
    assert.equal(s.hi % 60000, 0, 'hiが分境界');
  }
});

// 回帰: 各艇のGPSファイルが同名(例 Location.csv)でidが重複しても、
// 別トラックとして正しく区別し、勝者を取り違えない(色・帰属が混ざらない)。
test('minuteWinners: 同名idの別艇を取り違えない', () => {
  const tracks = [
    straightTrack('Location.csv', '#f00', { bearing: 0, speed: 5, startT: T0, durationSec: 180 }),  // 真っ向・勝者
    straightTrack('Location.csv', '#00f', { bearing: 45, speed: 5, startT: T0, durationSec: 180 }), // 遅い
  ];
  const segs = minuteWinners(tracks, windMap(tracks), {});
  assert.ok(segs.length >= 1);
  assert.ok(segs.every(s => s.track === tracks[0]), '勝者は真っ向のトラックだけ');
  assert.ok(segs.every(s => s.color === '#f00'), '色が最後の艇に潰れない');
});
