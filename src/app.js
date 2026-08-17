import { parseCsv } from './csv.js';
import { detectType } from './detect.js';
import { parseGpsPoints, rejectOutliers } from './gps.js';
import { parseTags } from './tags.js';
import { computeBounds, fitTransform, unproject, project } from './projection.js';
import { pan, zoomAt, screenToWorld, worldToScreen } from './viewport.js';
import { globalRange, remapEventsToAxis } from './timeaxis.js';
import { positionAt } from './interpolate.js';
import { parseMp4TimesFromFile, embeddedStartMs } from './videometa.js';
import { scanFolderVideos } from './folderimport.js';
import { drawScene } from './renderer.js';
import { createPlayback } from './playback.js';
import { createTimeline } from './timeline.js';
import { memberList, filterMembers } from './members.js';
import { DIR_NAMES, fetchWind } from './wind.js';
import { fetchWindFromCsv } from './windCsv.js';
import {
  createReflection, loadReflections, saveReflections, windLabel, formatVideoPos,
} from './reflections.js';

const PALETTE = ['#1c72b8', '#e67e22', '#27ae60', '#8e44ad', '#c0392b', '#16a085'];

const state = {
  tracks: [],
  events: [],
  marks: [],
  videos: [],
  pins: [], // タイムライン上に自由に刺すピン(絶対時刻)。クリックでcrop開始を移動。
  reflections: loadReflections(),
  mode: 'absolute',
  accuracyFilter: true,
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
  onPinAdd: (axisT) => { state.pins.push(axisT + currentBase()); draw(); },
  onPinRemove: (idx) => { state.pins.splice(idx, 1); draw(); },
});

// elapsedモードでの軸オフセット(基準トラック開始)。軸時刻⇄絶対時刻の変換に使う。
function currentBase() {
  const refTrack = state.tracks.find((t) => t.visible) || null;
  return state.mode === 'elapsed' && refTrack ? refTrack.tRange.start : 0;
}

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
  const base = currentBase();
  const axisEvents = remapEventsToAxis(state.events, state.mode, base);
  // 動画を [開始, 開始+長さ] の区間としてタイムライン軸に変換(長さ不明なら点)
  const axisVideos = remapEventsToAxis(
    state.videos.map((v) => ({ t: v.t, tEnd: v.durationMs != null ? v.t + v.durationMs : null })),
    state.mode, base,
  );
  // ピンを軸時刻へ変換(タグ/動画と同様、絶対時刻で保持)
  const axisPins = remapEventsToAxis(state.pins.map((t) => ({ t })), state.mode, base).map((e) => e.t);

  drawScene(mapCtx, {
    transform: state.transform, tracks: state.tracks, events: state.events,
    marks: state.marks, videos: state.videos, activeVideoId: currentVideo?.id,
    now, mode: state.mode, crop: state.crop, referenceTrack: refTrack,
  });
  timeline.render({ range, crop: state.crop, now, events: axisEvents, pending: pendingStart, videos: axisVideos, pins: axisPins });
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
    if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
      await addVideo(file);
      continue;
    }
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

// ドロップされた動画を、その瞬間の再生位置(絶対時刻)に紐付けて登録。
let videoSeq = 0;
function firstVisibleTrack() { return state.tracks.find((t) => t.visible) || null; }
function nowAbsolute() {
  const r = firstVisibleTrack();
  return state.mode === 'elapsed' && r ? r.tRange.start + playback.getNow() : playback.getNow();
}
// 時刻 t(絶対ms) に動画を配置。src を渡すと status に配置理由を表示。
function placeVideo(file, t, durationMs, src) {
  const url = URL.createObjectURL(file);
  const v = { id: `vid${videoSeq++}`, t, url, name: file.name, durationMs };
  state.videos.push(v);
  if (src) statusEl.textContent = `動画「${file.name}」を${src}に配置しました`;
  if (v.durationMs == null) loadVideoDuration(v); // mvhdで取れなければ要素から補完
  return v;
}

