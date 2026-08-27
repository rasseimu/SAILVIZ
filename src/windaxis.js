// src/windaxis.js
// GPS軌跡からの風軸(風向)推定。円周演算＋レグ分割＋タック/ジャイブ幾何＋帆走角学習。
// すべて純粋関数。DOM/副作用なし。

import { positionAt, speedAt } from './interpolate.js';
import { haversineMeters } from './gps.js';

const DEG = Math.PI / 180;

// 角度を [0, 360) に正規化
export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

// a - b を (-180, 180] に正規化した符号付き差
export function circDiffDeg(a, b) {
  const d = ((a - b + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

export function circMeanDeg(degs) {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos(d * DEG); y += Math.sin(d * DEG); }
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

// 円周中央値(medoid): 観測値のうち，他のすべての観測値への円周偏差の絶対値の和を最小化する値
export function circMedianDeg(degs) {
  if (degs.length === 0) return 0;
  let best = degs[0], bestCost = Infinity;
  for (let i = 0; i < degs.length; i++) {
    const c = degs[i];
    let cost = 0;
    for (const d of degs) cost += Math.abs(circDiffDeg(d, c));
    if (cost < bestCost || (cost === bestCost && c > best)) {
      bestCost = cost; best = c;
    }
  }
  return normalizeDeg(best);
}

// 内側(短弧側)の二等分方位
export function bisectorDeg(a, b) {
  return normalizeDeg(a + circDiffDeg(b, a) / 2);
}

// 初期方位: ふたつの緯度経度間の大円路の方向角（度、北=0）
export function bearingDeg(from, to) {
  const φ1 = from.lat * DEG, φ2 = to.lat * DEG;
  const Δλ = (to.lon - from.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

// 位置から中心差分でCOGを算出し、speed>=閾値の点のみ返す
export function computeCog(points, opts = {}) {
  const windowMs = opts.windowMs ?? 3000;
  const minSpeedMps = opts.minSpeedMps ?? 1.5;
  const half = windowMs / 2;
  const out = [];
  for (const p of points) {
    const a = positionAt(points, p.t - half);
    const b = positionAt(points, p.t + half);
    if (!a || !b) continue; // 端点は窓が取れないので除外
    const sp = speedAt(points, p.t);
    if (sp == null || sp < minSpeedMps) continue;
    out.push({ t: p.t, lat: p.lat, lon: p.lon, cog: bearingDeg(a, b), speed: sp });
  }
  return out;
}

// レグの落ち着き区間から代表方位を求める（セトリング＋末尾を除外して circMedianDeg）
function representativeHeading(seg, settleSec, settleM) {
  if (seg.length === 0) return { headingDeg: 0, meanSpeed: 0, lenM: 0 };
  // 距離累積
  let lenM = 0;
  for (let i = 1; i < seg.length; i++) lenM += haversineMeters(seg[i - 1], seg[i]);
  const start = seg[0];
  // 開始からの経過(時間 or 距離)がセトリングを超えた点だけを steady とする
  const steady = [];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (i > 0) acc += haversineMeters(seg[i - 1], seg[i]);
    const dtSec = (seg[i].t - start.t) / 1000;
    if (dtSec >= settleSec && acc >= settleM) steady.push(seg[i]);
  }
  // 末尾の小区間(旋回直前)を軽く落とす: steady の最後10%を除外
  const trimmed = steady.slice(0, Math.max(1, Math.floor(steady.length * 0.9)));
  const use = trimmed.length ? trimmed : seg;
  const headingDeg = circMedianDeg(use.map((s) => s.cog));
  const meanSpeed = use.reduce((a, s) => a + s.speed, 0) / use.length;
  return { headingDeg, meanSpeed, lenM };
}

// 減速比でタック/ジャイブを判別（タックは失速が大きい）
export function classifyManeuver(m, opts = {}) {
  const thr = opts.tackMaxSpeedDropRatio ?? 0.6;
  const type = m.speedDropRatio < thr ? 'tack' : 'gybe';
  const confidence = Math.max(0, Math.min(1, Math.abs(m.speedDropRatio - thr) / thr));
  return { type, confidence };
}

export function segmentLegs(samples, opts = {}) {
  const turnThresh = opts.turnRateThreshDegPerSec ?? 8;
  const minLegSec = opts.minLegSec ?? 8;
  const minLegM = opts.minLegM ?? 20;
  const settleSec = opts.settleSec ?? 12;
  const settleM = opts.settleM ?? 30;

  // 1) 各サンプル間の旋回レートで「旋回中」フラグを付ける
  const turning = new Array(samples.length).fill(false);
  for (let i = 1; i < samples.length; i++) {
    const dtSec = (samples[i].t - samples[i - 1].t) / 1000;
    if (dtSec <= 0) continue;
    const rate = Math.abs(circDiffDeg(samples[i].cog, samples[i - 1].cog)) / dtSec;
    if (rate > turnThresh) { turning[i] = true; turning[i - 1] = true; }
  }

  // 2) 非旋回の連続区間をレグ候補に、旋回区間をマニューバ帯にする
  const legs = [];
  const maneuverZones = []; // {startIdx,endIdx}
  let i = 0;
  while (i < samples.length) {
    if (turning[i]) {
      const s = i;
      while (i < samples.length && turning[i]) i++;
      maneuverZones.push({ startIdx: s, endIdx: i - 1 });
    } else {
      const s = i;
      while (i < samples.length && !turning[i]) i++;
      const seg = samples.slice(s, i);
      const durSec = seg.length ? (seg[seg.length - 1].t - seg[0].t) / 1000 : 0;
      const rep = representativeHeading(seg, settleSec, settleM);
      if (durSec >= minLegSec && rep.lenM >= minLegM) {
        legs.push({
          startT: seg[0].t, endT: seg[seg.length - 1].t,
          headingDeg: rep.headingDeg, meanSpeed: rep.meanSpeed, lenM: rep.lenM,
          samples: seg, kind: 'unknown',
        });
      }
    }
  }

  // 3) 隣接レグ間にマニューバを1つ作る
  const maneuvers = [];
  for (let k = 1; k < legs.length; k++) {
    const before = legs[k - 1], after = legs[k];
    // 間にある旋回帯の最低速
    const zone = maneuverZones.find((z) => samples[z.startIdx].t >= before.endT && samples[z.endIdx].t <= after.startT);
    let minSpeed = Math.min(before.meanSpeed, after.meanSpeed);
    let mid = { lat: (before.samples.at(-1).lat + after.samples[0].lat) / 2, lon: (before.samples.at(-1).lon + after.samples[0].lon) / 2 };
    if (zone) {
      for (let z = zone.startIdx; z <= zone.endIdx; z++) minSpeed = Math.min(minSpeed, samples[z].speed);
      const midSample = samples[Math.floor((zone.startIdx + zone.endIdx) / 2)];
      mid = { lat: midSample.lat, lon: midSample.lon };
    }
    const legAvg = (before.meanSpeed + after.meanSpeed) / 2 || 1;
    maneuvers.push({
      tMs: (before.endT + after.startT) / 2,
      lat: mid.lat, lon: mid.lon,
      legBeforeIdx: k - 1, legAfterIdx: k,
      headingBefore: before.headingDeg, headingAfter: after.headingDeg,
      turnDeg: Math.abs(circDiffDeg(after.headingDeg, before.headingDeg)),
      minSpeed, speedDropRatio: minSpeed / legAvg,
    });
  }
  return { legs, maneuvers };
}
