// src/maneuverspeed.js
// タック/ジャイブ前後の速度変化(減速)の純関数群。DOM 非依存(node:test で検証する)。
// マニューバの検出(時刻・位置・種別)は maneuverdetect.js。ここはその時刻の前後3秒を切り出して順位を付ける。
// 速度は GPS 座標から求める(speedchart.js の cachedWindowedSpeedsMps)。ただし窓はグラフの±5秒ではなく±2秒:
// ±5秒(幅10秒)は切り出す前後3秒(幅6秒)より広く、3秒前の速度に減速が混ざって短い減速ほど小さく出る。
// 位置誤差を足した合成データ(scripts/tack-speed-measure.mjs)でも、±2秒の方が減速の大小の順位が真値に近い。
import { MPS_TO_KT, cachedWindowedSpeedsMps } from './speedchart.js';

export const MANEUVER_HALF_WINDOW_MS = 3000; // マニューバ時刻の前後3秒を切り出す
export const MANEUVER_SPEED_HALF_WINDOW_MS = 2000; // 切り出しに使う速度の窓(座標±2秒)
export const MIN_TACK_DROP_KT = 0.1; // タックで減速がこれ未満(表示上ほぼ 0)は起こりえないので誤検出とみなす

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

// 1艇のマニューバ(maneuverdetect.js の {tMs, lat, lon, kind})を行(表示・順位付け用)にする。速度は kt。
// 前後3秒を切り出せないマニューバは除外。
export function maneuverSpeedRows(track, events, opts = {}) {
  const speeds = cachedWindowedSpeedsMps(track.points, { halfWindowMs: opts.speedHalfWindowMs ?? MANEUVER_SPEED_HALF_WINDOW_MS });
  const rows = [];
  for (const e of events || []) {
    const s = speedAround(track.points, speeds, e.tMs, opts);
    if (!s) continue;
    rows.push({
      track, tMs: e.tMs, lat: e.lat, lon: e.lon, kind: e.kind,
      entryKt: s.entry * MPS_TO_KT, minKt: s.min * MPS_TO_KT, exitKt: s.exit * MPS_TO_KT,
      dropKt: s.drop * MPS_TO_KT,
    });
  }
  return rows;
}

// 誤検出とみなす行を除く。タックは風位を通るので必ず減速する。減速が MIN_TACK_DROP_KT 未満のタックは、
// 直進中の見かけの検出か、時刻のずれで減速を切り出せていないもの。ジャイブは減速がほぼ無いこともあるので対象外。
export function dropImplausibleManeuvers(rows, { minTackDropKt = MIN_TACK_DROP_KT } = {}) {
  return (rows || []).filter((r) => r.kind !== 'tack' || r.dropKt >= minTackDropKt);
}

// 減速が最も小さいマニューバ上位 n 件(kind = 'tack' | 'gybe'、全艇まとめて)。同じ減速なら入りの速度が速い方を上に。
export function topByKind(rows, kind, n = 3) {
  return rows
    .filter((r) => r.kind === kind)
    .sort((a, b) => a.dropKt - b.dropKt || b.entryKt - a.entryKt)
    .slice(0, n);
}

// 速度の推移グラフの横軸に打つタック/ジャイブの印。rows は maneuverSpeedRows の行(top3 は rank 付き)。
// 表示中の艇の行だけを軸時刻 x(elapsed は各艇自身の開始を0)にし、表示範囲 [min, max] のものを返す。
// lane は表示中の艇の並び順(艇ごとに段を分けて重ならないようにする)。
export function maneuverAxisMarks(rows, visibleTracks, { mode, min, max }) {
  const out = [];
  for (const r of rows || []) {
    const lane = visibleTracks.indexOf(r.track);
    if (lane < 0) continue;
    const x = mode === 'elapsed' ? r.tMs - (r.track.tRange?.start ?? 0) : r.tMs;
    if (x < min || x > max) continue;
    out.push({ x, kind: r.kind, rank: r.rank ?? null, color: r.track.color || '#888', lane });
  }
  return out;
}
