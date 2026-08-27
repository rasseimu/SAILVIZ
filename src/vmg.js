// src/vmg.js
// 複数艇のGPS軌跡を風軸基準でVMG比較する純関数群。DOM/副作用なし。
// 風軸時系列 WindEstimate[] を抽象入力に取り、その生成元とは疎結合。
import { normalizeDeg, circDiffDeg, circMedianDeg, computeCog, segmentLegs } from './windaxis.js';
import { haversineMeters } from './gps.js';

const DEG = Math.PI / 180;

// windSeries[hi].tMs >= t となる最小 hi（t は範囲内前提）。
function upperIndex(windSeries, t) {
  let lo = 0, hi = windSeries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windSeries[mid].tMs < t) lo = mid + 1;
    else hi = mid;
  }
  return hi;
}

// 時刻 t の風向を円周補間。空配列は null、範囲外は端点にクランプ。
export function windFromAt(windSeries, t) {
  const n = windSeries.length;
  if (n === 0) return null;
  if (t <= windSeries[0].tMs) return normalizeDeg(windSeries[0].windFromDeg);
  if (t >= windSeries[n - 1].tMs) return normalizeDeg(windSeries[n - 1].windFromDeg);
  const hi = upperIndex(windSeries, t);
  const a = windSeries[hi - 1], b = windSeries[hi];
  const span = b.tMs - a.tMs;
  const f = span === 0 ? 0 : (t - a.tMs) / span;
  return normalizeDeg(a.windFromDeg + circDiffDeg(b.windFromDeg, a.windFromDeg) * f);
}

// 1サンプルのVMG成分。upwind=風上前進成分、downwind=風下前進成分（符号反転）。
export function vmgComponents(cog, speed, windDeg) {
  const delta = circDiffDeg(cog, windDeg);
  const upwind = speed * Math.cos(delta * DEG);
  return { delta, upwind, downwind: -upwind };
}

// レグ代表方位と風向から走種を判定。90°±deadband をリーチとして除外。
export function classifyPointOfSail(headingDeg, windDeg, deadband = 12) {
  const absD = Math.abs(circDiffDeg(headingDeg, windDeg));
  if (absD < 90 - deadband) return 'upwind';
  if (absD > 90 + deadband) return 'downwind';
  return 'reach';
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// レグの落ち着き区間（セトリング除外＋末尾10%トリム）のサンプル列。除外後が空なら全体。
function steadyWindow(seg, settleSec, settleM) {
  if (seg.length === 0) return [];
  const start = seg[0];
  const steady = [];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (i > 0) acc += haversineMeters(seg[i - 1], seg[i]);
    const dtSec = (seg[i].t - start.t) / 1000;
    if (dtSec >= settleSec && acc >= settleM) steady.push(seg[i]);
  }
  const trimmed = steady.slice(0, Math.max(1, Math.floor(steady.length * 0.9)));
  return trimmed.length ? trimmed : seg;
}

// 1艇の beat/run レグごとの平均VMG。リーチ・風向欠損レグは除外。
export function boatLegVmg(track, windSeries, opts = {}) {
  const deadband = opts.deadband ?? 12;
  const settleSec = opts.settleSec ?? 12;
  const settleM = opts.settleM ?? 30;
  const minLegSec = opts.minLegSec ?? 8;
  const minLegM = opts.minLegM ?? 20;

  const samples = computeCog(track.points, opts.cogOpts ?? {});
  const { legs } = segmentLegs(samples, opts.segOpts ?? {});
  const out = [];
  for (const leg of legs) {
    const wMid = windFromAt(windSeries, (leg.startT + leg.endT) / 2);
    if (wMid == null) continue;
    const pos = classifyPointOfSail(leg.headingDeg, wMid, deadband);
    if (pos === 'reach') continue;

    const steady = steadyWindow(leg.samples, settleSec, settleM);
    let sumVmg = 0, sumSpeed = 0, sumTwa = 0;
    for (const s of steady) {
      const w = windFromAt(windSeries, s.t);
      const c = vmgComponents(s.cog, s.speed, w);
      sumVmg += pos === 'upwind' ? c.upwind : c.downwind;
      sumSpeed += s.speed;
      sumTwa += Math.abs(c.delta);
    }
    const nSamples = steady.length;
    const durSec = (leg.endT - leg.startT) / 1000;
    const confidence = clamp01(
      0.5 * Math.min(1, durSec / (minLegSec * 2)) +
      0.3 * Math.min(1, leg.lenM / (minLegM * 2)) +
      0.2 * Math.min(1, nSamples / 20)
    );
    out.push({
      boatId: track.id,
      startT: leg.startT, endT: leg.endT,
      pointOfSail: pos,
      meanVmg: sumVmg / nSamples,
      meanSpeed: sumSpeed / nSamples,
      meanTwa: sumTwa / nSamples,
      lenM: leg.lenM, durSec, nSamples, confidence,
    });
  }
  return out;
}

