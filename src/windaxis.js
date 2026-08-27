// src/windaxis.js
// GPS軌跡からの風軸(風向)推定。円周演算＋レグ分割＋タック/ジャイブ幾何＋帆走角学習。
// すべて純粋関数。DOM/副作用なし。

const DEG = Math.PI / 180;

export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

// a - b を (-180, 180] に正規化した符号付き差
export function circDiffDeg(a, b) {
  return ((a - b + 540) % 360) - 180;
}

export function circMeanDeg(degs) {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos(d * DEG); y += Math.sin(d * DEG); }
  return normalizeDeg(Math.atan2(y, x) / DEG);
}

// 円周中央値: 円周平均を基準に偏差の(線形)中央値を足し戻す（分散<180°で有効）
export function circMedianDeg(degs) {
  if (degs.length === 0) return 0;
  const ref = circMeanDeg(degs);
  const devs = degs.map((d) => circDiffDeg(d, ref)).sort((p, q) => p - q);
  const m = devs.length % 2
    ? devs[(devs.length - 1) / 2]
    : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
  return normalizeDeg(ref + m);
}

// 内側(短弧側)の二等分方位
export function bisectorDeg(a, b) {
  return normalizeDeg(a + circDiffDeg(b, a) / 2);
}

export function bearingDeg(from, to) {
  const φ1 = from.lat * DEG, φ2 = to.lat * DEG;
  const Δλ = (to.lon - from.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / DEG);
}
