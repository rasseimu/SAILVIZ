import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE_LEVELS, DEFAULT_CONFIDENCE_OPTS, ANALYSIS_MAX_SPEED_MPS,
  minLevel, levelForComparableMs, assessWindAxis, validIntervals, intersectIntervals,
  assessComparison, formatConfidenceLabel, windAxisReasonRows,
} from '../src/analysisconfidence.js';
import { boatMinuteVmg, minuteWinnersDetailed } from '../src/vmgminute.js';
import { MAX_SPEED_MPS, prepareTrackPoints } from '../src/gps.js';
import { detectHeightAdjustWindowsByTrack } from '../src/vmg.js';

const DEG = Math.PI / 180;
// 30秒・60秒境界に揃った合成の絶対時刻(実データではない)
const T0 = 1_700_000_040_000;
const S = 1000;

// --- テスト用: 一定針路・一定速度の直線トラック(test/vmgminute.test.js の straightTrack と同方式) ---
// 合成座標のみ。各点に speed と accuracy(既定 5m)を持たせる。
function straightTrack(id, { lat0 = 35, lon0 = 139, bearing = 0, speed = 5, startT = T0, durationSec, dtSec = 1, accuracy = 5 }) {
  const points = [];
  let lat = lat0, lon = lon0;
  const n = Math.floor(durationSec / dtSec);
  for (let i = 0; i <= n; i++) {
    const t = startT + i * dtSec * 1000;
    points.push({ t, lat, lon, speed, accuracy });
    const dNorth = speed * Math.cos(bearing * DEG) * dtSec;
    const dEast = speed * Math.sin(bearing * DEG) * dtSec;
    lat += dNorth / 111320;
    lon += dEast / (111320 * Math.cos(lat * DEG));
  }
  return { id, name: id, color: '#888', visible: true, points };
}

// 4点のアンカーで [lo, hi] を覆う風軸系列(信頼度 high になる)
const wind4 = (lo, hi, deg = 0) => [0, 1, 2, 3].map((k) => ({ tMs: lo + ((hi - lo) * k) / 3, windFromDeg: deg }));
const windFor = (tracks, lo = T0, hi = T0 + 3_600_000) => new Map(tracks.map((t) => [t, wind4(lo, hi)]));
const codes = (r) => r.reasons.map((x) => x.code);

// --- 定数 ---
test('定数: 信頼度4段階と閾値', () => {
  assert.deepEqual([...CONFIDENCE_LEVELS], ['unavailable', 'low', 'medium', 'high']);
  assert.equal(ANALYSIS_MAX_SPEED_MPS, 15);
  assert.equal(DEFAULT_CONFIDENCE_OPTS.maxAccuracyM, 50);
  assert.equal(DEFAULT_CONFIDENCE_OPTS.maxSpeedMps, 15);
  assert.equal(DEFAULT_CONFIDENCE_OPTS.minCompareMs, 60_000);
  assert.equal(MAX_SPEED_MPS, 25, '読込時の上限は据え置き');
});

// --- levelForComparableMs / minLevel ---
test('levelForComparableMs: 境界値', () => {
  assert.equal(levelForComparableMs(0), 'unavailable');
  assert.equal(levelForComparableMs(59_999), 'unavailable');
  assert.equal(levelForComparableMs(60_000), 'low');
  assert.equal(levelForComparableMs(179_999), 'low');
  assert.equal(levelForComparableMs(180_000), 'medium');
  assert.equal(levelForComparableMs(599_999), 'medium');
  assert.equal(levelForComparableMs(600_000), 'high');
  assert.equal(levelForComparableMs(NaN), 'unavailable');
});

test('minLevel: 最も低い信頼度を返す', () => {
  assert.equal(minLevel('high', 'low'), 'low');
  assert.equal(minLevel('high', 'medium', 'unavailable'), 'unavailable');
  assert.equal(minLevel(['medium', 'high']), 'medium');
  assert.equal(minLevel(), 'high');
});

test('intersectIntervals: 実時刻の積集合(接するだけは0)', () => {
  assert.deepEqual(intersectIntervals([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(intersectIntervals([[0, 10]], [[10, 20]]), []);
  assert.deepEqual(intersectIntervals(null, [[0, 1]]), []);
});

// --- 時刻の重なり ---
test('重なり: A 終了 = B 開始 → unavailable・no-overlap・表示文言', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 300 });
  const B = straightTrack('B', { startT: T0 + 300 * S, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.equal(r.overlapMs, 0);
  assert.equal(r.reasons[0].code, 'no-overlap');
  assert.deepEqual(r.segments, []);
  assert.equal(formatConfidenceLabel(r), '比較不能：2艇の記録時刻が重なっていません');
});

test('重なり: 同一30秒バケット内でも時間が交差しなければ重なり0', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 14 });
  const B = straightTrack('B', { startT: T0 + 15 * S, durationSec: 14 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.overlapMs, 0);
  assert.equal(r.level, 'unavailable');
  assert.ok(codes(r).includes('no-overlap'));
});

test('重なり: 20秒だけ交差 → overlapMs 20000、比較区間は20秒以下', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 300 });
  const B = straightTrack('B', { startT: T0 + 280 * S, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.overlapMs, 20_000);
  assert.ok(r.comparableMs <= 20_000);
  assert.equal(r.level, 'unavailable');
});

// --- 最低比較時間 ---
test('最低比較時間: 交差30秒だけ → segments 空・too-short', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 300 });
  const B = straightTrack('B', { startT: T0 + 270 * S, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.overlapMs, 30_000);
  assert.deepEqual(r.segments, []);
  assert.equal(r.comparableMs, 0);
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'too-short');
});

test('最低比較時間: 交差ちょうど 60000ms → 比較区間1件(low)、59999ms → なし', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 300 });
  const B = straightTrack('B', { startT: T0 + 240 * S, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.segments.length, 1);
  assert.equal(r.comparableMs, 60_000);
  assert.equal(r.segments[0].pointOfSail, 'upwind');
  assert.deepEqual(r.segments[0].tracks, [A, B]);
  assert.equal(r.level, 'low');

  // B を 1ms 遅らせて交差を 59999ms にする
  const B2 = straightTrack('B', { startT: T0 + 240 * S + 1, durationSec: 300 });
  const r2 = assessComparison([A, B2], windFor([A, B2]));
  assert.equal(r2.overlapMs, 59_999);
  assert.deepEqual(r2.segments, []);
  assert.equal(r2.level, 'unavailable');
  assert.ok(codes(r2).includes('too-short'));
});

