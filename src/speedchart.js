// src/speedchart.js
// 速度の推移パネル(艇ごとの速度推移グラフ)用の純関数群。DOM / Chart.js 非依存(node:test で検証する)。
// 時刻はタイムライン軸(absolute=絶対 epoch ms / elapsed=各トラック自身の開始を0)に合わせる。map・風軸ストリップと同じ規約。
import { haversineMeters } from './gps.js';

export const MPS_TO_KT = 1.943844;

// 座標から求めた点ごとの速度(m/s)。前後 halfWindowMs の範囲の両端点を結ぶ直線距離 ÷ 時間。
// 1点差分(隣接点の距離/dt)は位置誤差 数m がそのまま数 m/s の揺れになるため、窓で均す。
// 経路長の合計ではなく両端の直線距離を使う(位置のジグザグ誤差で速度が過大にならない)。求められなければ null。
// 窓の両端は points 自体の点(補間しない)。points は t 昇順。
export function windowedSpeedsMps(points, { halfWindowMs = 5000 } = {}) {
  const n = points.length;
  const out = new Array(n).fill(null);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    const t = points[i].t;
    while (points[lo].t < t - halfWindowMs) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && points[hi + 1].t <= t + halfWindowMs) hi++;
    // 記録間隔が窓より粗く窓内に自分しかいないときは、隣接点で求める
    const a = lo === hi ? Math.max(0, i - 1) : lo;
    const b = lo === hi ? Math.min(n - 1, i + 1) : hi;
    const dtSec = (points[b].t - points[a].t) / 1000;
    if (dtSec > 0) out[i] = haversineMeters(points[a], points[b]) / dtSec;
  }
  return out;
}

// 座標の1点差分による点ごとの速度(m/s)。直前の点との距離 / 時間。先頭・dt<=0 は null。
// 位置誤差の影響をそのまま受けるため、比較スクリプト(scripts/speed-compare.mjs)用。
export function diffSpeedsMps(points) {
  return points.map((p, i) => {
    const q = points[i - 1];
    const dtSec = q ? (p.t - q.t) / 1000 : 0;
    return dtSec > 0 ? haversineMeters(q, p) / dtSec : null;
  });
}

// 速度の推移・地図の速度ラベル・タックの減速はすべて座標±5秒(windowedSpeedsMps)に統一する。
// 記録 speed は端末によって GPS の移動量と合わないことがあるため使わない。
// points 配列ごとに結果をキャッシュする(トラックの点列は差し替えで更新され、中身は変更されない)。
// 窓幅(halfWindowMs)ごとに別々にキャッシュする。
const windowedCache = new Map(); // halfWindowMs → WeakMap<points, speeds>
export function cachedWindowedSpeedsMps(points, { halfWindowMs = 5000 } = {}) {
  let byPoints = windowedCache.get(halfWindowMs);
  if (!byPoints) { byPoints = new WeakMap(); windowedCache.set(halfWindowMs, byPoints); }
  let v = byPoints.get(points);
  if (!v) { v = windowedSpeedsMps(points, { halfWindowMs }); byPoints.set(points, v); }
  return v;
}

// 時刻 t の座標±5秒の速度(m/s)。前後の点の値を線形補間。範囲外・点なしは null。
export function windowedSpeedAt(points, t) {
  const n = points.length;
  if (!n || t < points[0].t || t > points[n - 1].t) return null;
  const v = cachedWindowedSpeedsMps(points);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = v[lo], b = v[hi];
  if (a == null || b == null) return a ?? b;
  const span = points[hi].t - points[lo].t;
  return span > 0 ? a + (b - a) * ((t - points[lo].t) / span) : a;
}

// 軸範囲の長さから集計幅(ms)を決める。点数を maxPoints 以下に抑え、最小 minBucketMs。
export function bucketMsFor(range, { maxPoints = 300, minBucketMs = 2000 } = {}) {
  const span = Math.max(0, (range?.end ?? 0) - (range?.start ?? 0));
  return Math.max(minBucketMs, Math.ceil(span / maxPoints / 1000) * 1000);
}

// トラック1本の速度系列(kt)。軸範囲 range を bucketMs ごとに区切り、区間内の点速度を平均する。
// 点の無い区間は y=null(線を途切れさせ、欠測を 0kt に見せない)。offset は軸時刻 = 絶対時刻 - offset。
export function speedSeries(points, { range, bucketMs, offset = 0 }) {
  if (!Array.isArray(points) || !points.length || !(bucketMs > 0) || !(range.end > range.start)) return [];
  const speeds = cachedWindowedSpeedsMps(points);
  const n = Math.ceil((range.end - range.start) / bucketMs);
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (let i = 0; i < points.length; i++) {
    const v = speeds[i];
    if (v == null) continue;
    const x = points[i].t - offset;
    if (x < range.start || x > range.end) continue;
    const k = Math.min(n - 1, Math.floor((x - range.start) / bucketMs));
    sum[k] += v; cnt[k]++;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ x: range.start + (k + 0.5) * bucketMs, y: cnt[k] ? (sum[k] / cnt[k]) * MPS_TO_KT : null });
  }
  return out;
}

// 可視トラックの Chart.js datasets。色はマップと同じトラック色。データの無い艇は除外。
export function speedChartDatasets(tracks, { range, mode, bucketMs = bucketMsFor(range) }) {
  const out = [];
  for (const tr of tracks) {
    if (!tr.visible) continue;
    const offset = mode === 'elapsed' ? (tr.tRange?.start ?? 0) : 0;
    const data = speedSeries(tr.points, { range, bucketMs, offset });
    if (!data.some((p) => p.y != null)) continue;
    out.push({
      label: String(tr.name || tr.id || ''),
      data,
      borderColor: tr.color || '#888',
      backgroundColor: tr.color || '#888',
      fill: false,
      spanGaps: false,
    });
  }
  return out;
}
