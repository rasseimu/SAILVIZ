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

// loadProgressData/saveProgressData を注入すると保存フォルダのファイルへ永続化できる。
// 未指定時は従来どおり localStorage のみ(単体でも動く)。
export function createProgress({
  loadEntries,
  loadProgressData = async () => loadProgress(),
  saveProgressData = async (obj) => saveProgress(obj),
} = {}) {
  let reflections = [];   // 全練習の反省を平坦化
  let progress = {};      // sailviz.progress
  let selected = 'all';   // 'all' | fullName
  let chart = null;
  let editing = null;     // 編集中の `${reflId}:${field}`(null=非編集)

  // 進捗の保存はUIを止めないよう非同期・投げっぱなし(失敗はログのみ。
  // saveProgressData 側で localStorage ミラーも行うため最低限は残る)。
  function persist() {
    Promise.resolve(saveProgressData(progress)).catch((e) => console.error('進捗の保存に失敗', e));
  }

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
        persist();
        renderBody();
      }));
    content.querySelectorAll('input[data-goal]').forEach((cb) =>
      cb.addEventListener('change', () => {
        progress = setGoalDone(progress, cb.dataset.goal, cb.checked);
        persist();
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
      persist();
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
    const added = sum.issueAddedSeries[key] || [];
    const resolved = sum.resolutionSeries[key] || [];
    if (!added.length && !resolved.length) return;

    // x範囲: 最初の反省 → 今日。累計線は from で y=0、末尾に to(今日)で最終値を足し、
    // 階段線が最初の反省から今日まで伸びるようにする。
    const to = Date.now();
    const from = sum.firstDateMs[key]
      ?? Math.min(...[added, resolved].flatMap((s) => (s.length ? [s[0].dateMs] : [])));
    const toLine = (pts) => {
      if (!pts.length) return [{ x: from, y: 0 }, { x: to, y: 0 }];
      const body = pts.map((p) => ({ x: p.dateMs, y: p.value }));
      return [{ x: from, y: 0 }, ...body, { x: to, y: pts[pts.length - 1].value }];
    };
    const datasets = [
      {
        label: '課題追加(累計)',
        data: toLine(added),
        borderColor: '#f59e0b', backgroundColor: '#f59e0b', stepped: true, tension: 0,
      },
      {
        label: '課題解決(累計)',
        data: toLine(resolved),
        borderColor: '#1558d6', backgroundColor: '#1558d6', stepped: true, tension: 0,
      },
    ];
    chart = renderChart(canvas, { datasets, from, to, mini: false, yBeginAtZero: true, fmtX: (ms) => fmtDate(ms).slice(5) });
  }

  async function render() {
    const entries = await loadEntries();
    reflections = allReflections(entries);
    progress = await loadProgressData();
    renderNav();
    renderBody();
  }

  return { render };
}
