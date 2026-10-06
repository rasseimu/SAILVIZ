// CSV(Sensor Logger 形式) を既存パーサで Track に変換するユーティリティ。依存追加なし。
import { parseCsv } from '../src/csv.js';
import { detectType } from '../src/detect.js';
import { parseGpsPoints, filterPointsWithExclusions } from '../src/gps.js';

const PALETTE = ['#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6'];
const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const two = (n) => String(n).padStart(2, '0');

export function jstMidnightMs(ms) {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

export function jstStamp(ms) {
  const d = new Date(ms + JST_OFFSET_MS); // getUTC* で JST 表現を読む
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
}

export function computeBounds(points) {
  if (!points.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

export function parseSensorCsv(csvText) {
  const { header, rows } = parseCsv(csvText);
  if (detectType(header) !== 'gps') throw new Error('not a gps csv');
  const raw = parseGpsPoints(header, rows);
  if (!raw.length) throw new Error('no gps points');
  // 外れ値で点を除いた時間帯は excludedIntervals に残す(分析で比較区間から差し引く)。精度フィルタは従来どおりかけない。
  const { points, excludedIntervals } = filterPointsWithExclusions(raw);
  if (!points.length) throw new Error('no gps points');
  const bounds = computeBounds(points);
  return { points, bounds, practiceDate: jstMidnightMs(points[0].t), excludedIntervals };
}

// excludedIntervals は配列を渡したときだけトラックに載せる(未指定なら項目なし=旧データと同じ扱い)。
export function buildTrack({ id, name, points, bounds, colorIndex = 0, source, excludedIntervals }) {
  const tRange = points.length > 0
    ? { start: points[0].t, end: points[points.length - 1].t }
    : null;
  const track = {
    id, name,
    color: PALETTE[colorIndex % PALETTE.length],
    visible: true,
    points,
    bounds,
    tRange,
    source,
  };
  if (Array.isArray(excludedIntervals)) track.excludedIntervals = excludedIntervals;
  return track;
}
