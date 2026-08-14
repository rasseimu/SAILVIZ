import { parseTime } from './time.js';

function idx(header, ...names) {
  for (const name of names) {
    const i = header.findIndex((c) => c.toLowerCase() === name);
    if (i >= 0) return i;
  }
  return -1;
}

function numOrNull(cell) {
  if (cell === undefined || cell === '') return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

// header/rows から Event[] を生成。start&end=range, それ以外=point。
export function parseTags(header, rows) {
  const iStart = idx(header, 'start');
  const iEnd = idx(header, 'end');
  const iTime = idx(header, 'time');
  const iLabel = idx(header, 'label', 'name', 'text');
  const iLat = idx(header, 'lat', 'latitude');
  const iLon = idx(header, 'lon', 'longitude');
  const isRange = iStart >= 0 && iEnd >= 0;
  const iPrimary = isRange ? iStart : (iTime >= 0 ? iTime : iStart);
  if (iPrimary < 0) return [];

  const events = [];
  for (const row of rows) {
    const t = parseTime(row[iPrimary]);
    if (Number.isNaN(t)) continue;
    const tEnd = isRange ? parseTime(row[iEnd]) : null;
    events.push({
      kind: isRange ? 'range' : 'point',
      t,
      tEnd: isRange && !Number.isNaN(tEnd) ? tEnd : null,
      label: iLabel >= 0 ? (row[iLabel] ?? '') : '',
      lat: iLat >= 0 ? numOrNull(row[iLat]) : null,
      lon: iLon >= 0 ? numOrNull(row[iLon]) : null,
    });
  }
  return events;
}
