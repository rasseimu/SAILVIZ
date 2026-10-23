// src/maneuverspeed.js
// タック/ジャイブ前後の速度変化(減速)の純関数群。DOM 非依存(node:test で検証する)。
// 速度は GPS 座標から求める(speedchart.js の cachedWindowedSpeedsMps)。ただし窓はグラフの±5秒ではなく±2秒:
// ±5秒(幅10秒)は切り出す前後3秒(幅6秒)より広く、3秒前の速度に減速が混ざって短い減速ほど小さく出る。
// 位置誤差を足した合成データ(scripts/tack-speed-measure.mjs)でも、±2秒の方が減速の大小の順位が真値に近い。
import { circDiffDeg, bearingDeg, windDirAt } from './windaxis.js';
import { classifyPointOfSail } from './vmg.js';
import { positionAt } from './interpolate.js';
import { MPS_TO_KT, cachedWindowedSpeedsMps } from './speedchart.js';

export const MANEUVER_HALF_WINDOW_MS = 3000; // マニューバ時刻の前後3秒を切り出す
export const MANEUVER_SPEED_HALF_WINDOW_MS = 2000; // 切り出しに使う速度の窓(座標±2秒)
export const MIN_TURN_ACROSS_DEG = 60; // 切り出し窓の前後で実際に向きが変わっていない検出は除外する

// 切り出し窓の外側の進路の変化(度)。前 = [t-gap-span, t-gap]、後 = [t+gap, t+gap+span] の各区間の
// 両端を結ぶ方位の差。位置誤差でレグの途中に出る見かけのマニューバ(向きが変わっていない)を落とすのに使う。
// 減速が無いぶん「最も減速しなかったタック」として上位に来てしまうため。求められなければ null。
export function turnAcrossDeg(points, tMs, { gapMs = MANEUVER_HALF_WINDOW_MS, spanMs = 5000 } = {}) {
  const at = (t) => positionAt(points, t);
  const b0 = at(tMs - gapMs - spanMs), b1 = at(tMs - gapMs), a0 = at(tMs + gapMs), a1 = at(tMs + gapMs + spanMs);
  if (!b0 || !b1 || !a0 || !a1) return null;
  return Math.abs(circDiffDeg(bearingDeg(a0, a1), bearingDeg(b0, b1)));
}

// タックかジャイブか。推定風軸に対し、旋回前後のレグが両方クローズ(風上)ならタック、両方ランニング(風下)ならジャイブ。
// 片方だけ(マーク回航のベアウェイ/ラフアップ)やリーチを含むものはどちらでもない(null)。
// windaxis.js の classifyManeuver は減速率で判別するため、「減速が小さいタック」がジャイブ扱いになりうる。
// 減速の大小で順位を付けるここでは使えないので、推定風軸があれば走種で判別し、無ければ既存の判別に従う。
export function maneuverKind(m, windFromDeg) {
  if (windFromDeg == null || !Number.isFinite(m.headingBefore) || !Number.isFinite(m.headingAfter)) {
    return m.type === 'tack' || m.type === 'gybe' ? m.type : null;
  }
  const before = classifyPointOfSail(m.headingBefore, windFromDeg);
  const after = classifyPointOfSail(m.headingAfter, windFromDeg);
  if (before === 'upwind' && after === 'upwind') return 'tack';
  if (before === 'downwind' && after === 'downwind') return 'gybe';
  return null;
}

// 時刻 tMs の前後 halfMs を切り出した速度変化(m/s)。speeds は points と同じ並びの点ごとの速度。
// entry = 窓の最初の点、exit = 窓の最後の点、min = 窓内の最低。drop = entry - min。
// 窓内に速度の求まる点が2点未満、または窓の端が tMs から離れすぎ(片側に点が無い)なら null。
export function speedAround(points, speeds, tMs, { halfMs = MANEUVER_HALF_WINDOW_MS } = {}) {
  let entry = null, exit = null, min = Infinity, count = 0, tFirst = null, tLast = null;
  for (let i = 0; i < points.length; i++) {
    const t = points[i].t;
    if (t < tMs - halfMs) continue;
    if (t > tMs + halfMs) break;
    const v = speeds[i];
    if (v == null) continue;
    if (entry == null) { entry = v; tFirst = t; }
    exit = v; tLast = t; count++;
    if (v < min) min = v;
  }
  if (count < 2 || tFirst > tMs || tLast < tMs) return null;
  return { entry, min, exit, drop: entry - min };
}

// 実際に向きを変えた時刻へ寄せる。detectManeuvers の tMs は前後レグの境目の中点で、位置誤差があると
// 数秒ずれ、前後3秒の窓が減速を外す。tMs ± searchMs の中で、直前 spanMs と直後 spanMs の進路(各区間の両端を
// 結ぶ方位)の差が最大になる時刻を旋回の中心とする。差が同じなら元の tMs に近い方。求められなければ null。
export function turnCenterMs(points, tMs, { searchMs = 10000, stepMs = 500, spanMs = 5000 } = {}) {
  let best = null;
  for (let dt = -searchMs; dt <= searchMs; dt += stepMs) {
    const c = tMs + dt;
    const deg = turnAcrossDeg(points, c, { gapMs: 0, spanMs });
    if (deg == null) continue;
    if (!best || deg > best.deg + 1e-9 || (Math.abs(deg - best.deg) <= 1e-9 && Math.abs(dt) < Math.abs(best.t - tMs))) {
      best = { t: c, deg };
    }
  }
  return best ? best.t : null;
}

// 1艇のマニューバを行(表示・順位付け用)にする。時刻と位置は旋回の中心(turnCenterMs)に寄せ、そこから前後3秒を切り出す。
// 速度は kt。
// 窓を切り出せない・前後で向きが変わっていないマニューバは除外。
export function maneuverSpeedRows(track, maneuvers, windSeries, opts = {}) {
  const speeds = cachedWindowedSpeedsMps(track.points, { halfWindowMs: opts.speedHalfWindowMs ?? MANEUVER_SPEED_HALF_WINDOW_MS });
  const rows = [];
  for (const m of maneuvers || []) {
    const kind = maneuverKind(m, windDirAt(windSeries, m.tMs));
    if (!kind) continue;
    const center = turnCenterMs(track.points, m.tMs) ?? m.tMs;
    const turn = turnAcrossDeg(track.points, center);
    if (turn == null || turn < (opts.minTurnAcrossDeg ?? MIN_TURN_ACROSS_DEG)) continue;
    const tMs = center;
    const s = speedAround(track.points, speeds, tMs, opts);
    if (!s) continue;
    const pos = positionAt(track.points, tMs) || m;
    rows.push({
      track, tMs, lat: pos.lat, lon: pos.lon, kind,
      entryKt: s.entry * MPS_TO_KT, minKt: s.min * MPS_TO_KT, exitKt: s.exit * MPS_TO_KT,
      dropKt: s.drop * MPS_TO_KT,
    });
  }
  return rows;
}

// 減速が最も小さいタック上位 n 件(全艇まとめて)。同じ減速なら入りの速度が速い方を上に。
export function topTacks(rows, n = 3) {
  return rows
    .filter((r) => r.kind === 'tack')
    .sort((a, b) => a.dropKt - b.dropKt || b.entryKt - a.entryKt)
    .slice(0, n);
}
