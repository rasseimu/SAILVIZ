import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeg, circDiffDeg, circMeanDeg, circMedianDeg, bisectorDeg, bearingDeg, computeCog,
  segmentLegs, classifyManeuver, estimateWindFromManeuver, learnPolarAngles,
  assignLegKinds, fillLegEstimates, rejectMarkRoundings, smoothWindSeries,
  estimateWindAxisSeries,
} from '../src/windaxis.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// 円周量の近さ（北またぎ対応）
const nearCirc = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(circDiffDeg(a, b)) < eps, `circ ${a} != ${b}`);

test('normalizeDeg wraps into [0,360)', () => {
  near(normalizeDeg(370), 10);
  near(normalizeDeg(-10), 350);
  near(normalizeDeg(0), 0);
});

test('circDiffDeg signed shortest difference', () => {
  near(circDiffDeg(10, 350), 20);    // 10 - 350 = -340 -> +20
  near(circDiffDeg(350, 10), -20);
  near(circDiffDeg(90, 0), 90);
  near(circDiffDeg(180, 0), 180);    // antiparallel: return +180, not -180
  near(circDiffDeg(0, 180), 180);    // antiparallel: return +180, not -180
});

test('circMeanDeg averages across north', () => {
  nearCirc(circMeanDeg([350, 10]), 0);
  nearCirc(circMeanDeg([10, 20, 30]), 20);
});

test('circMedianDeg is robust to an outlier', () => {
  near(circMedianDeg([9, 10, 11, 200]), 10);   // medoid: exactly 10
  near(circMedianDeg([10, 10, 10, 200]), 10);  // all-equal: exactly 10
  near(circMedianDeg([45]), 45);               // singleton: exactly 45
  nearCirc(circMedianDeg([358, 0, 2]), 0);     // crossing north: ≈ 0
});

test('bisectorDeg picks the inner bisector', () => {
  nearCirc(bisectorDeg(45, 315), 0);    // タック: 風上
  nearCirc(bisectorDeg(135, 225), 180);  // ジャイブ: 風下
});

test('bearingDeg north/east', () => {
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.31, lon: 139.48 }), 0, 1);
  nearCirc(bearingDeg({ lat: 35.30, lon: 139.48 }, { lat: 35.30, lon: 139.49 }), 90, 1);
});

// 東へ一定速で進む合成トラック（0.2s刻み, 経度増加=東）を作る
function eastwardTrack(n = 40, dtMs = 200, speed = 3) {
  const pts = [];
  let lat = 35.30, lon = 139.48;
  const t0 = 1_787_000_000_000;
  const mPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    pts.push({ t: t0 + i * dtMs, lat, lon, speed, bearing: 90, accuracy: 5 });
    lon += (speed * (dtMs / 1000)) / mPerDegLon; // 東へ
  }
  return pts;
}

test('computeCog: 東進トラックのCOGは約90度', () => {
  const samples = computeCog(eastwardTrack(), { windowMs: 1000, minSpeedMps: 1 });
  assert.ok(samples.length > 0);
  for (const s of samples) assert.ok(Math.abs(circDiffDeg(s.cog, 90)) < 2, `cog=${s.cog}`);
});

test('computeCog: 低速点を除外する', () => {
  const pts = eastwardTrack(10, 200, 0.5); // すべて低速
  const samples = computeCog(pts, { minSpeedMps: 1.5 });
  assert.equal(samples.length, 0);
});

// 指定方位・速度で一定時間直進するサンプル列を生成（cog付きSampleを直接作る）
function straightSamples(t0, headingDeg, seconds, speed = 3, dtMs = 500, startLL = null) {
  const out = [];
  let lat = startLL ? startLL.lat : 35.30;
  let lon = startLL ? startLL.lon : 139.48;
  const rad = headingDeg * Math.PI / 180;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat * Math.PI / 180);
  const n = Math.floor((seconds * 1000) / dtMs);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dtMs;
    out.push({ t, lat, lon, cog: headingDeg, speed });
    lat += (Math.cos(rad) * speed * (dtMs / 1000)) / mLat;
    lon += (Math.sin(rad) * speed * (dtMs / 1000)) / mLon;
  }
  return out;
}