test('最低比較時間: 60秒区間+30秒区間(非連続) → 30秒側は除外され comparableMs 60000', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 400 });
  const B1 = straightTrack('B', { startT: T0 + 60 * S, durationSec: 60 });
  const B2 = straightTrack('B', { lat0: 35.01, startT: T0 + 200 * S, durationSec: 30 });
  const B = { ...B1, points: [...B1.points, ...B2.points] }; // 120s〜200s は記録なし(欠損)
  // 30秒の短いクローズも走種判定に残す(最低比較時間の判定だけを確かめるため)
  const r = assessComparison([A, B], windFor([A, B]), { upwindExcursionMaxSec: 0 });
  assert.equal(r.comparableMs, 60_000);
  assert.equal(r.segments.length, 1);
  assert.deepEqual([r.segments[0].lo, r.segments[0].hi], [T0 + 60 * S, T0 + 120 * S]);
  assert.ok(codes(r).includes('too-short'));
  assert.ok(codes(r).includes('gps-gap'));
});

test('最低比較時間: 参加艇の集合が変わると結合しない(40秒+40秒 → 両方除外)', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 80 });
  const B = straightTrack('B', { lon0: 139.001, startT: T0, durationSec: 80 });
  const C = straightTrack('C', { lon0: 139.002, startT: T0 + 40 * S, durationSec: 40 });
  const r = assessComparison([A, B, C], windFor([A, B, C]));
  assert.deepEqual(r.segments, []);
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'too-short');
});

test('最低比較時間: 参加艇の集合が変わっても各60秒なら2区間とも残る', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 120 });
  const B = straightTrack('B', { lon0: 139.001, startT: T0, durationSec: 120 });
  const C = straightTrack('C', { lon0: 139.002, startT: T0 + 60 * S, durationSec: 60 });
  const r = assessComparison([A, B, C], windFor([A, B, C]));
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments.map((s) => [s.lo - T0, s.hi - T0]), [[0, 60_000], [60_000, 120_000]]);
  assert.deepEqual(r.segments[0].tracks, [A, B]);
  assert.deepEqual(r.segments[1].tracks, [A, B, C]);
  assert.equal(r.comparableMs, 120_000);
  assert.equal(r.perTrack.get(A).comparableMs, 120_000);
  assert.equal(r.perTrack.get(C).comparableMs, 60_000);
});

test('最低比較時間: 同じ集合で隣接する30秒+30秒は結合して60000msで残る', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 60 });
  const B = straightTrack('B', { lon0: 139.001, startT: T0, durationSec: 60 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.segments.length, 1, 'バケット境界(30秒)で切れた断片が結合される');
  assert.equal(r.comparableMs, 60_000);
});

// --- 艇数・走種 ---
test('艇数: 1艇のみ → need-two-boats', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const r = assessComparison([A], windFor([A]));
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'need-two-boats');
  assert.equal(r.perTrack.get(A).comparableMs, 0);
});

test('走種: A 風上・B 風下 → no-same-point-of-sail', () => {
  const A = straightTrack('A', { bearing: 0, durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, bearing: 180, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'no-same-point-of-sail');
  assert.deepEqual(r.segments, []);
});

test('走種: 両艇風上 → 比較可能', () => {
  const A = straightTrack('A', { bearing: 0, durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, bearing: 10, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 300_000);
  assert.equal(r.byPointOfSail.upwind, 300_000);
  assert.equal(r.byPointOfSail.downwind, 0);
  assert.equal(r.level, 'medium');
});

// --- 風軸 ---
test('風軸: 片方の系列が [] → no-wind-axis', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const ws = new Map([[A, wind4(T0, T0 + 300 * S)], [B, []]]);
  const r = assessComparison([A, B], ws);
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'no-wind-axis');
  assert.equal(r.perTrack.get(B).windAxis.level, 'unavailable');
});

test('風軸: 系列端から windTolMs ちょうど → 合格・+1ms → 比較区間から除外しないが wind-out-of-range を添える', () => {
  // B3方針: wind-out-of-range は「明らかな異常」ではないため比較区間から除外しない。
  // 信頼度情報として reasons に添えるのみ。
  const tol = DEFAULT_CONFIDENCE_OPTS.windTolMs;
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const end = T0 + 300 * S;
  const ok = new Map([A, B].map((t) => [t, wind4(T0 - 100 * S, end - tol)]));
  const r = assessComparison([A, B], ok);
  assert.equal(r.comparableMs, 300_000);
  assert.ok(!codes(r).includes('wind-out-of-range'));

  const ng = new Map([A, B].map((t) => [t, wind4(T0 - 100 * S, end - tol - 1)]));
  const r2 = assessComparison([A, B], ng);
  // B3変更後: wind-out-of-range でも比較区間から除外しないため comparableMs は変わらない
  assert.equal(r2.comparableMs, 300_000, 'wind-out-of-range でも比較区間は削らない');
  // wind-out-of-range は信頼度情報として reasons に添える
  assert.ok(codes(r2).includes('wind-out-of-range'), '信頼度情報として reasons に添える');
  assert.notEqual(r2.level, 'unavailable', 'wind-out-of-range だけで unavailable にしない');
});

// --- 精度 ---
test('精度: 50m は合格、50.01m の点の前後は除外', () => {
  const A = straightTrack('A', { durationSec: 300, accuracy: 50 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: 50 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 300_000);
  assert.ok(!codes(r).includes('accuracy'));

  const B2 = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: 50 });
  B2.points[150].accuracy = 50.01;
  const r2 = assessComparison([A, B2], windFor([A, B2]));
  assert.equal(r2.comparableMs, 298_000, '該当点の前後2秒だけ除外');
  assert.equal(r2.segments.length, 2);
  assert.ok(codes(r2).includes('accuracy'));
});

test('精度: 全点 null(旧データ・列なし) → 例外なし・unavailable・accuracy-unknown', () => {
  const A = straightTrack('A', { durationSec: 300, accuracy: null });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: null });
  for (const p of B.points) delete p.accuracy; // 列そのものがない
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'accuracy-unknown');
  assert.deepEqual(r.segments, []);
  assert.ok(r.overlapMs > 0, '記録時刻は重なっている');
});

