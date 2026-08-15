import { parseCsv } from './csv.js';
import { detectType } from './detect.js';
import { parseGpsPoints, rejectOutliers } from './gps.js';
import { parseTags } from './tags.js';
import { computeBounds, fitTransform, unproject, project } from './projection.js';
import { pan, zoomAt, screenToWorld, worldToScreen } from './viewport.js';
import { globalRange, remapEventsToAxis } from './timeaxis.js';
import { drawScene } from './renderer.js';
import { createPlayback } from './playback.js';
import { createTimeline } from './timeline.js';

const PALETTE = ['#1c72b8', '#e67e22', '#27ae60', '#8e44ad', '#c0392b', '#16a085'];

const state = {
  tracks: [],
  events: [],
  marks: [],
  mode: 'absolute',
  accuracyFilter: false,
  crop: { start: 0, end: 0 },
  transform: { scale: 1, cx: 0, cy: 0, w: 1, h: 1, proj: null },
};

const $ = (id) => document.getElementById(id);
const mapCanvas = $('map');
const mapCtx = mapCanvas.getContext('2d');
const statusEl = $('status');

function resizeCanvas() {
  for (const c of [mapCanvas, $('timeline')]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(r.width));
    c.height = Math.max(1, Math.floor(r.height));
  }
  state.transform.w = mapCanvas.width;
  state.transform.h = mapCanvas.height;
}

const playback = createPlayback({ onTick: () => draw() });
const timeline = createTimeline($('timeline'), {
  onCropChange: (c) => { state.crop = c; playback.setRange(c); draw(); },
  onScrub: (t) => playback.seek(t),
});

function recomputeView() {
  const bounds = computeBounds(state.tracks);
  if (bounds) state.transform = fitTransform(bounds, mapCanvas.width, mapCanvas.height);
  const range = globalRange(state.tracks, state.mode);
  state.crop = { ...range };
  playback.setRange(range);
}

function draw() {
  const now = playback.getNow();
  const range = globalRange(state.tracks, state.mode);
  // 基準トラック = 最初の可視トラック。elapsed の 0起点、lat/lon無しタグの補間位置、
  // および elapsed 軸へのタグ変換の基準に使う。elapsed で開始時刻の異なる複数トラックを
  // 重ねた場合、タグは基準トラックの開始を0とした軸上に配置される（start-together比較の規約）。
  const refTrack = state.tracks.find((t) => t.visible) || null;
  const base = state.mode === 'elapsed' && refTrack ? refTrack.tRange.start : 0;
  const axisEvents = remapEventsToAxis(state.events, state.mode, base);

  drawScene(mapCtx, {
    transform: state.transform, tracks: state.tracks, events: state.events,
    marks: state.marks,
    now, mode: state.mode, crop: state.crop, referenceTrack: refTrack,
  });
  timeline.render({ range, crop: state.crop, now, events: axisEvents, pending: pendingStart });
  $('clock').textContent = range.end > range.start ? formatClock(now, state.mode) : '--:--:--';
  $('drop-zone').classList.toggle('hidden', state.tracks.length > 0 || state.events.length > 0);
}