// スタボ45° 30s → ポート315° 30s（間に1点だけ低速の旋回を挟む形は簡略化し連結）
function beatTwoLegs() {
  const t0 = 1_787_000_000_000;
  const leg1 = straightSamples(t0, 45, 30);
  const last = leg1[leg1.length - 1];
  const leg2 = straightSamples(last.t + 500, 315, 30, 3, 500, { lat: last.lat, lon: last.lon });
  return [...leg1, ...leg2];
}

test('segmentLegs: 2レグと1マニューバを検出し代表方位を復元', () => {
  const { legs, maneuvers } = segmentLegs(beatTwoLegs(), { minLegSec: 5, settleSec: 4 });
  assert.equal(legs.length, 2);
  assert.equal(maneuvers.length, 1);
  assert.ok(Math.abs(circDiffDeg(legs[0].headingDeg, 45)) < 3);
  assert.ok(Math.abs(circDiffDeg(legs[1].headingDeg, 315)) < 3);
  assert.ok(Math.abs(circDiffDeg(maneuvers[0].turnDeg, 90)) < 5 || Math.abs(maneuvers[0].turnDeg - 90) < 5);
});

// タック直後のベアアウェイ（ゆるやかな方位変化）から整定値を回帰テスト
// シナリオ: タック後に 105°→45° へ 20s かけてゆるやかにベアアウェイ（1.5°/500ms = 3°/s < 8°/s 閾値）
//          その後 10s は整定方位 45° で直進。
// セトリング窓なし(0s) では medoid が 75° 付近に引っ張られるが、
// セトリング窓あり(21s) では整定区間のみで medoid = 45° になることを確認。
function bearAwayLeg() {
  const t0 = 1_787_100_000_000;
  const nRamp = 40;       // 20s @ 500ms
  const nSettled = 20;    // 10s @ 500ms
  const dtMs = 500;
  const speedMps = 3;
  const startHead = 105;  // ベアアウェイ開始方位
  const endHead = 45;     // 整定方位
  const headStep = (endHead - startHead) / nRamp; // -1.5°/step
  const samples = [];
  let lat = 35.30, lon = 139.48;
  for (let i = 0; i < nRamp + nSettled; i++) {
    const t = t0 + i * dtMs;
    const cog = i < nRamp ? startHead + i * headStep : endHead;
    const rad = cog * Math.PI / 180;
    const mLat = 111_320, mLon = 111_320 * Math.cos(lat * Math.PI / 180);
    samples.push({ t, lat, lon, cog, speed: speedMps });
    lat += (Math.cos(rad) * speedMps * (dtMs / 1000)) / mLat;
    lon += (Math.sin(rad) * speedMps * (dtMs / 1000)) / mLon;
  }
  return samples;
}

test('segmentLegs: タック直後のベアアウェイ開始でも代表方位は整定値', () => {
  const samples = bearAwayLeg();

  // settleSec=0: セトリング除外なし — medoid はベアアウェイ区間に引っ張られ 45° からずれる
  const { legs: legsNoSettle } = segmentLegs(samples, { minLegSec: 5, minLegM: 10, settleSec: 0, settleM: 0 });
  assert.ok(legsNoSettle.length >= 1, 'セトリングなし: レグが検出されること');
  const headNoSettle = legsNoSettle[0].headingDeg;

  // settleSec=21: 20s のベアアウェイ区間を除外し整定区間のみを使う
  const { legs: legsWithSettle } = segmentLegs(samples, { minLegSec: 5, minLegM: 10, settleSec: 21, settleM: 0 });
  assert.ok(legsWithSettle.length >= 1, 'セトリングあり: レグが検出されること');
  const headWithSettle = legsWithSettle[0].headingDeg;

  // (a) セトリング窓あり → 代表方位が整定値 45° に近い
  assert.ok(Math.abs(circDiffDeg(headWithSettle, 45)) < 3,
    `settleSec=21 のとき headingDeg は 45° 付近のはず: got ${headWithSettle}`);

  // (b) 2つの headingDeg が意味ある差を持つ — セトリング除外が実際に効いている証明
  assert.ok(Math.abs(circDiffDeg(headNoSettle, headWithSettle)) > 5,
    `セトリング有無で headingDeg に差がなければ settling 処理が無効化されている: noSettle=${headNoSettle} withSettle=${headWithSettle}`);
});