test('精度: 一部だけ null → その部分だけ除外', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  for (let i = 200; i <= 210; i++) B.points[i].accuracy = null;
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 300_000 - 12_000);
  assert.ok(codes(r).includes('accuracy-unknown'));
  assert.notEqual(r.level, 'unavailable');
});

// --- 異常速度 ---
test('異常速度: speed 15 は合格、15.01 は除外', () => {
  const A = straightTrack('A', { durationSec: 300, speed: 15 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, speed: 15 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 300_000);
  assert.ok(!codes(r).includes('speed'));

  B.points[150].speed = 15.01;
  const r2 = assessComparison([A, B], windFor([A, B]));
  assert.equal(r2.comparableMs, 298_000);
  assert.ok(codes(r2).includes('speed'));
});

test('異常速度: 点間移動速度が 15 m/s を超える小区間は除外', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  // 1点だけ真横へ30m跳ぶ(前後の小区間とも約30 m/s)
  B.points[150] = { ...B.points[150], lon: B.points[150].lon + 30 / (111320 * Math.cos(35 * DEG)) };
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 298_000);
  assert.ok(codes(r).includes('speed'));
});

// --- 欠損 ---
test('欠損: 点間隔 5000ms は連続、5001ms は除外', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const mkGap = (shiftMs) => {
    const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
    // 読込時の除去ではない記録の欠け(除外区間なし)。旧データ扱いの record-gap 判定を外して maxGapMs の境界だけを見る。
    B.excludedIntervals = [];
    B.points = B.points
      .filter((p) => !(p.t > T0 + 150 * S && p.t < T0 + 155 * S))
      .map((p) => (p.t >= T0 + 155 * S ? { ...p, t: p.t + shiftMs } : p));
    return B;
  };
  const B5000 = mkGap(0);
  const r = assessComparison([A, B5000], windFor([A, B5000]));
  assert.equal(r.comparableMs, 300_000);
  assert.ok(!codes(r).includes('gps-gap'));

  const B5001 = mkGap(1);
  const r2 = assessComparison([A, B5001], windFor([A, B5001]));
  assert.ok(codes(r2).includes('gps-gap'));
  assert.equal(r2.comparableMs, 300_000 - 5001);
});

// --- 高さ調整局面 ---
test('高さ調整局面: 比較時間に含めない', () => {
  const A = straightTrack('A', { bearing: 0, durationSec: 300 });  // クローズ継続
  const B = straightTrack('B', { lon0: 139.01, bearing: 75, durationSec: 300 }); // フット
  const C = straightTrack('C', { lon0: 139.02, bearing: 75, durationSec: 300 }); // フット
  const off = assessComparison([A, B, C], windFor([A, B, C]), { excludeHeightAdjust: false });
  const on = assessComparison([A, B, C], windFor([A, B, C]));
  assert.equal(off.comparableMs, 300_000);
  assert.ok(on.comparableMs < off.comparableMs - 150_000, '高さ調整局面が比較時間から除かれる');
  assert.ok(codes(on).includes('height-adjust'));
});

// --- 旧データ耐性 ---
test('旧データ耐性: tRange なし・points 空・points なし・speed なしで例外を出さない', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  for (const p of B.points) delete p.speed;
  const empty = { id: 'E', points: [] };
  const noPoints = { id: 'N' };
  const tracks = [A, B, empty, noPoints];
  const r = assessComparison(tracks, windFor(tracks));
  assert.equal(r.comparableMs, 300_000, 'speed 列がなくても点間移動速度で判定して比較できる');
  assert.equal(r.perTrack.get(empty).comparableMs, 0);
  assert.equal(r.perTrack.get(noPoints).comparableMs, 0);
  assert.doesNotThrow(() => assessComparison([], new Map()));
  assert.doesNotThrow(() => assessComparison(null, null));
  assert.doesNotThrow(() => assessComparison([empty, noPoints], null));
  assert.deepEqual(validIntervals(noPoints, []), []);
  assert.doesNotThrow(() => assessWindAxis(null, null));
});

test('旧データ耐性: tRange があればそれを記録範囲に使う', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  A.tRange = { start: T0, end: T0 + 300 * S };
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.overlapMs, 300_000);
});

// --- 有効区間・除外点の混入防止 ---
test('validIntervals: 無効な小区間を除き、連続する有効小区間を結合する', () => {
  const A = straightTrack('A', { durationSec: 100 });
  A.points[50].accuracy = 500;
  const ivs = validIntervals(A, wind4(T0, T0 + 100 * S));
  assert.deepEqual(ivs, [[T0, T0 + 49 * S], [T0 + 51 * S, T0 + 100 * S]]);
  assert.deepEqual(validIntervals(A, []), [], '風軸がなければ有効区間なし');
});

test('除外点の混入防止: 無効点を極端な値にしても比較区間と走種別VMGが変わらない', () => {
  const ws = wind4(T0, T0 + 300 * S);
  const mk = (extreme) => {
    const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
    for (let i = 101; i < 110; i++) {
      B.points[i].accuracy = 500;
      if (extreme) {
        // 逆向き 14 m/s で進んだように見える位置
        const base = B.points[100];
        B.points[i] = { ...B.points[i], lat: base.lat - ((i - 100) * 14) / 111320, speed: 14 };
      }
    }
    return B;
  };
  const Bm = mk(false), Bx = mk(true);
  const ivM = validIntervals(Bm, ws), ivX = validIntervals(Bx, ws);
  assert.deepEqual(ivM, ivX);
  assert.deepEqual(boatMinuteVmg(Bx, ws, { validIntervals: ivX }), boatMinuteVmg(Bm, ws, { validIntervals: ivM }));
  assert.notDeepEqual(boatMinuteVmg(Bx, ws, {}), boatMinuteVmg(Bm, ws, {}), '有効区間を渡さなければ極端値が混ざる');

  const A = straightTrack('A', { durationSec: 300 });
  const rM = assessComparison([A, Bm], new Map([[A, ws], [Bm, ws]]));
  const rX = assessComparison([A, Bx], new Map([[A, ws], [Bx, ws]]));
  assert.deepEqual(rX.segments.map((s) => [s.lo, s.hi, s.pointOfSail]), rM.segments.map((s) => [s.lo, s.hi, s.pointOfSail]));
  assert.equal(rX.comparableMs, rM.comparableMs);
});

