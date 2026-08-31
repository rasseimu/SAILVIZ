// src/vmgview.js
// ダッシュボードのVMG比較パネル。純データ整形＋Chart.js/表のDOMコントローラ。
import { buildChartDatasets, renderChart } from './chartview.js';

// 走種で絞り、各レグ中点時刻に meanVmg を1点置いた boat 別系列。
export function buildVmgChartSeries(perBoatLegVmg, pointOfSail) {
  const series = {};
  const boats = [];
  for (const l of perBoatLegVmg) {
    if (l.pointOfSail !== pointOfSail) continue;
    if (!series[l.boatId]) { series[l.boatId] = []; boats.push(l.boatId); }
    series[l.boatId].push({ tMs: (l.startT + l.endT) / 2, value: l.meanVmg });
  }
  for (const b of boats) series[b].sort((a, c) => a.tMs - c.tMs);
  return { series, boats };
}

// ランキング行のHTML表。首位（走種内先頭行）に is-top クラス。
export function buildVmgRankTable(rankRows, { colors = {}, pointOfSail }) {
  const rows = rankRows.filter((r) => r.pointOfSail === pointOfSail);
  const body = rows.map((r, i) =>
    `<tr class="${i === 0 ? 'is-top' : ''}">` +
    `<td><span class="legend-swatch" style="background:${colors[r.boatId] || '#888'}"></span>${r.boatId}</td>` +
    `<td>${r.meanVmg.toFixed(2)}</td>` +
    `<td>${(r.winRatio * 100).toFixed(0)}%</td>` +
    `<td>${r.legCount}</td>` +
    `<td>${r.bestLegVmg.toFixed(2)}</td></tr>`
  ).join('');
  return `<table class="vmg-rank"><thead><tr><th>艇</th><th>平均VMG</th><th>勝率</th><th>レグ数</th><th>最良</th></tr></thead><tbody>${body}</tbody></table>`;
}

// DOMコントローラ。mount 要素にトグル・グラフ・表を描く。
export function createVmgPanel({ mount }) {
  let pos = 'upwind';
  let chart = null;
  let last = { perBoatLegVmg: [], ranks: [], colors: {} };

  mount.innerHTML =
    '<div class="vmg-toggle">' +
    '<button type="button" data-pos="upwind" class="active">風上</button>' +
    '<button type="button" data-pos="downwind">風下</button></div>' +
    '<div class="vmg-chart-wrap"><canvas></canvas></div>' +
    '<div class="vmg-table"></div>';

  function draw() {
    const { perBoatLegVmg, ranks, colors } = last;
    const { series, boats } = buildVmgChartSeries(perBoatLegVmg, pos);
    if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
    const canvas = mount.querySelector('canvas');
    const tMs = perBoatLegVmg.map((l) => (l.startT + l.endT) / 2);
    const from = tMs.length ? Math.min(...tMs) : 0;
    const to = tMs.length ? Math.max(...tMs) : 1;
    chart = renderChart(canvas, {
      datasets: buildChartDatasets({ series, boats, colors }),
      from, to, mini: false,
    });
    mount.querySelector('.vmg-table').innerHTML = buildVmgRankTable(ranks, { colors, pointOfSail: pos });
  }

  mount.querySelectorAll('.vmg-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      pos = btn.dataset.pos;
      mount.querySelectorAll('.vmg-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      draw();
    });
  });

  return {
    render(perBoatLegVmg, ranks, opts = {}) {
      last = { perBoatLegVmg, ranks, colors: opts.colors || {} };
      draw();
    },
  };
}