test('classifyManeuver: 大きく失速=タック / 速度維持=ジャイブ', () => {
  const tack = classifyManeuver({ speedDropRatio: 0.3, turnDeg: 90 });
  const gybe = classifyManeuver({ speedDropRatio: 0.9, turnDeg: 90 });
  assert.equal(tack.type, 'tack');
  assert.equal(gybe.type, 'gybe');
  assert.ok(tack.confidence > 0 && tack.confidence <= 1);
});

test('estimateWindFromManeuver: タックは風上=二等分、ジャイブは+180', () => {
  const base = { tMs: 1, lat: 35.3, lon: 139.48, headingBefore: 45, headingAfter: 315, confidence: 1 };
  const tack = estimateWindFromManeuver({ ...base, type: 'tack' });
  const gybe = estimateWindFromManeuver({ ...base, headingBefore: 135, headingAfter: 225, type: 'gybe' });
  assert.ok(Math.abs(circDiffDeg(tack.windFromDeg, 0)) < 0.5);   // 風上=北
  assert.ok(Math.abs(circDiffDeg(gybe.windFromDeg, 0)) < 0.5);   // 風下180 -> 風上0
  assert.equal(tack.source, 'anchor');
});

test('learnPolarAngles: クローズ角とランニング角を学習', () => {
  const anchors = [
    { type: 'tack', windFromDeg: 0, headingBefore: 45, headingAfter: 315 },
    { type: 'gybe', windFromDeg: 0, headingBefore: 135, headingAfter: 225 },
  ];
  const { betaCloseHauled, betaRun } = learnPolarAngles(anchors);
  assert.ok(Math.abs(betaCloseHauled - 45) < 1);
  assert.ok(Math.abs(betaRun - 45) < 1);
});

test('assignLegKinds: 両側タックのレグはbeat', () => {
  const legs = [{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }];
  const mans = [
    { legBeforeIdx: 0, legAfterIdx: 1, type: 'tack' },
    { legBeforeIdx: 1, legAfterIdx: 2, type: 'tack' },
  ];
  const out = assignLegKinds(legs, mans);
  assert.equal(out[1].kind, 'beat');
});

test('fillLegEstimates: ビートのレグ内でcogからwindFromを逆算', () => {
  const legs = [{
    kind: 'beat', headingDeg: 45, startT: 0, endT: 20000,
    samples: [{ t: 0, cog: 45, lat: 35.3, lon: 139.48, speed: 3 },
              { t: 10000, cog: 48, lat: 35.3, lon: 139.48, speed: 3 }],
  }];
  const anchors = [{ tMs: 0, windFromDeg: 0, type: 'tack' }];
  const est = fillLegEstimates(legs, anchors, { betaCloseHauled: 45, betaRun: 45 }, { stepMs: 10000 });
  assert.ok(est.length >= 1);
  assert.equal(est[0].source, 'leg');
  assert.ok(Math.abs(circDiffDeg(est[0].windFromDeg, 0)) < 1);  // cog45 - 45 = 0
});

test('rejectMarkRoundings: マーク近傍のマニューバを除外', () => {
  const mans = [
    { tMs: 1, lat: 35.2937, lon: 139.4898 }, // マーク直近
    { tMs: 2, lat: 35.3100, lon: 139.4800 }, // 遠い
  ];
  const marks = [{ lat: 35.2937, lon: 139.4898 }];
  const out = rejectMarkRoundings(mans, marks, { radiusM: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].tMs, 2);
});

test('rejectMarkRoundings: marks空なら素通し', () => {
  const mans = [{ tMs: 1, lat: 35.3, lon: 139.48 }];
  assert.equal(rejectMarkRoundings(mans, [], {}).length, 1);
});

test('smoothWindSeries: 飛び値を除去し局所中央値に平滑化', () => {
  const series = [
    { tMs: 0, windFromDeg: 10, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 1000, windFromDeg: 12, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 2000, windFromDeg: 200, confidence: 1, source: 'anchor', type: 'tack' }, // 飛び値
    { tMs: 3000, windFromDeg: 11, confidence: 1, source: 'anchor', type: 'tack' },
    { tMs: 4000, windFromDeg: 13, confidence: 1, source: 'anchor', type: 'tack' },
  ];
  const out = smoothWindSeries(series, { windowMs: 10000, madK: 3, minMadDeg: 20 });
  assert.ok(out.every((p) => Math.abs(circDiffDeg(p.windFromDeg, 11)) < 10));
  assert.ok(out.length < series.length); // 飛び値が落ちる
});