test('perTrack.byPointOfSail は比較区間の走種別合計と一致する', () => {
  const A = straightTrack('A', { durationSec: 120 });
  const B = straightTrack('B', { lon0: 139.001, durationSec: 120 });
  const C = straightTrack('C', { lon0: 139.002, startT: T0 + 60 * S, durationSec: 60 });
  const tracks = [A, B, C];
  const r = assessComparison(tracks, windFor(tracks));
  for (const t of tracks) {
    const exp = { upwind: 0, downwind: 0 };
    for (const s of r.segments) if (s.tracks.includes(t)) exp[s.pointOfSail] += s.hi - s.lo;
    assert.deepEqual(r.perTrack.get(t).byPointOfSail, exp);
    assert.equal(r.perTrack.get(t).comparableMs, exp.upwind + exp.downwind);
  }
  assert.equal(r.byPointOfSail.upwind + r.byPointOfSail.downwind, 120_000, '全体の走種別合計は比較区間の長さの和');
});

test('信頼度: 比較可能時間600秒以上・風軸 high → high', () => {
  const A = straightTrack('A', { durationSec: 700 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 700 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 700_000);
  assert.equal(r.level, 'high');
  assert.equal(formatConfidenceLabel(r), '信頼度 高');
});

test('信頼度: 180〜600秒は medium で主な理由は比較時間の短さ', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'medium');
  assert.equal(formatConfidenceLabel(r), '信頼度 中：比較可能時間が短いため参考値');
});

test('信頼度: 参加艇の風軸信頼度が低ければ全体も下がる(手動設定は medium)', () => {
  const A = straightTrack('A', { durationSec: 700 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 700 });
  const manual = [
    { tMs: T0, windFromDeg: 0, source: 'manual' },
    { tMs: T0 + 700 * S, windFromDeg: 0, source: 'manual' },
  ];
  const r = assessComparison([A, B], new Map([[A, wind4(T0, T0 + 700 * S)], [B, manual]]));
  assert.equal(r.level, 'medium');
  assert.equal(r.reasons[0].code, 'manual');
  assert.equal(r.perTrack.get(B).windAxis.source, 'manual');
  assert.equal(r.perTrack.get(A).windAxis.source, 'estimated');
});

// --- assessWindAxis ---
test('assessWindAxis: 系列なし・アンカー数による段階', () => {
  const tr = straightTrack('A', { durationSec: 1000 });
  const pts = (n) => Array.from({ length: n }, (_, k) => ({ tMs: T0 + k * 100 * S, windFromDeg: 0 }));
  const empty = assessWindAxis([], tr);
  assert.equal(empty.level, 'unavailable');
  assert.equal(empty.reasons[0].code, 'no-wind-axis');
  assert.equal(empty.source, null);
  assert.equal(assessWindAxis(pts(1), tr).level, 'low');
  assert.equal(assessWindAxis(pts(2), tr).level, 'medium');
  assert.equal(assessWindAxis(pts(3), tr).level, 'medium');
  const four = assessWindAxis(pts(4), tr);
  assert.equal(four.level, 'high');
  assert.equal(four.source, 'estimated');
  // 高でも肯定的な理由を返す(推定回数と被覆率)
  assert.deepEqual(four.reasons, [
    { code: 'wind-anchors', message: 'タック/ジャイブ4回から推定' },
    { code: 'wind-coverage', message: '記録時間の60%を覆う' },
  ]);
});

test('assessWindAxis: 被覆率50%ちょうどは high、49.9%は medium', () => {
  const tr = straightTrack('A', { durationSec: 1000 }); // 記録 0〜1000秒
  const series = (lastSec) => [0, 100, 200, lastSec].map((s) => ({ tMs: T0 + s * S, windFromDeg: 0 }));
  const opts = { windTolMs: 0 };
  const half = assessWindAxis(series(500), tr, opts);
  assert.equal(half.coverage, 0.5);
  assert.equal(half.level, 'high');
  const less = assessWindAxis(series(499), tr, opts);
  assert.equal(less.level, 'medium');
  assert.equal(less.reasons[0].code, 'wind-low-coverage');
});

test('assessWindAxis: manual のみ → medium・理由 manual・source manual、混在は mixed', () => {
  const manual = [
    { tMs: T0, windFromDeg: 10, source: 'manual' },
    { tMs: T0 + 600 * S, windFromDeg: 10, source: 'manual' },
  ];
  const m = assessWindAxis(manual, straightTrack('A', { durationSec: 600 }));
  assert.equal(m.level, 'medium');
  // 手動設定のみでは推定回数(wind-anchors)は付けず、被覆率の肯定的な理由は主な理由(manual)の後ろに付く
  assert.deepEqual(m.reasons.map((x) => x.code), ['manual', 'wind-coverage']);
  assert.equal(m.reasons[0].message, '手動設定');
  assert.equal(m.source, 'manual');

  const est = Array.from({ length: 4 }, (_, k) => ({ tMs: T0 + k * 200 * S, windFromDeg: 0, source: 'anchor' }));
  const mixed = assessWindAxis([...est, ...manual].sort((a, b) => a.tMs - b.tMs), straightTrack('A', { durationSec: 600 }));
  assert.equal(mixed.source, 'mixed');
  assert.equal(mixed.level, 'medium');
  assert.equal(formatConfidenceLabel(mixed), '信頼度 中：手動設定');
});

// --- formatConfidenceLabel ---
test('formatConfidenceLabel: 各段階の表示文言', () => {
  assert.equal(formatConfidenceLabel({ level: 'high', reasons: [] }), '信頼度 高');
  assert.equal(
    formatConfidenceLabel({ level: 'medium', reasons: [{ code: 'short-compare', message: '比較可能時間が短いため参考値' }] }),
    '信頼度 中：比較可能時間が短いため参考値',
  );
  assert.equal(
    formatConfidenceLabel({ level: 'unavailable', reasons: [{ code: 'no-overlap', message: '2艇の記録時刻が重なっていません' }] }),
    '比較不能：2艇の記録時刻が重なっていません',
  );
  assert.equal(formatConfidenceLabel({ level: 'unavailable', reasons: [] }, { unavailableLabel: '推定不可' }), '推定不可');
  assert.equal(formatConfidenceLabel(null), '');
});

// --- レビュー指摘への追加テスト ---

