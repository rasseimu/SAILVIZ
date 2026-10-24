// src/speedchart.js
// 速度の推移パネル(艇ごとの速度推移グラフ)用の純関数群。DOM / Chart.js 非依存(node:test で検証する)。
// 時刻はタイムライン軸(absolute=絶対 epoch ms / elapsed=各トラック自身の開始を0)に合わせる。map・風軸ストリップと同じ規約。
import { haversineMeters } from './gps.js';
import { cachedSailingSpan, outsideSpan } from './sailingspan.js';

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
// 練習の最初と最後を除いた帆走中の時間帯(sailingspan.js)。速度は座標±5秒(マスク前)で判定する。
export function sailingSpanOf(points) {
  return cachedSailingSpan(points, (p) => windowedSpeedsMps(p));
}

// 窓幅(halfWindowMs)ごとに別々にキャッシュする。
// 練習の最初と最後(出艇前・着艇後。sailingspan.js)の点は速度を null にする(測位直後の飛びなど。グラフに出さず、
// ラベル・最大速度・タックの減速にも使わない)。
const windowedCache = new Map(); // halfWindowMs → WeakMap<points, speeds>
export function cachedWindowedSpeedsMps(points, { halfWindowMs = 5000 } = {}) {
  let byPoints = windowedCache.get(halfWindowMs);
  if (!byPoints) { byPoints = new WeakMap(); windowedCache.set(halfWindowMs, byPoints); }
  let v = byPoints.get(points);
  if (!v) {
    const span = sailingSpanOf(points);
    v = windowedSpeedsMps(points, { halfWindowMs });
    if (span) v = v.map((s, i) => (outsideSpan(points[i].t, span) ? null : s));
    byPoints.set(points, v);
  }
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

// ===== 再生に追従する表示窓 =====
// グラフは再生時刻を中央に置いた幅 windowMs の窓を表示し、再生につれて右から左へ流れる。
// ズームは横軸(時間の幅)だけを変え、縦軸は練習全体の最大速度で固定する。
export const SPEED_WINDOW_DEFAULT_MS = 20000;
export const SPEED_WINDOW_MIN_MS = 5000;
const SPEED_ZOOM_FACTOR = 1.25;

// ズーム後の窓幅。dir > 0 でズームイン(狭く)、dir < 0 でズームアウト(広く)。[最小, maxMs] に収める。
export function zoomWindowMs(windowMs, dir, { minMs = SPEED_WINDOW_MIN_MS, maxMs = Infinity } = {}) {
  const next = dir > 0 ? windowMs / SPEED_ZOOM_FACTOR : dir < 0 ? windowMs * SPEED_ZOOM_FACTOR : windowMs;
  return Math.round(Math.max(minMs, Math.min(Math.max(minMs, maxMs), next)));
}

// 再生時刻 now を中央に置いた表示範囲。
export function followWindow(now, windowMs) {
  return { min: now - windowMs / 2, max: now + windowMs / 2 };
}

// 系列を作る範囲: 表示範囲の前後に窓1つ分ずつ余裕を持たせ(毎フレーム作り直さないため)、軸範囲 range に収める。
export function dataRangeFor(now, windowMs, range) {
  return { start: Math.max(range.start, now - windowMs * 1.5), end: Math.min(range.end, now + windowMs * 1.5) };
}

// 窓幅に応じた集計幅。窓に 150 区間ほど。最小 1 秒(記録間隔)。
export function bucketMsForWindow(windowMs) {
  return Math.max(1000, Math.round(windowMs / 150 / 1000) * 1000);
}

// 縦軸の上限(kt)。表示中の艇の、軸範囲内の座標±5秒の速度(練習の最初と最後を除く)の最大 + 2kt を切り上げ
// (余白を一定にして差を見やすく)。
// データが無ければ null。
export function speedYMaxKt(tracks, { range, mode }) {
  let max = 0;
  for (const tr of tracks || []) {
    if (!tr.visible || !Array.isArray(tr.points)) continue;
    const off = mode === 'elapsed' ? (tr.tRange?.start ?? 0) : 0;
    const v = cachedWindowedSpeedsMps(tr.points);
    tr.points.forEach((p, i) => {
      const x = p.t - off;
      if (v[i] != null && x >= range.start && x <= range.end && v[i] > max) max = v[i];
    });
  }
  return max > 0 ? Math.ceil(max * MPS_TO_KT + 2) : null;
}
