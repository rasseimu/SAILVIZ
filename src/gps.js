import { parseTime } from './time.js';

function colIndex(header, name) {
  return header.findIndex((c) => c.toLowerCase() === name);
}

function numOrNull(cell) {
  if (cell === undefined || cell === '') return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

// 必須数値列用: 空文字/未定義/非数値は NaN（Number('')===0 の取りこぼしを防ぐ）
function reqNum(cell) {
  if (cell === undefined || String(cell).trim() === '') return NaN;
  return Number(cell);
}

// header/rows から Point[] を生成。必須列欠損・不正行はスキップ、t昇順ソート。
export function parseGpsPoints(header, rows) {
  const iTime = colIndex(header, 'time');
  const iLat = colIndex(header, 'latitude');
  const iLon = colIndex(header, 'longitude');
  const iSpeed = colIndex(header, 'speed');
  const iBearing = colIndex(header, 'bearing');
  const iAcc = colIndex(header, 'horizontalaccuracy');
  if (iTime < 0 || iLat < 0 || iLon < 0) return [];

  const points = [];
  for (const row of rows) {
    const t = parseTime(row[iTime]);
    const lat = reqNum(row[iLat]);
    const lon = reqNum(row[iLon]);
    if (Number.isNaN(t)) continue;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    points.push({
      t,
      lat,
      lon,
      speed: iSpeed >= 0 ? numOrNull(row[iSpeed]) : null,
      bearing: iBearing >= 0 ? numOrNull(row[iBearing]) : null,
      accuracy: iAcc >= 0 ? numOrNull(row[iAcc]) : null,
    });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

export const MAX_SPEED_MPS = 25;

// GPS 水平精度(horizontalAccuracy, m)の許容上限。読込時の精度フィルタと分析の信頼度判定で共通に使う。
export const ACCURACY_FILTER_M = 50;

const R_EARTH_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

// 2点間の大円距離（メートル）
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 直前の採用点との推定速度が閾値超、または dt<=0 の点を外れ値として除去。
// t昇順であることを前提とする。
export function rejectOutliers(points, maxSpeedMps = MAX_SPEED_MPS) {
  const kept = [];
  let removed = 0;
  for (const p of points) {
    const prev = kept[kept.length - 1];
    if (prev) {
      const dtSec = (p.t - prev.t) / 1000;
      if (dtSec <= 0) { removed++; continue; }
      const speed = haversineMeters(prev, p) / dtSec;
      if (speed > maxSpeedMps) { removed++; continue; }
    }
    kept.push(p);
  }
  return { points: kept, removed };
}

// 読込時の点除去(精度フィルタ → 外れ値除去)を行い、除去で失われた時間帯を除外区間として返す。
// 判定は既存 addTrack の精度フィルタ(accuracy == null || accuracy <= maxAccuracyM)と rejectOutliers と同じ。
// 除去した点ごとに「前の採用点〜次の採用点」の橋渡し区間を {lo, hi, code} として記録する
// (code: 精度で除去 = 'accuracy'、速度で除去 = 'speed')。先頭側は「除去点〜次の採用点」、末尾側は「前の採用点〜除去点」。
// 採用点だけを残すと除去点の前後が1本の区間としてつながるため、分析側(analysisconfidence.js)でこれを差し引く。
// 同じ code で重なる・接する区間は結合する(code が違う区間は重なってよい)。
// 前の採用点以下の時刻(dt <= 0)で除去した点は長さ0なので記録しない。
// 返り値: {points: 採用点, removed: 外れ値として除去した点数(rejectOutliers と同じ数え方。精度フィルタ分は含めない),
//          excludedIntervals: [{lo, hi, code}](lo 昇順)}
export function filterPointsWithExclusions(points, { accuracyFilter = false, maxAccuracyM = ACCURACY_FILTER_M, maxSpeedMps = MAX_SPEED_MPS } = {}) {
  const src = Array.isArray(points) ? points : [];
  // 各点の扱い: null = 採用、'accuracy' / 'speed' = 除去(区間を記録)、'dup' = dt <= 0 で除去(記録しない)
  const status = new Array(src.length).fill(null);
  if (accuracyFilter) {
    src.forEach((p, i) => { if (!(p.accuracy == null || p.accuracy <= maxAccuracyM)) status[i] = 'accuracy'; });
  }
  const kept = [];
  let removed = 0;
  for (let i = 0; i < src.length; i++) {
    if (status[i]) continue;
    const p = src[i];
    const prev = kept[kept.length - 1];
    if (prev) {
      const dtSec = (p.t - prev.t) / 1000;
      if (dtSec <= 0) { status[i] = 'dup'; removed++; continue; }
      if (haversineMeters(prev, p) / dtSec > maxSpeedMps) { status[i] = 'speed'; removed++; continue; }
    }
    kept.push(p);
  }

  // 除去点ごとの前後の採用点の時刻
  const nextKeptT = new Array(src.length).fill(null);
  for (let i = src.length - 1, nx = null; i >= 0; i--) {
    nextKeptT[i] = nx;
    if (status[i] === null) nx = src[i].t;
  }
  const raw = [];
  for (let i = 0, pv = null; i < src.length; i++) {
    const code = status[i];
    if (code === null) { pv = src[i].t; continue; }
    if (code === 'dup') continue;
    const lo = pv ?? src[i].t;
    const hi = nextKeptT[i] ?? src[i].t;
    if (hi > lo) raw.push({ lo, hi, code });
  }

  // 同じ code で重なる・接する区間を結合
  raw.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.lo - b.lo));
  const excludedIntervals = [];
  for (const e of raw) {
    const last = excludedIntervals[excludedIntervals.length - 1];
    if (last && last.code === e.code && e.lo <= last.hi) last.hi = Math.max(last.hi, e.hi);
    else excludedIntervals.push({ ...e });
  }
  excludedIntervals.sort((a, b) => a.lo - b.lo);
  return { points: kept, removed, excludedIntervals };
}

// CSV の header/rows から読込用の点列と除外区間を作る(parseGpsPoints → filterPointsWithExclusions)。
// 返り値は filterPointsWithExclusions と同じ。
export function prepareTrackPoints(header, rows, { accuracyFilter = false } = {}) {
  return filterPointsWithExclusions(parseGpsPoints(header, rows), { accuracyFilter });
}