// 決定的な疑似乱数(でたらめな方向の生成用。実データではない)
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

test('高さ調整局面: 検出に無効点を使わない(1艇の該当区間を乱れた点にしても segments 不変)', () => {
  const mk = (extreme) => {
    const A = straightTrack('A', { bearing: 0, durationSec: 300 }); // クローズ継続
    const B = straightTrack('B', { lon0: 139.01, bearing: 75, durationSec: 300 }); // フット
    const C = straightTrack('C', { lon0: 139.02, bearing: 75, durationSec: 300 }); // フット
    const rnd = lcg(42);
    for (let i = 100; i <= 200; i++) {
      B.points[i].accuracy = 500;
      if (extreme) {
        // でたらめな方向へ最大10m動く乱れた点
        const prev = B.points[i - 1];
        const ang = rnd() * 2 * Math.PI, d = rnd() * 10;
        B.points[i] = {
          ...B.points[i],
          lat: prev.lat + (d * Math.cos(ang)) / 111320,
          lon: prev.lon + (d * Math.sin(ang)) / (111320 * Math.cos(35 * DEG)),
        };
      }
    }
    return [A, B, C];
  };
  const clean = mk(false), dirty = mk(true);
  const rC = assessComparison(clean, windFor(clean));
  const rD = assessComparison(dirty, windFor(dirty));
  const shape = (r) => r.segments.map((s) => [s.lo, s.hi, s.pointOfSail, s.tracks.map((t) => t.id)]);
  assert.deepEqual(shape(rD), shape(rC));
  assert.equal(rD.comparableMs, rC.comparableMs);
  // 全点で検出すると乱れた点の影響を受ける(このテストが意味を持つことの確認)
  assert.notDeepEqual(
    detectHeightAdjustWindowsByTrack(dirty, windFor(dirty)),
    detectHeightAdjustWindowsByTrack(clean, windFor(clean)),
  );
});

test('精度: 負値(-1)は accuracy-unknown、0 は合格', () => {
  const A = straightTrack('A', { durationSec: 300, accuracy: 0 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: 0 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 300_000);
  assert.ok(!codes(r).includes('accuracy-unknown'));

  const B2 = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: -1 });
  const r2 = assessComparison([A, B2], windFor([A, B2]));
  assert.equal(r2.level, 'unavailable');
  assert.equal(r2.reasons[0].code, 'accuracy-unknown');
  assert.equal(r2.reasons[0].message, 'GPS 精度の記録がないため比較できません');
});

// 比較区間が0件になり、B の全区間が同じ理由で除外されたときの主理由を返す
const primaryOf = (B) => {
  const A = straightTrack('A', { durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.deepEqual(r.segments, []);
  return r.reasons[0];
};

test('主理由: invalid-position(位置の記録が不正)', () => {
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  for (const q of B.points) q.lat = NaN;
  const p = primaryOf(B);
  assert.equal(p.code, 'invalid-position');
  assert.equal(p.message, '位置の記録が不正で比較できません');
});

test('主理由: gps-gap(全区間で欠損)', () => {
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, dtSec: 6 });
  const p = primaryOf(B);
  assert.equal(p.code, 'gps-gap');
  assert.equal(p.message, 'GPS の記録が5秒を超えて途切れていて、比較できる時間が重なりません');
});

test('主理由: speed(記録速度が異常)', () => {
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  for (const q of B.points) q.speed = 20;
  const p = primaryOf(B);
  assert.equal(p.code, 'speed');
  assert.equal(p.message, '速度が15m/sを超える異常値が多く比較できません');
});

test('主理由: accuracy(精度超過)', () => {
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300, accuracy: 100 });
  const p = primaryOf(B);
  assert.equal(p.code, 'accuracy');
  assert.equal(p.message, 'GPS 精度が50mを超えていて比較できません');
});

test('情報理由: wind-out-of-range(風軸の推定範囲外)は比較区間を削らず信頼度情報として添える', () => {
  // B3方針: wind-out-of-range は比較区間から除外しない。信頼度情報として reasons に添える。
  // 風向はクランプ値(windFromAt の端点クランプ)で計算するため VMG 計算は動作する。
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const far = T0 + 10 * 3_600_000; // 記録終了より十分後の系列だけ
  const ws = new Map([[A, wind4(far, far + 600 * S)], [B, wind4(far, far + 600 * S)]]);
  const r = assessComparison([A, B], ws);
  // B3変更後: unavailable にはならない(比較区間は出る)
  assert.notEqual(r.level, 'unavailable', 'wind-out-of-range だけで unavailable にしない');
  assert.ok(r.comparableMs > 0, '比較区間が出る');
  // wind-out-of-range は信頼度情報として reasons に含まれる(主理由ではない)
  assert.ok(codes(r).includes('wind-out-of-range'), '信頼度情報として reasons に含まれる');
  const wor = r.reasons.find((x) => x.code === 'wind-out-of-range');
  assert.equal(wor.message, '風軸の推定範囲から外れた時間帯を除外しました');
});

test('主理由: no-point-of-sail(全艇リーチ)', () => {
  const A = straightTrack('A', { bearing: 90, durationSec: 300 });
  const B = straightTrack('B', { lat0: 35.01, bearing: 90, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'no-point-of-sail');
  assert.equal(r.reasons[0].message, '風上・風下を走っている時間が重なっていません');
});

test('主理由: height-adjust(高さ調整局面を除くと最低比較時間に届かない)', () => {
  const A = straightTrack('A', { bearing: 0, durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, bearing: 75, durationSec: 300 });
  const C = straightTrack('C', { lon0: 139.02, bearing: 75, durationSec: 300 });
  const r = assessComparison([A, B, C], windFor([A, B, C]));
  assert.equal(r.level, 'unavailable');
  assert.deepEqual(r.segments, []);
  assert.equal(r.reasons[0].code, 'height-adjust');
  assert.equal(r.reasons[0].message, '高さ調整の局面を除くと、連続して比較できる時間が最低60秒に届きません');
});

test('情報理由: 3艇中1艇だけ風軸なし → 残り2艇で比較し、除外を理由に出す', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const C = straightTrack('C', { lon0: 139.02, durationSec: 300 });
  const ws = new Map([[A, wind4(T0, T0 + 300 * S)], [B, wind4(T0, T0 + 300 * S)], [C, []]]);
  const r = assessComparison([A, B, C], ws);
  assert.equal(r.level, 'medium');
  assert.equal(r.reasons[0].code, 'short-compare');
  assert.equal(r.reasons[0].message, '比較可能時間が短いため参考値');
  const nw = r.reasons.find((x) => x.code === 'no-wind-axis');
  assert.equal(nw.message, 'Cの風軸を推定できないため比較から除外しました');
  assert.deepEqual(r.segments[0].tracks, [A, B]);
});