async function addVideo(file) {
  if (!firstVisibleTrack()) { statusEl.textContent = '先にGPS軌跡を読み込んでください'; return; }
  // 埋め込み撮影時刻(録画開始 = creation − 長さ)を優先。moov だけ部分読みする。
  let meta = null;
  try { meta = await parseMp4TimesFromFile(file); } catch { /* パース失敗はフォールバック */ }
  const embedded = embeddedStartMs(meta);
  const range = globalRange(state.tracks, 'absolute');
  if (embedded != null && embedded >= range.start && embedded <= range.end) {
    const src = meta.durationMs != null ? '埋め込み撮影時刻(終了−長さ=開始)' : '埋め込み撮影時刻';
    placeVideo(file, embedded, meta.durationMs ?? null, src);
  } else {
    const src = embedded != null ? '現在位置(撮影時刻は軌跡範囲外)' : '現在の再生位置';
    placeVideo(file, nowAbsolute(), meta?.durationMs ?? null, src);
  }
}

// 取込ボタンの状態表示。state: idle|loading|success|error。
// loading 以外は詳細を status にも出す。成功/失敗は数秒後に待機へ戻す。
const FOLDER_BTN_IDLE = '📁 動画フォルダ取込';
let folderBtnTimer = null;
function setFolderBtn(stateName, label) {
  const btn = $('folder-import');
  btn.textContent = label;
  btn.className = stateName === 'idle' ? 'btn' : `btn btn-${stateName}`;
  btn.disabled = stateName === 'loading';
  if (folderBtnTimer) { clearTimeout(folderBtnTimer); folderBtnTimer = null; }
  if (stateName === 'success' || stateName === 'error') {
    folderBtnTimer = setTimeout(() => setFolderBtn('idle', FOLDER_BTN_IDLE), 4000);
  }
}

// 同期フォルダ(Drive for Desktop 等)から GPS 範囲内の動画を自動取込。
async function importFromVideoFolder() {
  if (!firstVisibleTrack()) {
    setFolderBtn('error', '⚠️ 先にGPSを読込');
    statusEl.textContent = '先にGPS軌跡を読み込んでください'; return;
  }
  if (!window.showDirectoryPicker) {
    setFolderBtn('error', '⚠️ 非対応ブラウザ');
    statusEl.textContent = 'このブラウザは非対応です（Chrome/Edge で開いてください）'; return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker(); } catch { return; } // キャンセルは何もしない
  setFolderBtn('loading', '⏳ 走査中…');
  statusEl.textContent = '動画フォルダを走査中…';
  const range = globalRange(state.tracks, 'absolute');
  let res;
  try { res = await scanFolderVideos(dir, range); } catch (e) {
    setFolderBtn('error', '⚠️ 失敗');
    statusEl.textContent = `フォルダ走査に失敗: ${e.message}`; return;
  }
  for (const m of res.matched) placeVideo(m.file, m.t, m.durationMs, null);
  draw(); renderSidebar();
  setFolderBtn('success', `✅ ${res.matched.length}本取込`);
  statusEl.textContent = `${res.scanned}本中${res.matched.length}本を取込`
    + `（${res.skipped}本は範囲外/時刻不明でスキップ）`;
}

// 動画の再生時間を <video> のメタから読み、範囲バー用に埋める(mp4以外/パース失敗の保険)。
function loadVideoDuration(v) {
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.onloadedmetadata = () => {
    if (Number.isFinite(probe.duration)) { v.durationMs = probe.duration * 1000; draw(); }
    probe.removeAttribute('src'); probe.load();
  };
  probe.src = v.url;
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

  const vl = $('video-list'); vl.innerHTML = '';
  state.videos.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = v === currentVideo ? 'track-row active' : 'track-row'; // 再生中はオレンジ
    row.innerHTML =
      `<span>▶</span><span class="vid-name" data-play="${i}">${v.name}</span>` +
      `<button data-delvid="${i}">×</button>`;
    vl.appendChild(row);
  });
  vl.querySelectorAll('span[data-play]').forEach((s) =>
    s.addEventListener('click', (e) => {
      const v = state.videos[+e.target.dataset.play];
      // 反省エディタが開いていれば「クリックで動画をメンション」、そうでなければ再生。
      if (editorOpen) insertVideoMention(v); else openVideoPanel(v);
    }));
  vl.querySelectorAll('button[data-delvid]').forEach((b) =>
    b.addEventListener('click', (e) => deleteVideo(+e.target.dataset.delvid)));

  renderReflectionList();
}

