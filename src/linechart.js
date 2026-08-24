// 多系列折れ線を SVG 文字列で描く純モジュール(外部依存なし)。

// [from,to] 内の点を画面座標へ。y は上が大きい値になるよう反転。
export function projectPoints(points, { from, to, minY, maxY, width, height, pad = 0 }) {
  const spanX = to - from || 1;
  const spanY = maxY - minY || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const out = [];
  for (const p of points || []) {
    if (p.tMs < from || p.tMs > to) continue;
    const x = pad + ((p.tMs - from) / spanX) * w;
    const y = pad + (1 - (p.value - minY) / spanY) * h;
    out.push({ x, y });
  }
  return out;
}

// series: { boatNo: [{tMs,value}] }。y範囲は全系列の値から自動算出。
export function buildLineChart({ series, boats, colors, from, to, width, height, pad = 2 }) {
  let minY = Infinity; let maxY = -Infinity;
  for (const boat of boats) {
    for (const p of series[boat] || []) {
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
  }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; } // 平坦系列でも線を出す

  let body = '';
  for (const boat of boats) {
    const pts = projectPoints(series[boat] || [], { from, to, minY, maxY, width, height, pad });
    if (pts.length === 0) continue;
    const coords = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const color = colors[boat] || '#888';
    if (pts.length === 1) {
      body += `<circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="2" fill="${color}" />`;
    } else {
      body += `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${coords}" />`;
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" `
    + `xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}
