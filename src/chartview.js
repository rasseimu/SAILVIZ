// Chart.js をこのモジュールに隔離。艇×時系列を Chart.js の line チャートで描く。
// buildChartDatasets は純関数(テスト可能)。renderChart は canvas/DOM 依存(手動確認)。
import Chart from '../vendor/chart.esm.js';

// #rgb / #rrggbb を rgba(...) に。パース不能時は元色を返す(塗りは効かないが線は出る)。
function toRgba(hex, alpha) {
  if (typeof hex !== 'string') return hex;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// series: { boatNo: [{tMs,value}] } → Chart.js datasets。データ無し艇は除外。
// AI Studio 風: 線の下を淡くグラデ塗り(fill)。複数系列でも読めるよう低アルファ。
export function buildChartDatasets({ series, boats, colors }) {
  const out = [];
  for (const boat of boats) {
    const pts = series[boat] || [];
    if (pts.length === 0) continue;
    const color = colors[boat] || '#888';
    out.push({
      label: String(boat),
      data: pts.map((p) => ({ x: p.tMs, y: p.value })),
      borderColor: color,
      backgroundColor: toRgba(color, 0.12),
      fill: true,
    });
  }
  return out;
}

// canvas に line チャートを生成して Chart インスタンスを返す。
// x は linear(tMs)＝日付アダプタ依存を足さず、ticks を fmtX で MM-DD 整形。
// mini=true は凡例/ツールチップ/アニメ off・小さめ。拡大時は on。
export function renderChart(canvas, { datasets, from, to, mini = false, fmtX = null, yBeginAtZero = false, plugins = [] }) {
  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
    plugins,
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false, // data は既に {x,y}
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear', min: from, max: to,
          ticks: {
            maxTicksLimit: mini ? 3 : 6,
            font: { size: mini ? 8 : 11 },
            color: '#8a94a3',
            callback: (v) => (fmtX ? fmtX(v) : v),
          },
          border: { display: false },
          grid: { display: false },
        },
        y: {
          beginAtZero: yBeginAtZero,
          ticks: { maxTicksLimit: mini ? 4 : 6, font: { size: mini ? 8 : 11 }, color: '#8a94a3' },
          border: { display: false },
          grid: { display: !mini, color: 'rgba(16,30,54,0.06)' },
        },
      },
      plugins: {
        legend: { display: !mini, labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, font: { size: 11 } } },
        tooltip: {
          enabled: !mini,
          callbacks: { title: (items) => (fmtX && items[0] ? fmtX(items[0].parsed.x) : '') },
        },
      },
      elements: {
        point: { radius: 0, hoverRadius: mini ? 2 : 4 },
        line: { borderWidth: mini ? 1.5 : 2, tension: 0.35 },
      },
    },
  });
}
