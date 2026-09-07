import { haversineMeters } from './gps.js';

// points[hi].t >= t となる最小 hi を返す二分探索(t は範囲内前提)。
function upperIndex(points, t) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return hi;
}

// t昇順の points から時刻 t の位置を線形補間。範囲外は null。
export function positionAt(points, t) {
  const n = points.length;
  if (n === 0) return null;
  if (t < points[0].t || t > points[n - 1].t) return null;
  // 二分探索: points[hi].t >= t となる最小 hi
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (hi === 0) return { lat: points[0].lat, lon: points[0].lon };
  const a = points[hi - 1];
  const b = points[hi];
  const span = b.t - a.t;
  const f = span === 0 ? 0 : (t - a.t) / span;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

// 絶対時刻 t を含む可視トラックの位置を返す。動画/イベントバッジを、単一の基準トラックだけ
// でなく「その時刻を実際に含むトラック」に置くため(午前・午後を別トラックで読み込むと、
// 基準トラック範囲外の時刻がバッジ非表示になる問題への対処)。基準トラックを優先し、
// 含まなければ他の可視トラックを順に探す。どれも含まなければ null。
export function positionOnTracksAt(tracks, referenceTrack, t) {
  if (referenceTrack) {
    const p = positionAt(referenceTrack.points, t);
    if (p) return p;
  }
  for (const tr of tracks || []) {
    if (tr === referenceTrack || tr.visible === false || !tr.points) continue;
    const p = positionAt(tr.points, t);
    if (p) return p;
  }
  return null;
}

// 時刻 t の移動速度(m/s)。記録済み speed 列を線形補間し、null 区間は
// 隣接点の haversine/dt で推定。範囲外・点なしは null。
export function speedAt(points, t) {
  const n = points.length;
  if (n === 0 || t < points[0].t || t > points[n - 1].t) return null;
  const hi = upperIndex(points, t);
  if (hi === 0) return points[0].speed ?? 0;
  const a = points[hi - 1], b = points[hi];
  if (a.speed != null && b.speed != null) {
    const span = b.t - a.t;
    const f = span === 0 ? 0 : (t - a.t) / span;
    return a.speed + (b.speed - a.speed) * f;
  }
  const dtSec = (b.t - a.t) / 1000;
  if (dtSec > 0) return haversineMeters(a, b) / dtSec;
  return a.speed ?? b.speed ?? null;
}
