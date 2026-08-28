// src/progress.js
// #progress-screen に「横タブ(全て＋名簿) × 目標変化/課題進捗(3段階)/風速別発見/解決量推移グラフ」を描画。
// 反省(真実源)は全練習ファイルから集め、進捗段階は sailviz.progress オーバーレイで持つ。
import { memberList } from './members.js';
import {
  loadProgress, saveProgress, setIssueStage, setGoalDone, summarize, WIND_BINS,
} from './progressstore.js';
import { renderChart } from './chartview.js';

const $ = (id) => document.getElementById(id);
const STAGES = [{ v: 0, label: '未着手' }, { v: 1, label: '取組中' }, { v: 2, label: '解決' }];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function createProgress({ loadEntries }) {
  let reflections = [];   // 全練習の反省を平坦化
  let progress = {};      // sailviz.progress
  let selected = 'all';   // 'all' | fullName
  let chart = null;

  // 全エントリの反省を平坦化。id で重複排除(先勝ち)＝保存済みファイルと
  // 現在の未保存 state を両方渡しても二重計上しない。
  function allReflections(entries) {
    const out = [];
    const seen = new Set();
    for (const e of entries) {
      for (const r of (e.project?.reflections || [])) {
        if (r.id != null && seen.has(r.id)) continue;
        if (r.id != null) seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  function renderNav() {
    const nav = $('progress-nav');
    const items = [{ key: 'all', label: '全て' }, ...memberList().map((m) => ({ key: m.fullName, label: m.fullName }))];
    nav.innerHTML = items.map((it) =>
      `<button type="button" class="dashboard-nav-item${it.key === selected ? ' active' : ''}" data-key="${esc(it.key)}">${esc(it.label)}</button>`
    ).join('');
    nav.querySelectorAll('.dashboard-nav-item').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (selected === btn.dataset.key) return;
        selected = btn.dataset.key;
        renderNav();
        renderBody();
      }));
  }

  // 現在選択に対応する部員データ(全ては合算表示)。
  function memberBuckets(sum) {
    if (selected === 'all') return Object.entries(sum.byMember); // [ [name, bucket], ... ]
    return sum.byMember[selected] ? [[selected, sum.byMember[selected]]] : [];
  }

  function renderBody() {
    const sum = summarize(reflections, progress);
    const content = $('progress-content');
    const buckets = memberBuckets(sum);

    const goalsHtml = buckets.flatMap(([name, b]) => b.goals.map((g) =>
      `<div class="goal-row"><span class="gr-date">${fmtDate(g.dateMs)}</span>`
      + `<input type="checkbox" data-goal="${esc(g.reflId)}" ${g.done ? 'checked' : ''} />`
      + `<span>${selected === 'all' ? esc(name) + '：' : ''}${esc(g.text)}</span></div>`)).join('') || '<p>(目標なし)</p>';

    const issuesHtml = buckets.flatMap(([name, b]) => b.issues.map((it) =>
      `<div class="issue-card"><span class="ic-date">${fmtDate(it.dateMs)}</span>`
      + `<span class="ic-text">${selected === 'all' ? esc(name) + '：' : ''}${esc(it.text)}</span>`
      + `<span class="stage-toggle">${STAGES.map((s) =>
        `<button data-issue="${esc(it.reflId)}" data-stage="${s.v}" class="${it.stage === s.v ? 'active' : ''}">${s.label}</button>`).join('')}</span></div>`)).join('') || '<p>(課題なし)</p>';

    // 風速ビンごとに発見を集約(全ビン + unknown)。
    const binOrder = [...WIND_BINS, { key: 'unknown', label: '風速不明' }];
    const discHtml = binOrder.map((bin) => {
      const items = buckets.flatMap(([name, b]) => (b.discoveriesByBin[bin.key] || []).map((d) =>
        `<li>${selected === 'all' ? esc(name) + '：' : ''}${esc(d.text)}</li>`));
      return items.length ? `<div class="wind-bin"><strong>${bin.label}</strong><ul>${items.join('')}</ul></div>` : '';
    }).join('') || '<p>(発見なし)</p>';

    content.innerHTML =
      `<section class="progress-section"><h3>目標の変化</h3>${goalsHtml}</section>`
      + `<section class="progress-section"><h3>課題の進捗</h3>${issuesHtml}</section>`
      + `<section class="progress-section"><h3>風速別の発見</h3>${discHtml}</section>`
      + `<section class="progress-section"><h3>解決量の推移</h3><div id="progress-chart-wrap"><canvas id="progress-chart"></canvas></div></section>`;

    wireBody();
    renderChartFor(sum);
  }

  function wireBody() {
    const content = $('progress-content');
    content.querySelectorAll('button[data-issue]').forEach((btn) =>
      btn.addEventListener('click', () => {
        progress = setIssueStage(progress, btn.dataset.issue, Number(btn.dataset.stage));
        saveProgress(progress);
        renderBody();
      }));
    content.querySelectorAll('input[data-goal]').forEach((cb) =>
      cb.addEventListener('change', () => {
        progress = setGoalDone(progress, cb.dataset.goal, cb.checked);
        saveProgress(progress);
        renderBody();
      }));
  }

  function renderChartFor(sum) {
    const canvas = $('progress-chart');
    if (!canvas) return;
    if (chart) { try { chart.destroy(); } catch { /* noop */ } chart = null; }
    const key = selected === 'all' ? 'all' : selected;
    const pts = sum.resolutionSeries[key] || [];
    if (!pts.length) return;
    const datasets = [{
      label: '解決課題(累計)',
      data: pts.map((p) => ({ x: p.dateMs, y: p.value })),
      borderColor: '#1558d6', backgroundColor: '#1558d6', stepped: true, tension: 0,
    }];
    const from = pts[0].dateMs;
    const to = pts[pts.length - 1].dateMs;
    chart = renderChart(canvas, { datasets, from, to, mini: false, fmtX: (ms) => fmtDate(ms).slice(5) });
  }

  async function render() {
    const entries = await loadEntries();
    reflections = allReflections(entries);
    progress = loadProgress();
    renderNav();
    renderBody();
  }

  return { render };
}
