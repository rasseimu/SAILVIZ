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
