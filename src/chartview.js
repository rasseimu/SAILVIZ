// Chart.js をこのモジュールに隔離。艇×時系列を Chart.js の line チャートで描く。
// buildChartDatasets は純関数(テスト可能)。renderChart は canvas/DOM 依存(手動確認)。
import Chart from '../vendor/chart.esm.js';

// series: { boatNo: [{tMs,value}] } → Chart.js datasets。データ無し艇は除外。
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
      backgroundColor: color,
    });
  }
  return out;
}

// canvas に line チャートを生成して Chart インスタンスを返す。
// x は linear(tMs)＝日付アダプタ依存を足さず、ticks を fmtX で MM-DD 整形。
// mini=true は凡例/ツールチップ/アニメ off・小さめ。拡大時は on。
export function renderChart(canvas, { datasets, from, to, mini = false, fmtX = null }) {
  return new Chart(canvas, {
    type: 'line',
    data: { datasets },
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
            callback: (v) => (fmtX ? fmtX(v) : v),
          },
          grid: { display: !mini },
        },
        y: {
          ticks: { maxTicksLimit: mini ? 4 : 6, font: { size: mini ? 8 : 11 } },
          grid: { display: !mini },
        },
      },
      plugins: {
        legend: { display: !mini, labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          enabled: !mini,
          callbacks: { title: (items) => (fmtX && items[0] ? fmtX(items[0].parsed.x) : '') },
        },
      },
      elements: {
        point: { radius: mini ? 1.5 : 3, hoverRadius: mini ? 1.5 : 5 },
        line: { borderWidth: mini ? 1.5 : 2, tension: 0 },
      },
    },
  });
}
