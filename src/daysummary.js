// src/daysummary.js
// GPS軌跡から「今日の練習サマリ」を作る純関数群。DOM/副作用なし。
// 推定値や算出不能になりうる項目は Est 型 { ok:true, value } | { ok:false, reason } で持ち、
// 算出不能を 0 で埋めない(表示側 daysummaryview.js が reason を文言に変える)。
import { haversineMeters } from './gps.js';
import { speedAt } from './interpolate.js';

const MOVING_MIN_MPS = 1.5;      // 走行中とみなす速度。computeCog の既定 minSpeedMps と同じ
const MAX_SPEED_WINDOW = 5;      // 最高速度の移動平均窓(1秒グリッドの点数=秒)
const GAP_MS = 10_000;           // これを超える記録の空白を欠損とみなす

export const ok = (value) => ({ ok: true, value });
export const fail = (reason) => ({ ok: false, reason });

// 点列の軽量ハッシュ(FNV-1a 風に 32bit 整数を混ぜる)。サマリ計算が使う列だけを使う:
// 時刻・緯度経度(1e-7度≈1cm)・速度(平均/最高速度に使う)・精度(GPS品質に使う)。方位はサマリに使わないので含めない。
// 点数・開始・終了が同じで中身だけ違う GPS を別物と判定するため。
// 保存 JSON は数値をそのまま往復させるので、読み直しても同じ値になる(Task 5 でテスト)。
function pointsHash(points) {
  let h = 0x811c9dc5;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  // 速度・精度は欠けうる(null)。有限値なら印 1 と値(1e-3 単位)、それ以外は印 0 だけを混ぜ、null と 0 を区別する。
  const mixOptional = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) { mix(1); mix(Math.round(v * 1000)); }
    else mix(0);
  };
  for (const p of points || []) {
    mix(p.t);                          // 下位32bit
    mix(Math.floor(p.t / 4294967296)); // 上位
    mix(Math.round(p.lat * 1e7));
    mix(Math.round(p.lon * 1e7));
    mixOptional(p.speed);
    mixOptional(p.accuracy);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// サマリをどの GPS から計算したかの指紋。GPS が増減・差し替えされるとキーが変わる。
// 艇名・色は含めない(変更は syncDaySummaryLabels でサマリに反映する)。
export function daySummarySourceKey(tracks) {
  return (tracks || [])
    .map((t) => `${t.id}|${t.points?.length ?? 0}|${t.tRange?.start}|${t.tRange?.end}|${pointsHash(t.points)}`)
    .join(';');
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// 1艇のGPS品質。記録間隔の中央値・欠損率・精度の中央値(精度列がある場合のみ)で3段階に判定する。
export function gpsQuality(points) {
  const n = points.length;
  const durationMs = n ? points[n - 1].t - points[0].t : 0;
  const dts = [];
  let gapMs = 0;
  for (let i = 1; i < n; i++) {
    const dt = points[i].t - points[i - 1].t;
    dts.push(dt);
    if (dt > GAP_MS) gapMs += dt;
  }
  const intervalS = dts.length ? median(dts) / 1000 : null;
  const gapRatio = durationMs > 0 ? gapMs / durationMs : 1;
  const accs = points.map((p) => p.accuracy).filter((a) => typeof a === 'number' && Number.isFinite(a));
  const accuracyM = accs.length ? median(accs) : null;

  let level;
  if (intervalS == null || intervalS > 5 || gapRatio >= 0.2 || (accuracyM != null && accuracyM > 25)) {
    level = 'poor';
  } else if (intervalS <= 2 && gapRatio < 0.05 && (accuracyM == null || accuracyM <= 10)) {
    level = 'good';
  } else {
    level = 'caution';
  }
  const parts = [`欠損${Math.round(gapRatio * 100)}%`];
  if (intervalS != null) parts.push(`記録間隔${Number(intervalS.toFixed(1))}秒`);
  if (accuracyM != null) parts.push(`精度${Math.round(accuracyM)}m`);
  return { level, note: parts.join('・') };
}

// 1艇の走行距離・記録時間・平均速度(走行中のみ)・最高速度(5秒移動平均の最大)。
export function boatStats(points) {
  const n = points.length;
  let distanceM = 0;
  for (let i = 1; i < n; i++) distanceM += haversineMeters(points[i - 1], points[i]);
  const durationMs = n ? points[n - 1].t - points[0].t : 0;
  if (n < 2) {
    return { distanceM, durationMs, avgSpeedMps: fail('gps-poor'), maxSpeedMps: fail('gps-poor') };
  }

  // 1秒グリッドで速度を取る(記録間隔が不揃いでも時間で重み付けされる)。
  const speeds = [];
  for (let t = points[0].t; t <= points[n - 1].t; t += 1000) {
    const s = speedAt(points, t);
    speeds.push(s != null && Number.isFinite(s) ? s : null);
  }
  const moving = speeds.filter((s) => s != null && s >= MOVING_MIN_MPS);
  if (moving.length === 0) {
    return { distanceM, durationMs, avgSpeedMps: fail('not-moving'), maxSpeedMps: fail('not-moving') };
  }
  const avg = moving.reduce((a, b) => a + b, 0) / moving.length;

  let max = null;
  for (let i = 0; i + MAX_SPEED_WINDOW <= speeds.length; i++) {
    const w = speeds.slice(i, i + MAX_SPEED_WINDOW);
    if (w.some((v) => v == null)) continue;
    const m = w.reduce((a, b) => a + b, 0) / MAX_SPEED_WINDOW;
    if (max == null || m > max) max = m;
  }
  if (max == null) max = Math.max(...moving); // 5秒に満たない短いトラック

  return { distanceM, durationMs, avgSpeedMps: ok(avg), maxSpeedMps: ok(max) };
}