// 動画を削除。開いている動画ならパネルを閉じ、ObjectURLを解放。
function deleteVideo(index) {
  const v = state.videos[index];
  if (!v) return;
  if (v === currentVideo) closeVideoPanel();
  state.videos.splice(index, 1);
  URL.revokeObjectURL(v.url);
  statusEl.textContent = `動画「${v.name}」を削除しました`;
  draw(); renderSidebar();
}

// --- 入力配線 ---
$('file-input').addEventListener('change', (e) => loadFiles(e.target.files));
$('folder-import').addEventListener('click', importFromVideoFolder);
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
function pickVideo(px, py) {
  const T = state.transform;
  const ref = firstVisibleTrack();
  if (!T.proj || !ref) return null;
  for (const v of state.videos) {
    const pos = positionAt(ref.points, v.t);
    if (!pos) continue;
    const s = worldToScreen(project(pos.lat, pos.lon, T.proj), T);
    if (Math.abs(s.px - px) <= 14 && Math.abs(s.py - py) <= 12) return v;
  }
  return null;
}
function handleMapClick(px, py) {
  const v = pickVideo(px, py); // 動画バッジ優先
  if (v) {
    if (v === currentVideo) closeVideoPanel(); // 開いている動画なら閉じる（トグル）
    else openVideoPanel(v); // 別動画/未開なら開く（自動で差し替え）
    return;
  }
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

// 左右分割の動画パネル。開閉でキャンバスを左半分に再フィット(クロップは維持)。
let currentVideo = null; // 再生中の動画(GPS現在位置の同期元)
function refitTransform() {
  const bounds = computeBounds(state.tracks);
  if (bounds) state.transform = fitTransform(bounds, mapCanvas.width, mapCanvas.height);
}
// 動画の再生位置を絶対時刻に直し、現在モードの軸へ変換して playhead を追従させる。
function syncFromVideo() {
  if (!currentVideo) return;
  const r = firstVisibleTrack();
  const base = state.mode === 'elapsed' && r ? r.tRange.start : 0;
  playback.seek(currentVideo.t + $('video-el').currentTime * 1000 - base);
}
function openVideoPanel(v) {
  const vid = $('video-el');
  $('video-name').textContent = v.name;
  vid.src = v.url;
  $('video-panel').classList.remove('hidden');
  // 動画をmasterにするので app のクロックは止める
  playback.pause(); $('play-btn').textContent = '▶';
  currentVideo = v;
  resizeCanvas(); refitTransform(); draw(); renderSidebar();
  vid.play().catch(() => { /* autoplayブロックは手動再生に委ねる */ });
}
function closeVideoPanel() {
  const panel = $('video-panel');
  if (panel.classList.contains('hidden')) return;
  const vid = $('video-el');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  currentVideo = null;
  panel.classList.add('hidden');
  resizeCanvas(); refitTransform(); draw(); renderSidebar();
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
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); cancelPending(); closeVideoPanel(); } });
$('video-close').addEventListener('click', closeVideoPanel);
$('video-delete').addEventListener('click', () => { if (currentVideo) deleteVideo(state.videos.indexOf(currentVideo)); });
// 再生中はrAFで毎フレーム同期(滑らか)。停止/スクラブ時はtimeupdate/seekedで追従。
function videoTickLoop() {
  const vid = $('video-el');
  if (!currentVideo || vid.paused) return;
  syncFromVideo();
  requestAnimationFrame(videoTickLoop);
}
$('video-el').addEventListener('play', () => requestAnimationFrame(videoTickLoop));
$('video-el').addEventListener('timeupdate', syncFromVideo);
$('video-el').addEventListener('seeked', syncFromVideo);

// ================= 反省ノート =================
let editorOpen = false;
let editingId = null;        // 既存反省の編集時にそのid
let pendingPeople = [];      // 挿入済みメンション [{fullName, given}]
let pendingVideos = [];      // 挿入済み動画 [{name, tMs, token}]
let currentWind = null;      // 取得/入力中の風 {dir,speed,source,station,obsMs}
let windEdited = false;      // ユーザーが風欄を手編集したか
let reflSeq = 0;
const mention = { active: false, atPos: -1, items: [], index: 0 };

// 風向セレクトを16方位(＋空)で初期化。
(function initWindSelect() {
  const sel = $('refl-wind-dir');
  sel.innerHTML = '<option value="">—</option>'
    + DIR_NAMES.map((d) => `<option value="${d}">${d}</option>`).join('');
})();

