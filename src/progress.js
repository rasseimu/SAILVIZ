// src/progress.js
// #progress-screen に「横タブ(全て＋名簿) × 目標変化/課題進捗(3段階)/風速別発見/解決量推移グラフ」を描画。
// 反省(真実源)は全練習ファイルから集め、進捗段階は sailviz.progress オーバーレイで持つ。
import { memberList } from './members.js';
import {
  loadProgress, saveProgress, setIssueStage, setGoalDone, setTextOverride, summarize, WIND_BINS,
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
  let editing = null;     // 編集中の `${reflId}:${field}`(null=非編集)

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

  // 名前接頭辞＋編集可能テキスト(表示 or 入力)を返す。field ∈ {goal,issue,discovery}。
  function editable(field, reflId, name, text) {
    const prefix = selected === 'all' ? `<span class="et-name">${esc(name)}：</span>` : '';
    if (editing === `${reflId}:${field}`) {
      return `${prefix}<input class="edit-input" type="text" data-refl="${esc(reflId)}" data-field="${field}" value="${esc(text)}" />`
        + `<button class="edit-save" data-refl="${esc(reflId)}" data-field="${field}">保存</button>`
        + '<button class="edit-cancel">取消</button>';
    }
    return `${prefix}<span class="et-text">${esc(text)}</span>`
      + `<button class="edit-btn" data-refl="${esc(reflId)}" data-field="${field}" title="編集">✎</button>`;
  }

  function renderBody() {
    const sum = summarize(reflections, progress);
    const content = $('progress-content');
    const buckets = memberBuckets(sum);

    const goalsHtml = buckets.flatMap(([name, b]) => b.goals.map((g) =>
      `<div class="goal-card"><div class="gc-head"><span class="gr-date">${fmtDate(g.dateMs)}</span>`
      + `<input type="checkbox" data-goal="${esc(g.reflId)}" ${g.done ? 'checked' : ''} /></div>`
      + `<div class="gc-body">${editable('goal', g.reflId, name, g.text)}</div></div>`)).join('');

    const issuesHtml = buckets.flatMap(([name, b]) => b.issues.map((it) =>
      `<div class="issue-card"><div class="ic-top"><span class="ic-date">${fmtDate(it.dateMs)}</span>`
      + `<span class="ic-text">${editable('issue', it.reflId, name, it.text)}</span></div>`
      + `<span class="stage-toggle">${STAGES.map((s) =>
        `<button data-issue="${esc(it.reflId)}" data-stage="${s.v}" class="${it.stage === s.v ? 'active' : ''}">${s.label}</button>`).join('')}</span></div>`)).join('') || '<p>(課題なし)</p>';

    // 風速ビンごとに発見を集約(全ビン + unknown)。
    const binOrder = [...WIND_BINS, { key: 'unknown', label: '風速不明' }];
    const discHtml = binOrder.map((bin) => {
      const items = buckets.flatMap(([name, b]) => (b.discoveriesByBin[bin.key] || []).map((d) =>
        `<li>${editable('discovery', d.reflId, name, d.text)}</li>`));
      return items.length ? `<div class="wind-bin"><strong>${bin.label}</strong><ul>${items.join('')}</ul></div>` : '';
    }).join('') || '<p>(発見なし)</p>';

    content.innerHTML =
      `<section class="progress-section pq-goals"><h3>目標の変化</h3><div class="goal-cards">${goalsHtml || '<p>(目標なし)</p>'}</div></section>`
      + `<section class="progress-section pq-issues"><h3>課題の進捗</h3>${issuesHtml}</section>`
      + `<section class="progress-section pq-disc"><h3>風速別の発見</h3>${discHtml}</section>`
      + `<section class="progress-section pq-chart"><h3>解決量の推移</h3><div id="progress-chart-wrap"><canvas id="progress-chart"></canvas></div></section>`;

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

    // 編集: ✎で入力に切替 → 保存/取消。Enter=保存, Esc=取消。
    content.querySelectorAll('.edit-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        editing = `${btn.dataset.refl}:${btn.dataset.field}`;
        renderBody();
        const input = content.querySelector('.edit-input');
        if (input) { input.focus(); input.select(); }
      }));
    const commit = (input) => {
      progress = setTextOverride(progress, input.dataset.refl, input.dataset.field, input.value);
      saveProgress(progress);
      editing = null;
      renderBody();
    };
    content.querySelectorAll('.edit-save').forEach((btn) =>
      btn.addEventListener('click', () => {
        const input = content.querySelector('.edit-input');
        if (input) commit(input);
      }));
    content.querySelectorAll('.edit-cancel').forEach((btn) =>
      btn.addEventListener('click', () => { editing = null; renderBody(); }));
    content.querySelectorAll('.edit-input').forEach((input) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(input); }
        else if (e.key === 'Escape') { e.preventDefault(); editing = null; renderBody(); }
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
    chart = renderChart(canvas, { datasets, from, to, mini: false, yBeginAtZero: true, fmtX: (ms) => fmtDate(ms).slice(5) });
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
