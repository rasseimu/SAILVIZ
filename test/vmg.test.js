import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circDiffDeg } from '../src/windaxis.js';
import {
  windFromAt, vmgComponents, classifyPointOfSail, boatLegVmg,
  winnerTimeline, rankVmg, analyzeFleetVmg, unifyWindAxis,
} from '../src/vmg.js';
import { trackForHighlight, compassScreenVector } from '../src/renderer.js';

// Test helpers
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearCirc = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(circDiffDeg(a, b)) < eps, `circ ${a} != ${b}`);

// 指定方位・速度で直進する track.points（lat/lon/t/speed）を生成。cog は computeCog が再計算。
function straightTrack(id, t0, headingDeg, seconds, speed = 3, dtMs = 500) {
  const points = [];
  let lat = 35.30, lon = 139.48;
  const rad = headingDeg * Math.PI / 180;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat * Math.PI / 180);
  const n = Math.floor((seconds * 1000) / dtMs);
  for (let i = 0; i < n; i++) {
    points.push({ t: t0 + i * dtMs, lat, lon, speed, bearing: null, accuracy: null });
    lat += (Math.cos(rad) * speed * (dtMs / 1000)) / mLat;
    lon += (Math.sin(rad) * speed * (dtMs / 1000)) / mLon;
  }
  return { id, name: id, color: '#f00', points };
}

// Helper to create leg objects for testing
const leg = (boatId, startT, endT, pointOfSail, meanVmg) =>
  ({ boatId, startT, endT, pointOfSail, meanVmg });

// ===== Task 1: windFromAt =====
test('windFromAt: 北跨ぎを円周補間し端点でクランプ', () => {
  const ws = [{ tMs: 0, windFromDeg: 350 }, { tMs: 1000, windFromDeg: 10 }];
  nearCirc(windFromAt(ws, 0), 350);
  nearCirc(windFromAt(ws, 1000), 10);
  nearCirc(windFromAt(ws, 500), 0);    // 350→10 の中点は 0(=360)
  nearCirc(windFromAt(ws, -100), 350); // 範囲外は端点クランプ
  nearCirc(windFromAt(ws, 9999), 10);
  assert.equal(windFromAt([], 0), null);
});

// ===== Task 2: vmgComponents, classifyPointOfSail =====
test('vmgComponents: 風上/風下成分の符号', () => {
  const dead = vmgComponents(0, 3, 0);   // 風に直進
  near(dead.upwind, 3); near(dead.downwind, -3);
  const run = vmgComponents(180, 3, 0);  // 真後ろ＝ランニング
  near(run.upwind, -3); near(run.downwind, 3);
  const close = vmgComponents(45, 3, 0); // クローズ
  near(close.upwind, 3 * Math.cos(45 * Math.PI / 180));
});

test('classifyPointOfSail: デッドバンドでリーチ除外', () => {
  assert.equal(classifyPointOfSail(45, 0), 'upwind');
  assert.equal(classifyPointOfSail(170, 0), 'downwind');
  assert.equal(classifyPointOfSail(90, 0), 'reach');
  assert.equal(classifyPointOfSail(300, 0), 'upwind');  // -60°相当
});

