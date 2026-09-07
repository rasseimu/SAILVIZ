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
    let sumVmg = 0, sumSpeed = 0, sumTwa = 0, n = 0;
    for (const s of steady) {
      const w = windFromAt(windSeries, s.t);
      if (w == null) continue;
      const c = vmgComponents(s.cog, s.speed, w);
      sumVmg += pos === 'upwind' ? c.upwind : c.downwind;
      sumSpeed += s.speed;
      sumTwa += Math.abs(c.delta);
      n++;
    }
    if (n === 0) continue;
    const nSamples = n;
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

// 時刻 t の COG を最近傍サンプルから取得。tolMs を超えて離れていれば null(=非アクティブ)。
function cogAt(samples, t, tolMs) {
  const n = samples.length;
  if (n === 0 || t < samples[0].t - tolMs || t > samples[n - 1].t + tolMs) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best = samples[lo];
  if (lo > 0 && Math.abs(samples[lo - 1].t - t) < Math.abs(best.t - t)) best = samples[lo - 1];
  return Math.abs(best.t - t) <= tolMs ? best.cog : null;
}

// 高さ調整局面検出の中核。perBoat=[{id, samples, windAt(t)}] を受け取り、
// 各グリッド時刻で瞬時の風角差 |Δwind| を全艇分求めて条件を判定、
// minHoldSec 以上連続した区間 [lo,hi] を返す。wind は艇ごとに解決する(neon は艇別風軸)。
function detectHeightAdjustCore(perBoat, opts = {}) {
  const gridMs = opts.gridMs ?? 1000;
  const closeDeg = opts.closeDeg ?? 55;      // これ未満を「クローズ」とみなす
  const bearAwayDeg = opts.bearAwayDeg ?? 15; // クローズ艇よりこれ以上開いたら「下った」
  const runningDeg = opts.runningDeg ?? 100;  // これ以上はランニング扱いで対象外
  const minHoldSec = opts.minHoldSec ?? 3;
  const tolMs = opts.activeTolMs ?? 2000;
  const boats = perBoat.filter((b) => b.samples.length > 0);
  if (boats.length < 2) return [];

  let lo = Infinity, hi = -Infinity;
  for (const b of boats) { lo = Math.min(lo, b.samples[0].t); hi = Math.max(hi, b.samples.at(-1).t); }

  // 各グリッド時刻が条件を満たすか(flagged)を並べ、連続 true 区間を coalesce する。
  const flags = []; // {t, on}
  for (let t = lo; t <= hi; t += gridMs) {
    const active = [];
    for (const b of boats) {
      const cog = cogAt(b.samples, t, tolMs);
      if (cog == null) continue;
      const w = b.windAt(t);
      if (w == null) continue;
      active.push({ id: b.id, ang: Math.abs(circDiffDeg(cog, w)) });
    }
    let on = false;
    if (active.length >= 2) {
      const closers = active.filter((a) => a.ang < closeDeg);
      if (closers.length === 1) {
        const others = active.filter((a) => a.id !== closers[0].id);
        const bore = others.filter((a) => a.ang >= closers[0].ang + bearAwayDeg && a.ang < runningDeg);
        on = bore.length * 2 > others.length; // 他艇の過半数が下った
      }
    }
    flags.push({ t, on });
  }

  const out = [];
  let startT = null, endT = null;
  const flush = () => {
    if (startT != null && endT - startT >= minHoldSec * 1000) out.push({ lo: startT, hi: endT });
    startT = null; endT = null;
  };
  for (const f of flags) {
    if (f.on) { if (startT == null) startT = f.t; endT = f.t; }
    else flush();
  }
  flush();
  return out;
}

// 「1艇だけクローズを走り続け、他艇の過半数が下った(高さ調整の局面)」時間帯を検出する。
// 全艇が単一の風軸(windSeries)を共有するレグ系(analyzeFleetVmg)向け。
export function detectHeightAdjustWindows(tracks, windSeries, opts = {}) {
  if (!windSeries || windSeries.length === 0) return [];
  const perBoat = tracks.map((t) => ({
    id: t.id,
    samples: computeCog(t.points, opts.cogOpts ?? {}),
    windAt: (tt) => windFromAt(windSeries, tt),
  }));
  return detectHeightAdjustCore(perBoat, opts);
}

// 上記の艇別風軸版。neon 系(minuteWinners)は windSeriesByTrack で艇ごとに風軸を持つ。
export function detectHeightAdjustWindowsByTrack(tracks, windSeriesByTrack, opts = {}) {
  const perBoat = tracks.map((t) => {
    const ws = windSeriesByTrack.get(t) || [];
    return {
      id: t.id,
      samples: ws.length ? computeCog(t.points, opts.cogOpts ?? {}) : [],
      windAt: (tt) => windFromAt(ws, tt),
    };
  });
  return detectHeightAdjustCore(perBoat, opts);
}

