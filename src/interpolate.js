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
