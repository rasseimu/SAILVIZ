// src/dashboard.js
// 集計(tuning)・折れ線(linechart)・アンカー(boatlayout)・ブラシ(timebrush)を束ね、
// #dashboard-screen に「470を囲む推移グラフ＋期間バー」を描画するDOMコントローラ。
import { collectTuning, TUNING_PARAMS, FOCUS_BOATS, BOAT_COLORS } from './tuning.js';
import { buildLineChart } from './linechart.js';
import { anchorFor, BOAT_IMAGE } from './boatlayout.js';
import { msToX, xToMs, clampRange } from './timebrush.js';

const $ = (id) => document.getElementById(id);
const CHART_W = 160;
const CHART_H = 60;

export function createDashboard({ loadEntries, rigLabels }) {
  let data = null;       // collectTuning の結果
  let view = null;       // { from, to } 現在の表示域
  let drag = null;       // ブラシのドラッグ状態

  function renderLegend() {
    $('dashboard-legend').innerHTML = FOCUS_BOATS.map((b) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${BOAT_COLORS[b]}"></span>${b}</span>`
    ).join('');
  }

  // 中央画像とリーダー線オーバレイを用意。
  function ensureStage() {
    const img = $('dashboard-boat');
    if (img.getAttribute('src') !== BOAT_IMAGE) img.setAttribute('src', BOAT_IMAGE);
    let leaders = $('dashboard-leaders');
    if (!leaders) {
      leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      leaders.id = 'dashboard-leaders';
      $('dashboard-stage').appendChild(leaders);
    }
    return leaders;
  }

  // 画像の実表示矩形(contain)を stage 座標で得る。未ロード時は概算。
  function boatRect() {
    const stage = $('dashboard-stage').getBoundingClientRect();
    const img = $('dashboard-boat').getBoundingClientRect();
    return {
      left: img.left - stage.left, top: img.top - stage.top,
      width: img.width, height: img.height,
      stageW: stage.width, stageH: stage.height,
    };
  }

  function renderCharts() {
    const charts = $('dashboard-charts');
    charts.innerHTML = '';
    const leaders = ensureStage();
    leaders.innerHTML = '';
    if (!data.domain) return;
    const rect = boatRect();
    leaders.setAttribute('viewBox', `0 0 ${rect.stageW} ${rect.stageH}`);
    leaders.setAttribute('width', rect.stageW);
    leaders.setAttribute('height', rect.stageH);

    TUNING_PARAMS.forEach((param) => {
      const a = anchorFor(param);
      if (!a) return;
      // アンカー(画像正規化)→ stage 座標
      const ax = rect.left + a.x * rect.width;
      const ay = rect.top + a.y * rect.height;
      // グラフ位置: side に応じて画像の左右へ、縦は順番で散らす
      const col = a.side === 'left';
      const sideItems = TUNING_PARAMS.filter((p) => (anchorFor(p)?.side === a.side));
      const idx = sideItems.indexOf(param);
      const cx = col ? rect.left * 0.15 : rect.left + rect.width + (rect.stageW - rect.left - rect.width) * 0.15;
      const cy = 20 + idx * (rect.stageH - 60) / Math.max(1, sideItems.length - 1);

      const box = document.createElement('div');
      box.className = 'tuning-chart';
      box.style.left = `${cx}px`;
      box.style.top = `${cy}px`;
      box.innerHTML = `<div class="tc-title">${rigLabels[param] || param}</div>`
        + buildLineChart({
          series: data.series[param], boats: data.boats, colors: BOAT_COLORS,
          from: view.from, to: view.to, width: CHART_W, height: CHART_H, pad: 3,
        });
      charts.appendChild(box);

      // リーダー線: グラフ端 → アンカー
      const lx = col ? cx + CHART_W : cx;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', lx); line.setAttribute('y1', cy + CHART_H / 2);
      line.setAttribute('x2', ax); line.setAttribute('y2', ay);
      line.setAttribute('stroke', '#bbb'); line.setAttribute('stroke-width', '1');
      leaders.appendChild(line);
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

  function fmtDate(ms) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
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
      renderTimebar(); renderCharts();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', () => { drag = null; });
  }

  async function render() {
    renderLegend();
    const entries = await loadEntries();
    data = collectTuning(entries);
    view = data.domain ? { from: data.domain.min, to: data.domain.max } : { from: 0, to: 1 };
    // 画像ロード後にレイアウトが確定するので load を待つ
    const img = $('dashboard-boat');
    ensureStage();
    if (img.complete && img.naturalWidth) { renderCharts(); }
    else {
      if (img._onloadHandler) img.removeEventListener('load', img._onloadHandler);
      img._onloadHandler = () => renderCharts();
      img.addEventListener('load', img._onloadHandler);
    }
    renderTimebar();
    wireTimebar();
  }

  return { render };
}
