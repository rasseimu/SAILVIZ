// チューニング数値まとめ表(行=練習日×艇)を HTML 文字列で生成する純モジュール。
// 期間 [from,to] でフィルタし、各パラメータ列に値を並べる。DOM/ブラウザAPI非依存。

// HTML エスケープ(ラベル/日付に < > & が来ても壊さない)。
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

// 数値セル: null/非数値は — 、それ以外はそのまま(整数/小数)。
function cell(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return esc(v);
}

// rows: [{tMs, boat, rig}] (collectTuningRows 出力)。params: 列にする rig キー配列。
// labels: {param: 日本語}。colors: {boat: 色}。fmtDate: (ms)=>表示文字列。
export function buildTuningTable({ rows, params, labels, colors, from, to, fmtDate }) {
  const inRange = (rows || []).filter((r) => r.tMs >= from && r.tMs <= to);
  const head = `<tr><th>日付</th><th>艇</th>${
    params.map((p) => `<th>${esc(labels[p] || p)}</th>`).join('')
  }</tr>`;
  const body = inRange.map((r) => {
    const color = colors[r.boat] || '#888';
    const cells = params.map((p) => `<td>${cell(r.rig?.[p])}</td>`).join('');
    return `<tr><td>${esc(fmtDate(r.tMs))}</td>`
      + `<td><span class="tt-boat" style="color:${color}">${esc(r.boat)}</span></td>${cells}</tr>`;
  }).join('');
  return `<table class="tuning-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