// mid が除外区間 [lo,hi) のいずれかに入るか。
function inExcluded(mid, exclude) {
  return exclude.some((e) => e.lo <= mid && mid < e.hi);
}

// レグ群を「全境界の和集合」で区間分割し、各区間・各走種で最大VMG艇を勝者とする。
// 同一走種の参加艇が minBoats 未満の区間は勝者なし。隣接同一勝者帯は結合。
// exclude(高さ調整局面)に入る区間は勝者なしとしてスキップする。
export function winnerTimeline(perBoatLegVmg, opts = {}) {
  const minBoats = opts.minBoats ?? 2;
  const colors = opts.colors ?? {};
  const exclude = opts.exclude ?? [];
  const bounds = new Set();
  for (const l of perBoatLegVmg) { bounds.add(l.startT); bounds.add(l.endT); }
  for (const e of exclude) { bounds.add(e.lo); bounds.add(e.hi); }
  const times = [...bounds].sort((a, b) => a - b);

  const raw = []; // {boatId, pointOfSail, vmg, lo, hi}
  for (let i = 0; i + 1 < times.length; i++) {
    const lo = times[i], hi = times[i + 1];
    const mid = (lo + hi) / 2;
    if (inExcluded(mid, exclude)) continue;
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
// exclude(高さ調整局面)に入る時間は在時間から差し引く(集計対象外)。
export function rankVmg(perBoatLegVmg, { from, to, highlights = [], exclude = [] }) {
  const groups = new Map(); // key=`${boatId}|${pos}`
  for (const l of perBoatLegVmg) {
    const clipLo = Math.max(from, l.startT), clipHi = Math.min(to, l.endT);
    let ov = overlapMs(from, to, l.startT, l.endT);
    for (const e of exclude) ov -= overlapMs(clipLo, clipHi, e.lo, e.hi);
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

// VMGネオン勝者(minuteWinners の出力)を、走種(クローズ=upwind/ランニング=downwind)別に
// 各艇のネオン占有率へ集約する。占有率 = その艇の勝者時間 / その走種の勝者総時間(列合計=1)。
// rows は tracks の順で全艇を含む(勝者ゼロの艇も0%)。tracks に無いトラックの勝者は無視。
export function summarizeNeonShare(winners, tracks) {
  const ms = new Map(); // track -> { upwind, downwind }
  for (const t of tracks) ms.set(t, { upwind: 0, downwind: 0 });
  let upwindTotalMs = 0, downwindTotalMs = 0;
  for (const w of winners || []) {
    const rec = ms.get(w.track);
    if (!rec) continue; // 非表示(tracksに無い)艇は無視
    const dur = Math.max(0, w.hi - w.lo);
    if (w.pointOfSail === 'upwind') { rec.upwind += dur; upwindTotalMs += dur; }
    else if (w.pointOfSail === 'downwind') { rec.downwind += dur; downwindTotalMs += dur; }
  }
  const rows = tracks.map((t) => {
    const r = ms.get(t);
    return {
      track: t,
      upwind: upwindTotalMs ? r.upwind / upwindTotalMs : 0,
      downwind: downwindTotalMs ? r.downwind / downwindTotalMs : 0,
    };
  });
  return { rows, upwindTotalMs, downwindTotalMs };
}

// 複数艇＋風軸から、レグVMG・勝ちハイライト・ランキングを一括算出する統合エントリ。
export function analyzeFleetVmg(tracks, windSeries, opts = {}) {
  const colors = {};
  const perBoatLegVmg = [];
  for (const track of tracks) {
    colors[track.id] = track.color || '#888';
    perBoatLegVmg.push(...boatLegVmg(track, windSeries, opts));
  }
  const exclude = opts.excludeHeightAdjust === false ? [] : detectHeightAdjustWindows(tracks, windSeries, opts);
  const highlights = winnerTimeline(perBoatLegVmg, { minBoats: opts.minBoats ?? 2, colors, exclude });
  let from = opts.from, to = opts.to;
  if (from == null || to == null) {
    from = Math.min(...perBoatLegVmg.map((l) => l.startT), Infinity);
    to = Math.max(...perBoatLegVmg.map((l) => l.endT), -Infinity);
  }
  const ranks = perBoatLegVmg.length ? rankVmg(perBoatLegVmg, { from, to, highlights, exclude }) : [];
  return { perBoatLegVmg, highlights, ranks, exclude };
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