function formatClock(now, mode) {
  if (mode === 'elapsed') {
    const s = Math.max(0, Math.floor(now / 1000));
    return `+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  const d = new Date(now);
  return d.toLocaleTimeString('ja-JP', { hour12: false });
}

async function loadFiles(fileList) {
  for (const file of fileList) {
    const text = await file.text();
    const { header, rows } = parseCsv(text);
    const type = detectType(header);
    if (type === 'gps') addTrack(file.name, header, rows);
    else if (type === 'tag') addTags(header, rows);
    else statusEl.textContent = `未対応の列構成: ${file.name}`;
  }
  recomputeView();
  draw();
  renderSidebar();
}

function addTrack(name, header, rows) {
  let points = parseGpsPoints(header, rows);
  if (state.accuracyFilter) points = points.filter((p) => p.accuracy == null || p.accuracy <= 50);
  const { points: clean, removed } = rejectOutliers(points);
  if (clean.length === 0) { statusEl.textContent = `${name}: 有効点なし`; return; }
  state.tracks.push({
    id: name, name, color: PALETTE[state.tracks.length % PALETTE.length],
    visible: true, points: clean,
    bounds: computeBounds([{ visible: true, points: clean }]),
    tRange: { start: clean[0].t, end: clean[clean.length - 1].t },
  });
  statusEl.textContent = `${name}: ${clean.length}点 (外れ値${removed}点除外)`;
}

function addTags(header, rows) {
  const evs = parseTags(header, rows);
  state.events.push(...evs);
  statusEl.textContent = `タグ ${evs.length}件 読込`;
}

function renderSidebar() {
  const tl = $('track-list'); tl.innerHTML = '';
  state.tracks.forEach((tr, i) => {
    const row = document.createElement('div'); row.className = 'track-row';
    row.innerHTML =
      `<input type="checkbox" ${tr.visible ? 'checked' : ''} data-i="${i}" />` +
      `<span class="swatch" style="background:${tr.color}"></span>` +
      `<span>${tr.name}</span><button data-del="${i}">×</button>`;
    tl.appendChild(row);
  });
  tl.querySelectorAll('input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', (e) => {
      state.tracks[+e.target.dataset.i].visible = e.target.checked;
      recomputeView(); draw();
    }));
  tl.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      state.tracks.splice(+e.target.dataset.del, 1);
      recomputeView(); draw(); renderSidebar();
    }));

  const gl = $('tag-list'); gl.innerHTML = '';
  state.events.forEach((ev) => {
    const row = document.createElement('div'); row.className = 'tag-row';
    row.textContent = `${ev.kind === 'range' ? '▬' : '▲'} ${ev.label || '(無題)'}`;
    gl.appendChild(row);
  });

  const ml = $('mark-list'); ml.innerHTML = '';
  state.marks.forEach((mk, i) => {
    const row = document.createElement('div'); row.className = 'track-row';
    const glyph = mk.shape === 'triangle' ? '▲' : '●';
    row.innerHTML =
      `<span style="color:${mk.color}">${glyph}</span>` +
      `<span>${mk.shape === 'triangle' ? '三角' : '丸'}</span>` +
      `<button data-delmark="${i}">×</button>`;
    ml.appendChild(row);
  });
  ml.querySelectorAll('button[data-delmark]').forEach((b) =>
    b.addEventListener('click', (e) => {
      state.marks.splice(+e.target.dataset.delmark, 1);
      draw(); renderSidebar();
    }));
}

// --- 入力配線 ---
$('file-input').addEventListener('change', (e) => loadFiles(e.target.files));
$('play-btn').addEventListener('click', () => {
  playback.toggle();
  $('play-btn').textContent = playback.isPlaying() ? '⏸' : '▶';
});
$('speed-select').addEventListener('change', (e) => playback.setSpeed(+e.target.value));
$('align-mode').addEventListener('change', (e) => { state.mode = e.target.value; recomputeView(); draw(); });
$('accuracy-filter').addEventListener('change', (e) => {
  state.accuracyFilter = e.target.checked;
  statusEl.textContent = '精度フィルタ変更は次回読込から反映されます';
});

const dz = $('drop-zone');
const stage = $('stage');
['dragover', 'dragenter'].forEach((ev) => stage.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('dragover');
}));
stage.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });

// pan/zoom + 軌跡クリックで区間選択(ドラッグはpan、単クリックは区間選択)
let dragging = null;
mapCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // 左ドラッグのみpan(右クリックはマークメニュー用)
  dragging = { x: e.offsetX, y: e.offsetY, ox: e.offsetX, oy: e.offsetY, moved: false };
});
mapCanvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (Math.abs(e.offsetX - dragging.ox) + Math.abs(e.offsetY - dragging.oy) > 4) dragging.moved = true;
  state.transform = pan(state.transform, e.offsetX - dragging.x, e.offsetY - dragging.y);
  dragging.x = e.offsetX; dragging.y = e.offsetY;
  draw();
});
window.addEventListener('pointerup', () => {
  if (dragging && !dragging.moved) handleMapClick(dragging.ox, dragging.oy);
  dragging = null;
});
mapCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.transform = zoomAt(state.transform, e.offsetX, e.offsetY, factor);
  draw();
}, { passive: false });

// 区間選択: 軌跡上の点を単クリック→1回目=始点, 2回目=終点でクロップを設定
let pendingStart = null; // 選択軸上の時刻(絶対 or elapsed)
const PICK_PX = 8;
function pickTrackTime(px, py) {
  const T = state.transform;
  if (!T.proj) return null;
  let best = null;
  for (const tr of state.tracks) {
    if (!tr.visible) continue;
    for (const p of tr.points) {
      const s = worldToScreen(project(p.lat, p.lon, T.proj), T);
      const d = Math.hypot(s.px - px, s.py - py);
      if (d <= PICK_PX && (!best || d < best.d)) {
        best = { d, time: state.mode === 'elapsed' ? p.t - tr.tRange.start : p.t };
      }
    }
  }
  return best ? best.time : null;
}
function handleMapClick(px, py) {
  const t = pickTrackTime(px, py);
  if (t == null) return; // 軌跡から離れたクリックは無視
  if (pendingStart == null) {
    pendingStart = t;
    statusEl.textContent = '始点を選択。終点を軌跡上でクリック（Escで取消）';
    draw();
  } else {
    const c = { start: Math.min(pendingStart, t), end: Math.max(pendingStart, t) };
    pendingStart = null;
    state.crop = c; playback.setRange(c);
    statusEl.textContent = '区間を設定しました（下バーのハンドルで全体に戻せます）';
    draw();
  }
}
function cancelPending() {
  if (pendingStart == null) return;
  pendingStart = null; statusEl.textContent = '区間選択を取消しました'; draw();
}

// マーク配置: 右クリック→4択メニュー→クリック地点に配置
const markMenu = $('mark-menu');
let menuPos = null;
let markSeq = 0;
function hideMenu() { markMenu.classList.add('hidden'); menuPos = null; }
mapCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.transform.proj) { statusEl.textContent = '先にGPS軌跡を読み込んでください'; return; }
  menuPos = { px: e.offsetX, py: e.offsetY };
  markMenu.style.left = `${e.offsetX}px`;
  markMenu.style.top = `${e.offsetY}px`;
  markMenu.classList.remove('hidden');
});
markMenu.querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!menuPos) return;
    const world = screenToWorld(menuPos, state.transform);
    const { lat, lon } = unproject(world.x, world.y, state.transform.proj);
    state.marks.push({ id: `mk${markSeq++}`, lat, lon, shape: b.dataset.shape, color: b.dataset.color });
    hideMenu(); draw(); renderSidebar();
  }));
window.addEventListener('pointerdown', (e) => { if (!markMenu.contains(e.target)) hideMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); cancelPending(); } });

window.addEventListener('resize', () => { resizeCanvas(); recomputeView(); draw(); });
resizeCanvas();
draw();
