// src/windaxis.js
// GPS軌跡からの風軸(風向)推定。円周演算＋レグ分割＋タック/ジャイブ幾何＋帆走角学習。
// すべて純粋関数。DOM/副作用なし。

const DEG = Math.PI / 180;

// 角度を [0, 360) に正規化
export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

// a - b を (-180, 180] に正規化した符号付き差
export function circDiffDeg(a, b) {
  const d = ((a - b + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

export function circMeanDeg(degs) {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos(d * DEG); y += Math.sin(d * DEG); }
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

// 円周中央値(medoid): 観測値のうち，他のすべての観測値への円周偏差の絶対値の和を最小化する値
export function circMedianDeg(degs) {
  if (degs.length === 0) return 0;
  let best = degs[0], bestCost = Infinity;
  for (let i = 0; i < degs.length; i++) {
    const c = degs[i];
    let cost = 0;
    for (const d of degs) cost += Math.abs(circDiffDeg(d, c));
    if (cost < bestCost || (cost === bestCost && c > best)) {
      bestCost = cost; best = c;
    }
  }
  return normalizeDeg(best);
}

// 内側(短弧側)の二等分方位
export function bisectorDeg(a, b) {
  return normalizeDeg(a + circDiffDeg(b, a) / 2);
}

// 初期方位: ふたつの緯度経度間の大円路の方向角（度、北=0）
export function bearingDeg(from, to) {
  const φ1 = from.lat * DEG, φ2 = to.lat * DEG;
  const Δλ = (to.lon - from.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}
