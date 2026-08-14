// 可視トラック全点の外接矩形。点が無ければ null。
export function computeBounds(tracks) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let any = false;
  for (const tr of tracks) {
    if (!tr.visible) continue;
    for (const p of tr.points) {
      any = true;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  return any ? { minLat, maxLat, minLon, maxLon } : null;
}

// 正距円筒: 基準は外接矩形の中心。kx=cos(lat0) で経度方向を圧縮しアスペクト補正。
export function makeProjection(bounds) {
  const lat0 = (bounds.minLat + bounds.maxLat) / 2;
  const lon0 = (bounds.minLon + bounds.maxLon) / 2;
  return { lat0, lon0, kx: Math.cos((lat0 * Math.PI) / 180) };
}

// ローカル平面(度スケール)。x=東正, y=北正。
export function project(lat, lon, proj) {
  return { x: (lon - proj.lon0) * proj.kx, y: lat - proj.lat0 };
}

// 外接矩形を w×h にアスペクト維持でフィットする Transform を返す。
// (cx,cy) は world 中心 = (0,0)。scale = px / world単位。
export function fitTransform(bounds, w, h, marginFrac = 0.05) {
  const proj = makeProjection(bounds);
  const c1 = project(bounds.minLat, bounds.minLon, proj);
  const c2 = project(bounds.maxLat, bounds.maxLon, proj);
  const worldW = Math.max(Math.abs(c2.x - c1.x), 1e-9);
  const worldH = Math.max(Math.abs(c2.y - c1.y), 1e-9);
  const usableW = w * (1 - 2 * marginFrac);
  const usableH = h * (1 - 2 * marginFrac);
  const scale = Math.min(usableW / worldW, usableH / worldH);
  return { scale, cx: 0, cy: 0, w, h, proj };
}