test('風軸: 系列の開始側も windTolMs ちょうどは合格・-1ms は比較区間から除外しないが wind-out-of-range を添える', () => {
  // B3方針: wind-out-of-range は「明らかな異常」でないため比較区間から除外しない。
  const tol = DEFAULT_CONFIDENCE_OPTS.windTolMs;
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const hi = T0 + 900 * S;
  const ok = assessComparison([A, B], new Map([A, B].map((t) => [t, wind4(T0 + tol, hi)])));
  assert.equal(ok.comparableMs, 300_000);
  assert.equal(ok.reasons[0].code, 'short-compare');
  assert.equal(ok.reasons[0].message, '比較可能時間が短いため参考値');
  assert.ok(!codes(ok).includes('wind-out-of-range'));

  const ng = assessComparison([A, B], new Map([A, B].map((t) => [t, wind4(T0 + tol + 1, hi)])));
  // B3変更後: wind-out-of-range でも比較区間から除外しないため comparableMs は変わらない
  assert.equal(ng.comparableMs, 300_000, 'wind-out-of-range でも比較区間は削らない');
  assert.equal(ng.reasons[0].code, 'short-compare');
  const w = ng.reasons.find((x) => x.code === 'wind-out-of-range');
  assert.equal(w.message, '風軸の推定範囲から外れた時間帯を除外しました', '信頼度情報として reasons に添える');
});

test('風軸: tMs が非数だけの系列は風軸なし(no-wind-axis が主理由)', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const ws = new Map([[A, wind4(T0, T0 + 300 * S)], [B, [{ tMs: NaN, windFromDeg: 0 }, { tMs: 'x', windFromDeg: 0 }]]]);
  const r = assessComparison([A, B], ws);
  assert.equal(r.level, 'unavailable');
  assert.equal(r.reasons[0].code, 'no-wind-axis');
  assert.equal(r.reasons[0].message, 'Bの風軸を推定できないため比較できません');
});

test('主理由: 同じ走種の重なり40秒の全体が高さ調整局面 → height-adjust(最長0秒と出さない)', () => {
  // A はクローズ、B・C はフット(いずれも風上)で 40 秒だけ。前後に長く記録のある D(リーチ)がいるため
  // 高さ調整局面の検出範囲が 40 秒の全体を覆い、差し引き後に同じ走種の重なりが残らない。
  const A = straightTrack('A', { bearing: 0, durationSec: 40 });
  const B = straightTrack('B', { lon0: 139.01, bearing: 75, durationSec: 40 });
  const C = straightTrack('C', { lon0: 139.02, bearing: 75, durationSec: 40 });
  const D = straightTrack('D', { lat0: 35.02, bearing: 90, startT: T0 - 60 * S, durationSec: 160 });
  const tracks = [A, B, C, D];
  const r = assessComparison(tracks, windFor(tracks, T0 - 60 * S, T0 + 3_600_000));
  assert.equal(r.level, 'unavailable');
  assert.deepEqual(r.segments, []);
  assert.equal(r.reasons[0].code, 'height-adjust');
  assert.equal(r.reasons[0].message, '高さ調整の局面を除くと比較できる時間がありません');
  assert.ok(!r.reasons.some((x) => x.message.includes('最長0秒')));
});

test('perTrack.byPointOfSail は minuteWinnersDetailed().participation 以上', () => {
  const A = straightTrack('A', { durationSec: 240 });
  const B = straightTrack('B', { lon0: 139.001, bearing: 20, startT: T0 + 60 * S, durationSec: 180 });
  const C = straightTrack('C', { lon0: 139.002, bearing: 10, startT: T0 + 100 * S, durationSec: 90 });
  const tracks = [A, B, C];
  const ws = windFor(tracks);
  const r = assessComparison(tracks, ws);
  assert.ok(r.segments.length >= 1);
  const { participation } = minuteWinnersDetailed(tracks, ws, { comparable: r.segments, validIntervalsByTrack: r.validIntervalsByTrack });
  for (const t of tracks) {
    const p = participation.get(t), c = r.perTrack.get(t).byPointOfSail;
    assert.ok(c.upwind >= p.upwind && c.downwind >= p.downwind, `${t.id}: 比較区間 ${c.upwind} >= 参加 ${p.upwind}`);
  }
  assert.ok(participation.get(A).upwind > 0);
});

// --- 読込時の除外区間(excludedIntervals) ---
// 合成トラックを Sensor Logger 形式の header/rows に戻し、addTrack と同じ prepareTrackPoints で読み込む。
const CSV_HEADER = ['time', 'latitude', 'longitude', 'speed', 'bearing', 'horizontalAccuracy'];
const toRows = (track) => track.points.map((p) => [String(p.t), String(p.lat), String(p.lon), String(p.speed), '0', String(p.accuracy)]);
function loadTrack(src, accuracyFilter = true) {
  const { points, excludedIntervals } = prepareTrackPoints(CSV_HEADER, toRows(src), { accuracyFilter });
  return { ...src, points, tRange: { start: points[0].t, end: points[points.length - 1].t }, excludedIntervals };
}

test('除外区間: 正常 → 精度500m → 正常 の [0, 2000ms] は有効区間にしない(修正前は有効だった)', () => {
  const src = straightTrack('A', { durationSec: 2 });
  src.points[1].accuracy = 500;
  const tr = loadTrack(src);
  assert.deepEqual(tr.points.map((p) => p.t - T0), [0, 2000], '中間点は読込時に削除');
  assert.deepEqual(tr.excludedIntervals, [{ lo: T0, hi: T0 + 2000, code: 'accuracy' }]);
  const ws = wind4(T0, T0 + 2000);
  assert.deepEqual(validIntervals(tr, ws), []);
  // 除外区間を持たない(修正前の addTrack と同じ)トラックでは [0, 2000ms] がつながって有効になる。
  // 点が2つだけだと記録間隔の穴も判定できない(旧データの限界)。
  const { excludedIntervals, ...before } = tr;
  assert.deepEqual(validIntervals(before, ws), [[T0, T0 + 2000]]);
});