// beatTwoLegs の Sample を、computeCog が扱う生 points へ変換（cog は捨て speed/bearing を付与）
function samplesToPoints(samples) {
  return samples.map((s) => ({ t: s.t, lat: s.lat, lon: s.lon, speed: s.speed, bearing: -1, accuracy: 5 }));
}

// タックを含むビートのraw点列を生成する。
// 直進レグは ~3 m/s で指定秒数進み、タック中は ~0.6 m/s で4秒かけてヘディングを回す。
// computeCog (minSpeedMps=1.5) によってタック中の低速点はフィルタされるため、
// Fix 1 の raw点再サンプリングで減速ディップを捉えられることを検証するための合成データ。
function beatWithTacks(t0, legSec = 30, tackSec = 4, dtMs = 500) {
  const legs = [45, 315, 45]; // 3レグ: スタボ→ポート→スタボ
  const legSpeed = 3;         // 直進速度 [m/s]
  const tackSpeed = 0.6;      // タック中低速 [m/s]
  const mLat = 111_320;
  const refLat = 35.30;
  const mLon = 111_320 * Math.cos(refLat * Math.PI / 180);
  const pts = [];
  let t = t0;
  let lat = refLat, lon = 139.48;

  for (let li = 0; li < legs.length; li++) {
    const headDeg = legs[li];
    const rad = headDeg * Math.PI / 180;
    const n = Math.floor((legSec * 1000) / dtMs);
    for (let i = 0; i < n; i++) {
      pts.push({ t, lat, lon, speed: legSpeed, bearing: -1, accuracy: 5 });
      lat += (Math.cos(rad) * legSpeed * (dtMs / 1000)) / mLat;
      lon += (Math.sin(rad) * legSpeed * (dtMs / 1000)) / mLon;
      t += dtMs;
    }
    // タックを挿入（最後のレグの後は不要）
    if (li < legs.length - 1) {
      const fromDeg = legs[li];
      const toDeg = legs[li + 1];
      const nTack = Math.floor((tackSec * 1000) / dtMs);
      for (let j = 0; j < nTack; j++) {
        // ヘディングを線形補間しながら低速で前進
        const frac = nTack > 1 ? j / (nTack - 1) : 0;
        let interpDeg = fromDeg + circDiffDeg(toDeg, fromDeg) * frac;
        const irad = interpDeg * Math.PI / 180;
        pts.push({ t, lat, lon, speed: tackSpeed, bearing: -1, accuracy: 5 });
        lat += (Math.cos(irad) * tackSpeed * (dtMs / 1000)) / mLat;
        lon += (Math.sin(irad) * tackSpeed * (dtMs / 1000)) / mLon;
        t += dtMs;
      }
    }
  }
  return pts;
}

test('estimateWindAxisSeries: ビートから風向≈0°(北)を復元', () => {
  // beatWithTacks: 45°→(tack 0.6m/s)→315°→(tack)→45° の3レグ2タック。
  // computeCog (minSpeedMps=1.5) がタック中低速点を除外するが、
  // Fix 1 により raw点からdipを検出しタックとして判別できることを検証。
  const points = beatWithTacks(1_787_000_000_000);
  const series = estimateWindAxisSeries({ points }, {
    marks: [],
    opts: { minLegSec: 5, settleSec: 4, windowMs: 1000, minSpeedMps: 1.5 },
  });
  assert.ok(series.length > 0, `series should be non-empty`);
  // 少なくとも1つのタックアンカーが存在すること
  const tackAnchor = series.find((p) => p.source === 'anchor' && p.type === 'tack');
  assert.ok(tackAnchor, `tack anchor not found; anchors=${JSON.stringify(series.filter(p=>p.source==='anchor').map(p=>({type:p.type,wind:p.windFromDeg})))}`);
  // そのタックアンカーの風向が北付近（±8°以内）
  assert.ok(Math.abs(circDiffDeg(tackAnchor.windFromDeg, 0)) < 8,
    `tackAnchor.windFromDeg=${tackAnchor.windFromDeg} (expected ≈0°)`);
});

test('estimateWindAxisSeries: アンカー無しなら空配列', () => {
  const points = samplesToPoints(straightSamples(1_787_000_000_000, 45, 40)); // 1レグのみ=マニューバ無し
  const series = estimateWindAxisSeries({ points }, { opts: { minLegSec: 5, windowMs: 1000, minSpeedMps: 1 } });
  assert.deepEqual(series, []);
});
