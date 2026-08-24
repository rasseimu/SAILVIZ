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

// 軸ラベル用の数値整形: 整数はそのまま、小数は1桁に丸める。
export function fmtAxisNum(n) {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

// series: { boatNo: [{tMs,value}] }。y範囲は全系列の値から自動算出。
// axis を渡すと左(Y最大/最小)・下(X端の日付)に数値ラベルと基準線を描く。
// axis: { xFrom, xTo, yFmt? }。省略時は従来通り軸なし(後方互換)。
export function buildLineChart({ series, boats, colors, from, to, width, height, pad = 2, axis = null }) {
  let minY = Infinity; let maxY = -Infinity;
  for (const boat of boats) {
    for (const p of series[boat] || []) {
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
  }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; } // 平坦系列でも線を出す

  // 軸ありなら左・下にラベル用マージンを取り、プロット領域を内側に寄せる。
  const m = axis
    ? { left: 34, right: 4, top: 6, bottom: 14 }
    : { left: 0, right: 0, top: 0, bottom: 0 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  let body = '';
  for (const boat of boats) {
    const raw = projectPoints(series[boat] || [], { from, to, minY, maxY, width: plotW, height: plotH, pad });
    if (raw.length === 0) continue;
    const pts = raw.map((p) => ({ x: p.x + m.left, y: p.y + m.top })); // マージン分オフセット
    const coords = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const color = colors[boat] || '#888';
    if (pts.length === 1) {
      body += `<circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="2" fill="${color}" />`;
    } else {
      body += `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${coords}" />`;
    }
  }

  if (axis) {
    const fmt = axis.yFmt || fmtAxisNum;
    const axLeft = m.left; const axBottom = m.top + plotH;
    // Y軸・X軸の基準線
    body += `<line x1="${axLeft}" y1="${m.top}" x2="${axLeft}" y2="${axBottom}" stroke="#ddd" stroke-width="1" />`;
    body += `<line x1="${axLeft}" y1="${axBottom}" x2="${axLeft + plotW}" y2="${axBottom}" stroke="#ddd" stroke-width="1" />`;
    // Y最大(上)・最小(下)
    body += `<text x="2" y="${m.top + 8}" font-size="9" fill="#666">${fmt(maxY)}</text>`;
    body += `<text x="2" y="${axBottom}" font-size="9" fill="#666">${fmt(minY)}</text>`;
    // X端の日付ラベル
    if (axis.xFrom != null) body += `<text x="${axLeft}" y="${height - 3}" font-size="9" fill="#666">${axis.xFrom}</text>`;
    if (axis.xTo != null) body += `<text x="${width}" y="${height - 3}" font-size="9" fill="#666" text-anchor="end">${axis.xTo}</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" `
    + `xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}