// レグ群を「全境界の和集合」で区間分割し、各区間・各走種で最大VMG艇を勝者とする。
// 同一走種の参加艇が minBoats 未満の区間は勝者なし。隣接同一勝者帯は結合。
export function winnerTimeline(perBoatLegVmg, opts = {}) {
  const minBoats = opts.minBoats ?? 2;
  const colors = opts.colors ?? {};
  const bounds = new Set();
  for (const l of perBoatLegVmg) { bounds.add(l.startT); bounds.add(l.endT); }
  const times = [...bounds].sort((a, b) => a - b);

  const raw = []; // {boatId, pointOfSail, vmg, lo, hi}
  for (let i = 0; i + 1 < times.length; i++) {
    const lo = times[i], hi = times[i + 1];
    const mid = (lo + hi) / 2;
    const active = perBoatLegVmg.filter((l) => l.startT <= mid && mid < l.endT);
    for (const pos of ['upwind', 'downwind']) {
      const group = active.filter((l) => l.pointOfSail === pos);
      if (group.length < minBoats) continue;
      const win = group.reduce((a, b) => (b.meanVmg > a.meanVmg ? b : a));
      raw.push({ boatId: win.boatId, pointOfSail: pos, vmg: win.meanVmg, lo, hi });
    }
  }

  // 隣接（hi===次のlo）で同一 boatId・同一走種を結合
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.boatId === seg.boatId && last.pointOfSail === seg.pointOfSail && last.hi === seg.lo) {
      last.hi = seg.hi;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged.map((m) => ({
    boatId: m.boatId, color: colors[m.boatId] || '#888',
    lo: m.lo, hi: m.hi, pointOfSail: m.pointOfSail, vmg: m.vmg,
  }));
}

// [from,to] と [a,b] の交差長（ms）。
function overlapMs(from, to, a, b) {
  return Math.max(0, Math.min(to, b) - Math.max(from, a));
}

// 艇×走種でVMGを集約。winRatio は highlights の勝ち時間 / 該当レグ在時間。
export function rankVmg(perBoatLegVmg, { from, to, highlights = [] }) {
  const groups = new Map(); // key=`${boatId}|${pos}`
  for (const l of perBoatLegVmg) {
    const ov = overlapMs(from, to, l.startT, l.endT);
    if (ov <= 0) continue;
    const key = `${l.boatId}|${l.pointOfSail}`;
    const g = groups.get(key) || { boatId: l.boatId, pointOfSail: l.pointOfSail, wSum: 0, wVmg: 0, legCount: 0, bestLegVmg: -Infinity, activeMs: 0 };
    g.wSum += ov; g.wVmg += l.meanVmg * ov; g.legCount += 1;
    g.bestLegVmg = Math.max(g.bestLegVmg, l.meanVmg);
    g.activeMs += ov;
    groups.set(key, g);
  }
  for (const h of highlights) {
    const key = `${h.boatId}|${h.pointOfSail}`;
    const g = groups.get(key);
    if (g) g.winMs = (g.winMs || 0) + overlapMs(from, to, h.lo, h.hi);
  }
  const rows = [...groups.values()].map((g) => ({
    boatId: g.boatId, pointOfSail: g.pointOfSail,
    meanVmg: g.wSum ? g.wVmg / g.wSum : 0,
    winRatio: g.activeMs ? (g.winMs || 0) / g.activeMs : 0,
    legCount: g.legCount, bestLegVmg: g.bestLegVmg,
  }));
  rows.sort((a, b) => (a.pointOfSail < b.pointOfSail ? -1 : a.pointOfSail > b.pointOfSail ? 1 : b.meanVmg - a.meanVmg));
  return rows;
}

// 複数艇＋風軸から、レグVMG・勝ちハイライト・ランキングを一括算出する統合エントリ。
export function analyzeFleetVmg(tracks, windSeries, opts = {}) {
  const colors = {};
  const perBoatLegVmg = [];
  for (const track of tracks) {
    colors[track.id] = track.color || '#888';
    perBoatLegVmg.push(...boatLegVmg(track, windSeries, opts));
  }
  const highlights = winnerTimeline(perBoatLegVmg, { minBoats: opts.minBoats ?? 2, colors });
  let from = opts.from, to = opts.to;
  if (from == null || to == null) {
    from = Math.min(...perBoatLegVmg.map((l) => l.startT), Infinity);
    to = Math.max(...perBoatLegVmg.map((l) => l.endT), -Infinity);
  }
  const ranks = perBoatLegVmg.length ? rankVmg(perBoatLegVmg, { from, to, highlights }) : [];
  return { perBoatLegVmg, highlights, ranks };
}

// 全艇の風軸推定を共通グリッド上で円周中央値統合し、単一 WindEstimate[] を返す。
// estimator は windaxis の estimateWindAxisSeries を想定（疎結合のため注入式・必須）。
export function unifyWindAxis(tracks, { estimator, marks, gridMs = 5000 } = {}) {
  if (typeof estimator !== 'function') {
    throw new Error('unifyWindAxis: estimator（風軸推定関数）が必要です');
  }
  const perBoat = tracks.map((t) => estimator(t, { marks })).filter((s) => s && s.length);
  if (perBoat.length === 0) return [];
  let lo = Infinity, hi = -Infinity;
  for (const s of perBoat) { lo = Math.min(lo, s[0].tMs); hi = Math.max(hi, s[s.length - 1].tMs); }

  const out = [];
  for (let t = lo; t <= hi; t += gridMs) {
    const degs = [];
    for (const s of perBoat) {
      if (t < s[0].tMs || t > s[s.length - 1].tMs) continue; // 範囲外の艇は寄与させない
      const w = windFromAt(s, t);
      if (w != null) degs.push(w);
    }
    if (degs.length === 0) continue;
    out.push({ tMs: t, windFromDeg: circMedianDeg(degs), source: 'unified', confidence: degs.length / perBoat.length });
  }
  return out;
}
