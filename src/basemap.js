// src/basemap.js
// 背景地図(地理院タイル・淡色)を軌跡の下敷きとして1枚に合成するための計算とスティッチ。
// タイルは Web メルカトル(標準XYZ)。狭い練習エリアでは正距円筒との差はごく小さいため、
// renderer 側は被覆boundsの矩形を一様スケールで貼る簡易合成とする。
//
// 純粋なタイル計算(lonLatToTile/tileToLonLat/pickZoom/tileRangeForBounds/planBasemap)は
// ブラウザ非依存でテスト可能。取得と描画(stitchBasemap)は fetchTile/createCanvas を注入する。

// GSI淡色地図の海の色(サンプリング失敗時のフォールバック)。
export const DEFAULT_SEA_COLOR = '#bfd3ff';

// RGBA画素配列から「海」らしい最頻色を選ぶ。海の背景は「明るい淡青」(全channel高め・僅かに青優勢)。
// 濃い水部の縁(彩度の高い青)や軌跡線を拾わないよう r/g も高い色に限定する。
// 候補が無ければ既定の海色を返す。stride で間引いて高速化。
export function pickSeaColor(data, { stride = 4 } = {}) {
  const hist = new Map();
  let best = null, bestN = 0;
  const step = 4 * Math.max(1, stride | 0);
  for (let i = 0; i + 3 < data.length; i += step) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    // 明るい淡青(海の背景)だが、海岸の中間色(白×海のアンチエイリアス)を除くため
    // 青の優勢度に下限を設ける。彩度の高い水部縁や軌跡線(r低)も除外。
    if (!(b >= 200 && r >= 150 && g >= 160 && b >= r + 30 && b >= g + 20)) continue;
    const key = (r << 16) | (g << 8) | b;
    const n = (hist.get(key) || 0) + 1;
    hist.set(key, n);
    if (n > bestN) { bestN = n; best = key; }
  }
  if (best == null) return DEFAULT_SEA_COLOR;
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex((best >> 16) & 255)}${hex((best >> 8) & 255)}${hex(best & 255)}`;
}

// 緯度経度 → タイル座標(整数, そのタイルに属す)。Web メルカトル標準式。
export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  const clamp = (v) => Math.min(n - 1, Math.max(0, v));
  return { x: clamp(x), y: clamp(y) };
}

// タイル(x,y)の北西隅の緯度経度。
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lat: (latRad * 180) / Math.PI, lon };
}

// bounds を覆うタイル範囲と、タイル境界に合わせた被覆bounds(入力を内包)。
export function tileRangeForBounds(bounds, z) {
  const nw = lonLatToTile(bounds.maxLat, bounds.minLon, z); // 左上(高緯度・小経度)
  const se = lonLatToTile(bounds.minLat, bounds.maxLon, z); // 右下(低緯度・大経度)
  const x0 = Math.min(nw.x, se.x), x1 = Math.max(nw.x, se.x);
  const y0 = Math.min(nw.y, se.y), y1 = Math.max(nw.y, se.y);
  const nwCorner = tileToLonLat(x0, y0, z);
  const seCorner = tileToLonLat(x1 + 1, y1 + 1, z);
  return {
    z, x0, x1, y0, y1,
    cols: x1 - x0 + 1,
    rows: y1 - y0 + 1,
    bounds: {
      minLat: seCorner.lat, maxLat: nwCorner.lat,
      minLon: nwCorner.lon, maxLon: seCorner.lon,
    },
  };
}

// bounds が両軸とも maxTiles 枚以内に収まる最大(最も詳細)のズームを選ぶ。
export function pickZoom(bounds, maxTiles = 4, { minZoom = 5, maxZoom = 18 } = {}) {
  for (let z = maxZoom; z >= minZoom; z -= 1) {
    const r = tileRangeForBounds(bounds, z);
    if (r.cols <= maxTiles && r.rows <= maxTiles) return z;
  }
  return minZoom;
}

// 合成計画: ズーム・タイル一覧(描画オフセット付き)・画像サイズ・被覆bounds。
export function planBasemap(bounds, { maxTiles = 4, tileSize = 256, minZoom = 5, maxZoom = 18 } = {}) {
  const z = pickZoom(bounds, maxTiles, { minZoom, maxZoom });
  const r = tileRangeForBounds(bounds, z);
  const tiles = [];
  for (let y = r.y0; y <= r.y1; y += 1) {
    for (let x = r.x0; x <= r.x1; x += 1) {
      tiles.push({ z, x, y, dx: (x - r.x0) * tileSize, dy: (y - r.y0) * tileSize });
    }
  }
  return {
    z, cols: r.cols, rows: r.rows, tileSize,
    width: r.cols * tileSize, height: r.rows * tileSize,
    bounds: r.bounds, tiles,
  };
}

// 計画に従いタイルを取得してオフスクリーンcanvasに合成し dataURL 化する。
// fetchTile(z,x,y) は描画可能画像 or null(欠損は飛ばす)を返す Promise。
// createCanvas(w,h) は 2Dコンテキストと toDataURL を持つcanvasを返す。
export async function stitchBasemap(plan, { fetchTile, createCanvas }) {
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  const imgs = await Promise.all(plan.tiles.map((t) =>
    Promise.resolve()
      .then(() => fetchTile(t.z, t.x, t.y))
      .catch(() => null)));
  imgs.forEach((img, i) => {
    if (!img) return; // 欠損タイル(海域など)は空白のまま
    const t = plan.tiles[i];
    ctx.drawImage(img, t.dx, t.dy);
  });
  // 合成画像から海の色を採取(キャンバス背景を海色に合わせるため)。getImageData非対応/汚染時は既定。
  let seaColor = DEFAULT_SEA_COLOR;
  try {
    if (typeof ctx.getImageData === 'function') {
      const { data } = ctx.getImageData(0, 0, plan.width, plan.height);
      seaColor = pickSeaColor(data);
    }
  } catch { /* 既定にフォールバック */ }
  return { image: canvas.toDataURL('image/png'), bounds: plan.bounds, z: plan.z, seaColor };
}
