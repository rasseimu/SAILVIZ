// src/dashboard.js
// 集計(tuning)・Chart.js描画(chartview)・ブラシ(timebrush)・表(tuningtable)を束ね、
// #dashboard-screen に「4×3グリッドの推移グラフ＋数値表＋期間バー」を描画するDOMコントローラ。
// ミニグラフはクリックで拡大(対話グラフ)。ブラシは各チャートのx範囲を更新して連動。
// 風軸パネル: 現在読込中GPSトラック(1艇)から推定風向を時系列で表示（チューニンググリッドとは別セクション）。
import { collectTuning, collectTuningRows, activeBoats, TUNING_PARAMS, FOCUS_BOATS, BOAT_COLORS } from './tuning.js';
import { buildChartDatasets, renderChart } from './chartview.js';
import { buildTuningTable } from './tuningtable.js';
import { msToX, xToMs, clampRange } from './timebrush.js';
import { estimateWindAxisSeries } from './windaxis.js';
import { buildWindAxisDatasets } from './windaxisview.js';

const $ = (id) => document.getElementById(id);

// getTrack: () => track|null — 現在読込中の最初の可視GPSトラック(app.js の state 参照)
// getMarks: () => mark[]   — 現在のマーク一覧
export function createDashboard({ loadEntries, rigLabels, getTrack = null, getMarks = null }) {
  let data = null;       // collectTuning の結果
  let rows = [];         // collectTuningRows の結果(表用の平坦行)
  let view = null;       // { from, to } 現在の表示域
  let drag = null;       // ブラシのドラッグ状態
  let miniCharts = [];   // ミニ Chart.js インスタンス群(再描画時に destroy)
  let modalChart = null; // 拡大表示中の Chart.js インスタンス
  let windAxisChart = null; // 風軸グラフの Chart.js インスタンス
  let selected = 'all';  // サイドメニューの選択('all' | 艇番号)

  // 現在の選択で実際に描画する艇。データ集計後の boats を基準に絞る。
  function boatsToShow() {
    return activeBoats(selected, data?.boats || []);
  }

  // サイドメニュー(全て + 6艇)を描画。クリックで選択を切替え再描画。
  function renderNav() {
    const nav = $('dashboard-nav');
    if (!nav) return;
    const items = [{ key: 'all', label: '全て' }, ...FOCUS_BOATS.map((b) => ({ key: String(b), label: String(b) }))];
    nav.innerHTML = items.map((it) =>
      `<button type="button" class="dashboard-nav-item${it.key === selected ? ' active' : ''}" data-key="${it.key}">${it.label}</button>`
    ).join('');
    nav.querySelectorAll('.dashboard-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (selected === btn.dataset.key) return;
        selected = btn.dataset.key;
        renderNav();
        renderLegend();
        renderCharts();
        renderTable();
      });
    });
  }

  function renderLegend() {
    $('dashboard-legend').innerHTML = boatsToShow().map((b) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${BOAT_COLORS[b]}"></span>${b}</span>`
    ).join('');
  }

  // 既存のミニ Chart.js を全て破棄(再描画・画面離脱時のリーク防止)。
  function destroyMiniCharts() {
    for (const c of miniCharts) { try { c.destroy(); } catch { /* 破棄済みは無視 */ } }
    miniCharts = [];
  }

  // 11パラメータのミニグラフを 4列×3行のグリッドに並べる。クリックで拡大。
  function renderCharts() {
    const charts = $('dashboard-charts');
    destroyMiniCharts();
    charts.innerHTML = '';
    if (!data.domain) return;

    TUNING_PARAMS.forEach((param) => {
      const box = document.createElement('div');
      box.className = 'tuning-chart';
      box.title = `${rigLabels[param] || param}（クリックで拡大）`;
      const wrap = document.createElement('div');
      wrap.className = 'tc-canvas-wrap';
      const canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      box.innerHTML = `<div class="tc-title">${rigLabels[param] || param}</div>`;
      box.appendChild(wrap);
      box.addEventListener('click', () => openChartModal(param));
      charts.appendChild(box);

      const chart = renderChart(canvas, {
        datasets: buildChartDatasets({ series: data.series[param], boats: boatsToShow(), colors: BOAT_COLORS }),
        from: view.from, to: view.to, mini: true, fmtX: fmtDate,
      });
      miniCharts.push(chart);
    });
  }

  // ブラシ操作時: 各チャートの x範囲だけ更新(再生成せず軽量)。
  function updateChartsRange() {
    for (const c of miniCharts) {
      c.options.scales.x.min = view.from;
      c.options.scales.x.max = view.to;
      c.update('none');
    }
    if (modalChart) {
      modalChart.options.scales.x.min = view.from;
      modalChart.options.scales.x.max = view.to;
      modalChart.update('none');
    }
  }

  // ミニグラフクリック→そのパラメータを大きな対話グラフで表示。
  function openChartModal(param) {
    if (!data || !data.domain) return;
    $('dashboard-modal-title').textContent = rigLabels[param] || param;
    $('dashboard-chart-modal').classList.remove('hidden');
    if (modalChart) { try { modalChart.destroy(); } catch { /* noop */ } modalChart = null; }
    modalChart = renderChart($('dashboard-modal-canvas'), {
      datasets: buildChartDatasets({ series: data.series[param], boats: boatsToShow(), colors: BOAT_COLORS }),
      from: view.from, to: view.to, mini: false, fmtX: fmtDate,
    });
  }

  function closeChartModal() {
    $('dashboard-chart-modal').classList.add('hidden');
    if (modalChart) { try { modalChart.destroy(); } catch { /* noop */ } modalChart = null; }
  }

  // グラフ下の数値まとめ表を、現在の期間 [view] で描画。
  function renderTable() {
    const el = $('dashboard-table');
    if (!el) return;
    if (!data || !data.domain) { el.innerHTML = ''; return; }
    const show = boatsToShow();
    const visibleRows = rows.filter((r) => show.includes(r.boat));
    el.innerHTML = buildTuningTable({
      rows: visibleRows, params: TUNING_PARAMS, labels: rigLabels, colors: BOAT_COLORS,
      from: view.from, to: view.to, fmtDate: fmtDateTime,
    });
  }

  function renderTimebar() {
    const canvas = $('dashboard-timebar');
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 44;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!data.domain) return;
    const scale = { min: data.domain.min, max: data.domain.max, width: w };
    // 全域トラック
    ctx.fillStyle = '#eee'; ctx.fillRect(0, h / 2 - 3, w, 6);
    // 選択域
    const x1 = msToX(view.from, scale); const x2 = msToX(view.to, scale);
    ctx.fillStyle = 'rgba(21,88,214,0.35)'; ctx.fillRect(x1, h / 2 - 6, x2 - x1, 12);
    // ハンドル
    ctx.fillStyle = '#1558d6';
    for (const x of [x1, x2]) ctx.fillRect(x - 2, h / 2 - 10, 4, 20);
    // 端の日付ラベル
    ctx.fillStyle = '#555'; ctx.font = '11px sans-serif';
    ctx.fillText(fmtDate(data.domain.min), 2, 12);
    ctx.textAlign = 'right'; ctx.fillText(fmtDate(data.domain.max), w - 2, 12); ctx.textAlign = 'left';
  }

  // MM-DD(JST)。sv-SE の月日単独は "DD/MM" になり紛らわしいので YYYY-MM-DD から切り出す。
  function fmtDate(ms) {
    return fmtDateTime(ms).slice(5); // "2026-06-15" → "06-15"
  }

  // 表の行用: 年月日(JST)。練習日を一意に示す。
  function fmtDateTime(ms) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  }

  function wireTimebar() {
    const canvas = $('dashboard-timebar');
    if (canvas.dataset.wired) return;
    canvas.dataset.wired = '1';
    const scaleOf = () => ({ min: data.domain.min, max: data.domain.max, width: canvas.clientWidth || 800 });
    const pick = (e) => {
      const r = canvas.getBoundingClientRect();
      const ms = xToMs(e.clientX - r.left, scaleOf());
      // from/to の近い方を掴む
      return Math.abs(ms - view.from) <= Math.abs(ms - view.to) ? 'from' : 'to';
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!data?.domain) return;
      drag = pick(e); canvas.setPointerCapture(e.pointerId); onMove(e);
    });
    const onMove = (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const ms = xToMs(e.clientX - r.left, scaleOf());
      view = clampRange({ ...view, [drag]: ms }, data.domain);
      renderTimebar(); updateChartsRange(); renderTable();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', () => { drag = null; });
  }

  // モーダルの閉じる操作を一度だけ配線(×・背景クリック・Esc)。
  function wireModal() {
    const modal = $('dashboard-chart-modal');
    if (modal.dataset.wired) return;
    modal.dataset.wired = '1';
    $('dashboard-modal-close').addEventListener('click', closeChartModal);
    // 背景(オーバレイ本体)クリックで閉じる。内側パネルのクリックは無視。
    modal.addEventListener('click', (e) => { if (e.target === modal) closeChartModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeChartModal();
    });
  }

  // 風軸グラフを描画する。現在読込中のGPSトラックからタック/ジャイブを検出して風向を推定。
  // amedas参考ライン: TODO — src/wind.js の fetchWind 結果を { obsMs, dirDeg }[] に整形して渡す
  function renderWindAxis() {
    const canvas = $('windaxis-chart');
    const emptyEl = $('windaxis-empty');
    if (!canvas) return;

    // 既存のChart.jsインスタンスを破棄
    if (windAxisChart) { try { windAxisChart.destroy(); } catch { /* 破棄済みは無視 */ } windAxisChart = null; }

    const track = getTrack ? getTrack() : null;
    if (!track) {
      // トラック未読込: パネルは非表示
      $('windaxis-section').classList.add('hidden');
      return;
    }
    $('windaxis-section').classList.remove('hidden');

    const marks = getMarks ? getMarks() : [];
    let series;
    try {
      series = estimateWindAxisSeries(track, { marks });
    } catch (e) {
      // 推定失敗時はパネルを空にして落ちない
      series = [];
    }

    if (series.length === 0) {
      // タック/ジャイブ不検出: 空グラフではなくメッセージを表示
      canvas.style.display = 'none';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    canvas.style.display = '';
    if (emptyEl) emptyEl.classList.add('hidden');

    const { datasets } = buildWindAxisDatasets({ series, amedas: [] });
    // x範囲はトラック全体。fmtXはHH:MM(JST)。
    const from = track.tRange.start;
    const to = track.tRange.end;
    const fmtX = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    windAxisChart = renderChart(canvas, { datasets, from, to, mini: false, fmtX });
  }

  async function render() {
    const entries = await loadEntries();
    data = collectTuning(entries);
    rows = collectTuningRows(entries);
    view = data.domain ? { from: data.domain.min, to: data.domain.max } : { from: 0, to: 1 };
    renderNav();
    renderLegend();
    renderCharts();
    renderTimebar();
    renderTable();
    wireTimebar();
    wireModal();
    renderWindAxis();
  }

  return { render };
}
