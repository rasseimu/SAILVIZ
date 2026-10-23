// src/speedchart.js
// VMG 凡例内の「艇ごとの速度推移」グラフ用の純関数群。DOM / Chart.js 非依存(node:test で検証する)。
// 時刻はタイムライン軸(absolute=絶対 epoch ms / elapsed=各トラック自身の開始を0)に合わせる。map・風軸ストリップと同じ規約。
import { haversineMeters } from './gps.js';

export const MPS_TO_KT = 1.943844;

// 点ごとの速度(m/s)。記録済み speed が有効(有限・0以上)ならそれを使い、
// 無効(null・負値など)なら直前の点からの haversine/dt で求める。求められなければ null。
export function pointSpeedsMps(points) {
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (Number.isFinite(p.speed) && p.speed >= 0) { out[i] = p.speed; continue; }
    const q = points[i - 1];
    if (!q) continue;
    const dtSec = (p.t - q.t) / 1000;
    if (dtSec > 0) out[i] = haversineMeters(q, p) / dtSec;
  }
  return out;
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
  const speeds = pointSpeedsMps(points);
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