// 練習日時(絶対時刻の全体範囲, JST日付)。トラック未読込なら null。
function practiceInfo() {
  const range = globalRange(state.tracks, 'absolute');
  if (!(range.end > range.start)) return null;
  const date = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(range.start));
  return { date, startMs: range.start, endMs: range.end };
}

// 保存済み反省の一覧をサイドバーに描画。
function renderReflectionList() {
  const list = $('reflection-list'); list.innerHTML = '';
  state.reflections.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'refl-row';
    const snippet = (r.text || '(空)').replace(/\s+/g, ' ').slice(0, 40);
    const meta = [r.practice?.date, windLabel(r.wind, { formatObs: formatObsTime }).replace('風: ', '🍃')]
      .filter(Boolean).join(' ・ ');
    row.innerHTML =
      `<span class="refl-snippet" data-edit="${i}">${escapeHtml(snippet)}`
      + `<div class="refl-meta">${escapeHtml(meta)}</div></span>`
      + `<button data-delrefl="${i}" title="削除">×</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('span[data-edit]').forEach((s) =>
    s.addEventListener('click', (e) => openReflectionEditor(state.reflections[+e.currentTarget.dataset.edit])));
  list.querySelectorAll('button[data-delrefl]').forEach((b) =>
    b.addEventListener('click', (e) => {
      state.reflections.splice(+e.target.dataset.delrefl, 1);
      persistReflections(); renderReflectionList();
    }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatObsTime(ms) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}
function persistReflections() { saveReflections(state.reflections); }

function setWindInputs(wind) {
  $('refl-wind-dir').value = wind?.dir ?? '';
  $('refl-wind-speed').value = wind && wind.speed != null ? wind.speed : '';
  $('refl-wind-src').textContent = wind
    ? (wind.source === 'amedas'
      ? `アメダス${wind.station ?? ''}${wind.obsMs != null ? ' ' + formatObsTime(wind.obsMs) : ''}`
      : wind.source === 'csv'
        ? `${wind.station ?? ''}(CSV)${wind.obsMs != null ? ' ' + formatObsTime(wind.obsMs) : ''}`
        : '手入力')
    : '';
}

// エディタを開く(existing を渡せば編集、無ければ新規)。
async function openReflectionEditor(existing = null) {
  editorOpen = true;
  editingId = existing?.id ?? null;
  windEdited = false;
  const members = memberList();
  $('refl-text').value = existing?.text ?? '';
  pendingPeople = (existing?.people ?? []).map((full) => {
    const m = members.find((x) => x.fullName === full);
    return { fullName: full, given: m?.given ?? full.split(' ').pop() };
  });
  pendingVideos = (existing?.videos ?? []).map((v) => ({
    name: v.name, tMs: v.tMs ?? 0, token: videoToken(v.name, v.tMs ?? 0),
  }));
  $('refl-title').textContent = existing ? '反省を編集' : '反省を記入';
  $('reflection-editor').classList.remove('hidden');
  hideMention();
  $('refl-text').focus();

  if (existing) {
    currentWind = existing.wind ?? null;
    setWindInputs(currentWind);
  } else {
    currentWind = null;
    setWindInputs(null);
    $('refl-wind-src').textContent = '風取得中…';
    const target = firstVisibleTrack() ? nowAbsolute() : Date.now();
    // アメダスAPIで取れないとき(取得失敗/配信範囲外の過去日)は辻堂の時別CSVへ。
    const w = await fetchWind(target) ?? await fetchWindFromCsv(target);
    // 取得中にユーザーが手入力/別操作したら上書きしない。
    if (editorOpen && !editingId && !windEdited) {
      currentWind = w;
      setWindInputs(w);
      if (!w) $('refl-wind-src').textContent = '自動取得できず(手入力してください)';
    }
  }
}

function closeReflectionEditor() {
  editorOpen = false; editingId = null;
  hideMention();
  $('reflection-editor').classList.add('hidden');
}

function videoToken(name, tMs) { return `[動画:${name}@${formatVideoPos(tMs)}]`; }

// 動画メンションを本文カーソル位置に挿入(「クリックで動画をメンション」)。
function insertVideoMention(v) {
  const tMs = v === currentVideo ? $('video-el').currentTime * 1000 : 0;
  const token = videoToken(v.name, tMs);
  insertAtCaret(token + ' ');
  pendingVideos.push({ name: v.name, tMs, token });
  statusEl.textContent = `動画「${v.name}」を反省にメンションしました`;
}

function insertAtCaret(text) {
  const ta = $('refl-text');
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
}

// --- @メンションのオートコンプリート ---
function updateMention() {
  const ta = $('refl-text');
  const caret = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, caret);
  const m = before.match(/@([^\s@]*)$/); // 直近の@以降(空白を含まない)
  if (!m) { hideMention(); return; }
  mention.atPos = caret - m[0].length;
  mention.items = filterMembers(m[1]);
  mention.index = 0;
  renderMention();
}

function renderMention() {
  const box = $('refl-mention');
  if (!mention.items.length) { hideMention(); return; }
  mention.active = true;
  box.innerHTML = mention.items.map((m, i) =>
    `<li data-i="${i}" class="${i === mention.index ? 'active' : ''}">`
    + `${escapeHtml(m.fullName)}<span class="m-kana">${escapeHtml(m.kana)}</span></li>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('li').forEach((li) =>
    li.addEventListener('mousedown', (e) => { // mousedownでtextareaのblur前に確定
      e.preventDefault(); chooseMention(+li.dataset.i);
    }));
}