test('除外区間: 読込で除いた2点(穴3秒 < maxGapMs)が比較区間・勝者に入らない', () => {
  const A = loadTrack(straightTrack('A', { durationSec: 300 }));
  const srcB = straightTrack('B', { lon0: 139.001, bearing: 10, durationSec: 300 });
  srcB.points[100].accuracy = 500;
  srcB.points[101].accuracy = 500;
  const B = loadTrack(srcB);
  const hole = [T0 + 99 * S, T0 + 102 * S];
  assert.deepEqual(B.excludedIntervals, [{ lo: hole[0], hi: hole[1], code: 'accuracy' }]);

  const ws = windFor([A, B]);
  const r = assessComparison([A, B], ws);
  assert.equal(r.comparableMs, 300_000 - 3_000);
  assert.deepEqual(intersectIntervals(r.segments.map((s) => [s.lo, s.hi]), [hole]), []);
  assert.deepEqual(intersectIntervals(r.validIntervalsByTrack.get(B), [hole]), []);
  assert.ok(codes(r).includes('accuracy'));
  assert.ok(r.reasons.some((x) => x.message === 'GPS 精度が50mを超える時間帯を除外しました'));

  const { winners } = minuteWinnersDetailed([A, B], ws, { comparable: r.segments, validIntervalsByTrack: r.validIntervalsByTrack });
  assert.ok(winners.length > 0);
  assert.deepEqual(intersectIntervals(winners.map((w) => [w.lo, w.hi]), [hole]), [], '除外区間に勝者を出さない');

  // 修正前(除外区間なし・穴の判定もなし)は穴の3秒も比較区間に入っていた
  const Bold = { ...B, excludedIntervals: [] };
  const r0 = assessComparison([A, Bold], windFor([A, Bold]));
  assert.equal(r0.comparableMs, 300_000);
});

test('除外区間: 除外区間内の点で VMG を計算しない(boatMinuteVmg の有効区間に反映)', () => {
  const A = loadTrack(straightTrack('A', { durationSec: 300 }));
  const B = { ...straightTrack('B', { lon0: 139.001, durationSec: 300 }), excludedIntervals: [{ lo: T0 + 60 * S, hi: T0 + 90 * S, code: 'speed' }] };
  const ws = windFor([A, B]);
  const r = assessComparison([A, B], ws);
  const ivs = r.validIntervalsByTrack.get(B);
  assert.deepEqual(ivs, [[T0, T0 + 60 * S], [T0 + 90 * S, T0 + 300 * S]]);
  const mv = boatMinuteVmg(B, ws.get(B), { bucketMs: 30_000, validIntervals: ivs });
  assert.ok(!mv.has(Math.floor((T0 + 75 * S) / 30_000)), '除外区間だけのバケットには VMG を出さない');
  assert.ok(codes(r).includes('speed'));
});

test('除外区間: 旧データ(項目なし)は 1Hz の中の1点抜け(2秒)を record-gap で除外', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.001, durationSec: 300 });
  B.points.splice(150, 1);
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.comparableMs, 298_000);
  assert.ok(codes(r).includes('record-gap'));
  assert.ok(r.reasons.some((x) => x.message === '記録間隔が普段より長い時間帯(読込時に除外された点の可能性)を除外しました'));
});

test('除外区間: 旧データでも等間隔なら何も除外しない。excludedIntervals: [] なら間隔で判定しない', () => {
  const tr = straightTrack('A', { durationSec: 300 });
  const ws = wind4(T0, T0 + 300 * S);
  assert.deepEqual(validIntervals(tr, ws), [[T0, T0 + 300 * S]]);
  const holed = straightTrack('B', { durationSec: 300 });
  holed.points.splice(150, 1);
  assert.deepEqual(validIntervals(holed, ws), [[T0, T0 + 149 * S], [T0 + 151 * S, T0 + 300 * S]]);
  holed.excludedIntervals = [];
  assert.deepEqual(validIntervals(holed, ws), [[T0, T0 + 300 * S]]);
});

test('除外区間: 点が2つ以下・間隔が全部同じ・不正な要素でも例外を出さない', () => {
  const ws = wind4(T0, T0 + 10 * S);
  const one = straightTrack('A', { durationSec: 0 });
  assert.equal(one.points.length, 1);
  assert.deepEqual(validIntervals(one, ws), []);
  const two = straightTrack('A', { durationSec: 1 });
  assert.deepEqual(validIntervals(two, ws), [[T0, T0 + S]]);
  const even = straightTrack('A', { durationSec: 10, dtSec: 2 });
  assert.deepEqual(validIntervals(even, ws), [[T0, T0 + 10 * S]]);
  const bad = { ...straightTrack('A', { durationSec: 10 }), excludedIntervals: [null, { lo: 'x', hi: 1 }, { lo: T0 + 5 * S, hi: T0 + 5 * S, code: 'accuracy' }] };
  assert.deepEqual(validIntervals(bad, ws), [[T0, T0 + 10 * S]]);
});

// --- 肯定的な判定理由 ---
test('肯定的な理由: 信頼度が高でも比較・風軸とも理由が空にならない', () => {
  const A = straightTrack('A', { durationSec: 700 });
  const B = straightTrack('B', { lon0: 139.001, bearing: 10, durationSec: 700 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'high');
  assert.ok(r.reasons.length > 0);
  const ct = r.reasons.find((x) => x.code === 'compare-time');
  assert.equal(ct.message, '連続して比較できる区間1件・合計700秒（最低60秒以上）');
  assert.ok(r.reasons.some((x) => x.code === 'wind-anchors' && x.message === 'Aの風軸はタック/ジャイブ4回から推定'));
  assert.ok(r.reasons.some((x) => x.code === 'wind-coverage'));
  assert.equal(formatConfidenceLabel(r), '信頼度 高', '高の見出しは変えない');
  const w = r.perTrack.get(A).windAxis;
  assert.equal(w.level, 'high');
  assert.deepEqual(w.reasons.map((x) => x.code), ['wind-anchors', 'wind-coverage']);
});

test('肯定的な理由: 中・低の主な理由(reasons[0])と見出しは変わらない', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.001, bearing: 10, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'medium');
  assert.equal(r.reasons[0].code, 'short-compare');
  assert.equal(formatConfidenceLabel(r), '信頼度 中：比較可能時間が短いため参考値');
  assert.ok(codes(r).includes('compare-time'));

  const tr = straightTrack('A', { durationSec: 1000 });
  const few = assessWindAxis([{ tMs: T0, windFromDeg: 0 }, { tMs: T0 + 500 * S, windFromDeg: 0 }], tr);
  assert.equal(few.level, 'medium');
  assert.equal(few.reasons[0].code, 'wind-few-anchors');
  assert.ok(!codes(few).includes('wind-anchors'), '少ない場合の理由と重ねない');
  const low = assessWindAxis([0, 100, 200, 299].map((s) => ({ tMs: T0 + s * S, windFromDeg: 0 })), tr, { windTolMs: 0 });
  assert.equal(low.reasons[0].code, 'wind-low-coverage');
  assert.ok(!codes(low).includes('wind-coverage'), '被覆率が低い場合の理由と重ねない');
});