// ===== Task 3: boatLegVmg =====
test('boatLegVmg: 風上クローズレグの平均VMGを復元', () => {
  const t0 = 1_787_000_000_000;
  const track = straightTrack('A', t0, 45, 40, 3);      // 45°クローズ, 3m/s, 40s
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const legs = boatLegVmg(track, ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.equal(legs.length, 1);
  assert.equal(legs[0].pointOfSail, 'upwind');
  assert.equal(legs[0].boatId, 'A');
  near(legs[0].meanVmg, 3 * Math.cos(45 * Math.PI / 180), 0.1); // ≈2.12
});

test('boatLegVmg: リーチレグは出力しない', () => {
  const t0 = 1_787_000_000_000;
  const track = straightTrack('R', t0, 90, 40, 3);       // 風0°に対し真横=リーチ
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const legs = boatLegVmg(track, ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.equal(legs.length, 0);
});

// ===== Task 4: winnerTimeline =====
test('winnerTimeline: 同走種で高VMG艇が勝ち、異走種・単独は除外', () => {
  const legs = [
    leg('A', 0, 100, 'upwind', 2.5),
    leg('B', 0, 100, 'upwind', 2.0),
    leg('C', 0, 100, 'downwind', 3.0), // 風下単独→比較対象なし
  ];
  const hl = winnerTimeline(legs, { colors: { A: '#a', B: '#b', C: '#c' } });
  assert.equal(hl.length, 1);
  assert.equal(hl[0].boatId, 'A');
  assert.equal(hl[0].color, '#a');
  assert.equal(hl[0].lo, 0);
  assert.equal(hl[0].hi, 100);
});

test('winnerTimeline: 部分重複区間だけを勝ち帯にする', () => {
  const legs = [
    leg('A', 0, 100, 'upwind', 2.5),
    leg('B', 50, 150, 'upwind', 3.0),
  ];
  const hl = winnerTimeline(legs, { minBoats: 2 });
  assert.equal(hl.length, 1);        // 重複する[50,100)のみ
  assert.equal(hl[0].boatId, 'B');
  assert.equal(hl[0].lo, 50);
  assert.equal(hl[0].hi, 100);
});

// ===== Task 5: rankVmg =====
test('rankVmg: 艇×走種で集約し勝ち率とVMG降順を出す', () => {
  const legs = [
    { boatId: 'A', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.5 },
    { boatId: 'B', startT: 0, endT: 100, pointOfSail: 'upwind', meanVmg: 2.0 },
  ];
  const highlights = [{ boatId: 'A', pointOfSail: 'upwind', lo: 0, hi: 100 }];
  const rows = rankVmg(legs, { from: 0, to: 100, highlights });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].boatId, 'A');            // VMG降順で先頭
  near(rows[0].meanVmg, 2.5); near(rows[0].winRatio, 1);
  assert.equal(rows[0].legCount, 1);
  assert.equal(rows[1].boatId, 'B');
  near(rows[1].winRatio, 0);
});

// ===== Task 6: analyzeFleetVmg =====
test('analyzeFleetVmg: 2艇の風上比較でハイライトとランキングを返す', () => {
  const t0 = 1_787_000_000_000;
  const fast = straightTrack('F', t0, 45, 40, 3.4); fast.color = '#f00';
  const slow = straightTrack('S', t0, 45, 40, 2.6); slow.color = '#00f';
  const ws = [{ tMs: t0, windFromDeg: 0 }, { tMs: t0 + 40000, windFromDeg: 0 }];
  const r = analyzeFleetVmg([fast, slow], ws, { settleSec: 4, settleM: 10, minLegSec: 5 });
  assert.ok(r.perBoatLegVmg.length >= 2);
  assert.ok(r.highlights.length >= 1);
  assert.equal(r.highlights[0].boatId, 'F');   // 速い艇が勝つ
  assert.equal(r.highlights[0].color, '#f00');
  assert.equal(r.ranks[0].boatId, 'F');
});

// ===== Task 7: unifyWindAxis =====
test('unifyWindAxis: 3艇推定を円周中央値で統合', () => {
  const t0 = 1_787_000_000_000;
  const mk = (deg) => ({ id: `b${deg}`, points: [], _deg: deg });
  const estimator = (track) => [
    { tMs: t0, windFromDeg: track._deg }, { tMs: t0 + 10000, windFromDeg: track._deg },
  ];
  const tracks = [mk(10), mk(12), mk(14)];
  const unified = unifyWindAxis(tracks, { estimator, gridMs: 5000 });
  assert.ok(unified.length > 0);
  nearCirc(windFromAt(unified, t0 + 5000), 12); // 中央値
});

test('unifyWindAxis: estimator 未指定はエラー', () => {
  assert.throws(() => unifyWindAxis([{ id: 'x', points: [] }], {}));
});

// ===== Task 8: trackForHighlight =====
test('trackForHighlight: boatId でトラックを引く', () => {
  const tracks = [{ id: 'A' }, { id: 'B' }];
  assert.equal(trackForHighlight(tracks, 'B').id, 'B');
  assert.equal(trackForHighlight(tracks, 'Z'), null);
});

// ===== 風軸インジケータ: コンパス方位→画面ベクトル =====
test('compassScreenVector: 方位と地図回転から画面単位ベクトル(px右,py下)', () => {
  const v = (b, r) => compassScreenVector(b, r);
  // 回転なし: 北=上, 東=右, 南=下, 西=左
  near(v(0, 0).dx, 0); near(v(0, 0).dy, -1);
  near(v(90, 0).dx, 1); near(v(90, 0).dy, 0);
  near(v(180, 0).dx, 0); near(v(180, 0).dy, 1);
  near(v(270, 0).dx, -1); near(v(270, 0).dy, 0);
  // 地図を +90°(π/2) 回転すると北は右を向く（worldToScreen と整合）
  near(v(0, Math.PI / 2).dx, 1); near(v(0, Math.PI / 2).dy, 0);
});