function hideMention() { mention.active = false; $('refl-mention').classList.add('hidden'); }

function chooseMention(i) {
  const m = mention.items[i];
  if (!m) return;
  const ta = $('refl-text');
  const caret = ta.selectionStart ?? ta.value.length;
  const insert = `@${m.given} `;
  ta.value = ta.value.slice(0, mention.atPos) + insert + ta.value.slice(caret);
  const pos = mention.atPos + insert.length;
  ta.setSelectionRange(pos, pos);
  if (!pendingPeople.some((p) => p.fullName === m.fullName)) {
    pendingPeople.push({ fullName: m.fullName, given: m.given });
  }
  hideMention();
  ta.focus();
}

function saveReflection() {
  const text = $('refl-text').value.trim();
  const dir = $('refl-wind-dir').value;
  const speedRaw = $('refl-wind-speed').value;
  const speed = speedRaw === '' ? null : Number(speedRaw);
  const wind = (dir || speed != null) ? {
    dir, speed,
    source: windEdited ? 'manual' : (currentWind?.source ?? 'manual'),
    station: currentWind?.station,
    obsMs: currentWind?.obsMs,
  } : null;
  // 本文に残っているメンションだけを構造化して保存(手で消したものは除外)。
  const people = pendingPeople.filter((p) => text.includes(`@${p.given}`)).map((p) => p.fullName);
  const videos = pendingVideos.filter((v) => text.includes(v.token)).map((v) => ({ name: v.name, tMs: v.tMs }));

  if (editingId) {
    const idx = state.reflections.findIndex((r) => r.id === editingId);
    if (idx >= 0) {
      state.reflections[idx] = { ...state.reflections[idx], text, people, videos, wind };
    }
  } else {
    state.reflections.push(createReflection({
      id: `refl${Date.now()}_${reflSeq++}`, createdAt: Date.now(),
      text, people, videos, wind, practice: practiceInfo(),
    }));
  }
  persistReflections();
  closeReflectionEditor();
  renderReflectionList();
  statusEl.textContent = '反省を保存しました';
}

$('reflection-add').addEventListener('click', () => openReflectionEditor(null));
$('refl-cancel').addEventListener('click', closeReflectionEditor);
$('refl-save').addEventListener('click', saveReflection);
$('refl-wind-dir').addEventListener('change', () => { windEdited = true; });
$('refl-wind-speed').addEventListener('input', () => { windEdited = true; });
$('refl-text').addEventListener('input', updateMention);
$('refl-text').addEventListener('click', updateMention);
$('refl-text').addEventListener('keydown', (e) => {
  if (!mention.active) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mention.index = (mention.index + 1) % mention.items.length; renderMention(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mention.index = (mention.index - 1 + mention.items.length) % mention.items.length; renderMention(); }
  else if (e.key === 'Enter') { e.preventDefault(); chooseMention(mention.index); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMention(); }
});

window.addEventListener('resize', () => { resizeCanvas(); recomputeView(); draw(); });
resizeCanvas();
draw();
renderReflectionList();