test('肯定的な理由: 比較不能のときは compare-time を付けない', () => {
  const A = straightTrack('A', { startT: T0, durationSec: 300 });
  const B = straightTrack('B', { startT: T0 + 300 * S, durationSec: 300 });
  const r = assessComparison([A, B], windFor([A, B]));
  assert.equal(r.level, 'unavailable');
  assert.ok(!codes(r).includes('compare-time'));
});

test('windAxisReasonRows: 比較に参加していない艇の風軸理由も全艇分を返す', () => {
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  // C は A/B と記録時刻が重ならない(比較に不参加)が、風軸はある。D は風軸なし
  const C = straightTrack('C', { lon0: 139.02, startT: T0 + 900 * S, durationSec: 300 });
  const D = straightTrack('D', { lon0: 139.03, durationSec: 300 });
  const ws = new Map([
    [A, wind4(T0, T0 + 300 * S)], [B, wind4(T0, T0 + 300 * S)],
    [C, wind4(T0 + 900 * S, T0 + 1200 * S)], [D, []],
  ]);
  const r = assessComparison([A, B, C, D], ws);
  const rows = windAxisReasonRows([A, B, C, D], r.perTrack);
  assert.deepEqual(rows.map((x) => x.track), [A, B, C, D]);
  assert.deepEqual(rows.map((x) => x.participating), [true, true, false, false]);

  const c = rows[2];
  assert.equal(c.level, r.perTrack.get(C).windAxis.level);
  assert.equal(c.head, `信頼度 ${{ high: '高', medium: '中', low: '低' }[c.level]}`);
  assert.deepEqual(c.reasons, r.perTrack.get(C).windAxis.reasons.map((x) => x.message));
  assert.ok(c.reasons.length > 0, '不参加の艇でも風軸の理由がある');
  // 比較全体の理由には不参加の艇 C の風軸理由が入らない(だから別に一覧が要る)
  assert.ok(!r.reasons.some((x) => x.message.startsWith('Cの風軸は')));

  const d = rows[3];
  assert.equal(d.level, 'unavailable');
  assert.equal(d.head, '風軸推定不可');
  assert.deepEqual(d.reasons, ['推定の根拠となるタック/ジャイブが見つかりません']);
});

test('windAxisReasonRows: perTrack がない・不正な入力でも例外なく推定不可として返す', () => {
  const A = straightTrack('A', { durationSec: 60 });
  assert.deepEqual(windAxisReasonRows([A], null).map(({ level, head, reasons, participating }) => ({ level, head, reasons, participating })),
    [{ level: 'unavailable', head: '風軸推定不可', reasons: [], participating: false }]);
  assert.deepEqual(windAxisReasonRows(null, new Map()), []);
  assert.deepEqual(windAxisReasonRows([null, undefined], new Map()), []);
});

// --- B3: wind-out-of-range は比較区間から除外しない(信頼度として表示に添える) ---
// 方針: 除外は明らかな異常(GPS 欠損・異常速度)に限る。風軸推定範囲外は信頼度の低下として表示に添えるのみ。
test('B3: 風軸推定範囲外(wind-out-of-range)でも比較区間に含める', () => {
  // 艇の記録は T0〜T0+300s だが風軸系列は T0+200s〜T0+500s(最初の200秒は wind-out-of-range)
  // 変更後: 最初の200秒も有効区間に含め、比較区間から除外しない
  const tol = DEFAULT_CONFIDENCE_OPTS.windTolMs;
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  // 系列の先頭が記録終了の tol ms 前より後(tol+1ms 外) にある
  const end = T0 + 300 * S;
  const ng = new Map([A, B].map((t) => [t, wind4(T0 - 100 * S, end - tol - 1)]));
  const r = assessComparison([A, B], ng);
  // 変更後: wind-out-of-range でも比較区間から除外しない → comparableMs は除外前と変わらない
  assert.equal(r.comparableMs, 300_000, 'wind-out-of-range でも比較区間から除外しない');
  // ただし理由として wind-out-of-range が含まれる
  assert.ok(codes(r).includes('wind-out-of-range'), 'wind-out-of-range を信頼度理由として添える');
  // level は風軸の信頼度や比較時間で決まる(unavailable にはならない)
  assert.notEqual(r.level, 'unavailable', 'wind-out-of-range だけで unavailable にしない');
});

test('B3: 風軸推定範囲外が全時間帯でも比較区間を出す', () => {
  // 風軸系列が記録時刻より遠い未来にある → 従来は unavailable(wind-out-of-range が主理由)
  // 変更後: 比較区間は出る(風向はクランプ値を使う)。信頼度は lower になりうる
  const A = straightTrack('A', { durationSec: 300 });
  const B = straightTrack('B', { lon0: 139.01, durationSec: 300 });
  const far = T0 + 10 * 3_600_000; // 記録終了より十分後の系列だけ
  const ws = new Map([[A, wind4(far, far + 600 * S)], [B, wind4(far, far + 600 * S)]]);
  const r = assessComparison([A, B], ws);
  // 変更後: 風軸が遠くにあっても比較区間は出る
  assert.ok(r.comparableMs > 0, '風軸が遠い未来でも比較区間から除外しない');
  assert.ok(codes(r).includes('wind-out-of-range'), 'wind-out-of-range を理由として添える');
  assert.notEqual(r.level, 'unavailable', 'wind-out-of-range だけで unavailable にしない');
});
