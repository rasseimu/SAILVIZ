// src/windaxisview.js
// 風軸推定系列を Chart.js の line データセットへ整形する純粋関数。

export function buildWindAxisDatasets({ series, amedas = [] }) {
  const datasets = [{
    label: '推定風向',
    data: series.map((p) => ({ x: p.tMs, y: p.windFromDeg })),
    borderColor: '#1c72b8',
    pointRadius: 0,
    tension: 0.2,
  }];
  if (amedas && amedas.length) {
    datasets.push({
      label: '辻堂(参考)',
      data: amedas.map((a) => ({ x: a.obsMs, y: a.dirDeg })),
      borderColor: '#888',
      borderDash: [4, 4],
      pointRadius: 0,
    });
  }
  return { datasets };
}
