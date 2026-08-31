import { parseCsv } from './csv.js';
import { detectType } from './detect.js';
import { parseGpsPoints, rejectOutliers } from './gps.js';
import { parseTags } from './tags.js';
import { computeBounds, fitTransform, unproject, project } from './projection.js';
import { pan, zoomAt, screenToWorld, worldToScreen } from './viewport.js';
import { globalRange, remapEventsToAxis } from './timeaxis.js';
import { positionAt } from './interpolate.js';
import { parseMp4TimesFromFile, embeddedStartMs } from './videometa.js';
import { scanFolderVideos, collectVideoFiles } from './folderimport.js';
import { drawScene } from './renderer.js';
import { createPlayback } from './playback.js';
import { createTimeline } from './timeline.js';
import { createWindStrip } from './windstripview.js';
import { estimateWindAxisSeries, windDirAt } from './windaxis.js';
import { minuteWinners } from './vmgminute.js';
import { nextRotation, rotatedFitBox } from './videoview.js';
import { memberList, filterMembers } from './members.js';
import { parseMinutes, matchMember } from './minutes.js';
import { DIR_NAMES, fetchWind } from './wind.js';
import { fetchWindFromCsv } from './windCsv.js';
import {
  createReflection, loadReflections, saveReflections, windLabel, formatVideoPos,
  previousRig, RIG_FIELDS, NOTE_FIELDS,
} from './reflections.js';
import { serializeProject, deserializeProject } from './project.js';
import {
  projectFileName, listProjectFiles, readProject, writeProject, readProgress, writeProgress,
} from './projectfs.js';
import { practiceSummary, earliestContentMs } from './summary.js';
import { saveDirHandle, loadDirHandle, ensurePermission } from './dirhandle.js';
import { createDashboard } from './dashboard.js';
import { createProgress } from './progress.js';
import { loadProgress, saveProgress } from './progressstore.js';
import { analyzeFleetVmg, unifyWindAxis, rankVmg } from './vmg.js';
import { createVmgPanel } from './vmgview.js';

// トラック自動割当＆色変更メニューの共通パレット(識別しやすい12色)。
const PALETTE = [
  '#1c72b8', // 青
  '#e67e22', // 橙
  '#27ae60', // 緑
  '#8e44ad', // 紫
  '#c0392b', // 赤
  '#16a085', // 青緑
  '#d81b60', // ピンク
  '#795548', // 茶
  '#f39c12', // 黄土
  '#34495e', // 濃紺
  '#00acc1', // シアン
  '#689f38', // 黄緑
];

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
  // VMG比較 ---
  vmgEnabled: false,
  vmgHighlights: [],      // renderer に渡すハイライト区間 {boatId,color,lo,hi,...}[]
  vmgLegs: [],            // 高コスト解析キャッシュ: perBoatLegVmg
  vmgHighlightsAll: [],   // 同上: highlights（全期間）
  vmgColors: {},          // {boatId: color}
  vmgWindSeries: [],      // unifyWindAxis の結果キャッシュ
};

const $ = (id) => document.getElementById(id);
const mapCanvas = $('map');
const mapCtx = mapCanvas.getContext('2d');
const statusEl = $('status');

function resizeCanvas() {
  for (const c of [mapCanvas, $('timeline'), $('windstrip')]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(r.width));
    c.height = Math.max(1, Math.floor(r.height));
  }
  state.transform.w = mapCanvas.width;
  state.transform.h = mapCanvas.height;
}

const playback = createPlayback({ onTick: () => draw() });
const timeline = createTimeline($('timeline'), {
  onCropChange: (c) => { state.crop = c; playback.setRange(c); recomputeVmgCrop(); draw(); },
  onScrub: (t) => {
    // 動画パネル表示中は動画がマスター。バーのスクラブで動画の再生位置を動かす(seekedでplayhead追従)。
    if (currentVideo) seekVideoToAxisTime(t);
    else playback.seek(t);
  },
  onVideoClick: (id) => { const v = state.videos.find((x) => x.id === id); if (v) openVideoPanel(v); },
  onPinAdd: (axisT) => { state.pins.push(axisT + currentBase()); draw(); },
  onPinRemove: (idx) => { state.pins.splice(idx, 1); draw(); },
});

const windstrip = createWindStrip($('windstrip'));

// 風軸推定は重いので毎フレーム走らせない。可視トラックごとに一度だけ推定してキャッシュする。
// tracks/marks/可視状態が変わったとき recomputeWindAxis() で作り直す。
// キーは「トラックオブジェクト」。各艇のGPSファイルが同名(例 Location.csv)でidが重複しうるため、
// idをキーにすると別艇が1本に潰れる(風軸ストリップ/VMGが取り違える)。
let windSeriesByTrack = new Map(); // track -> [{tMs,windFromDeg}]（絶対時刻）
function recomputeWindAxis() {
  windSeriesByTrack = new Map();
  for (const tr of state.tracks) {
    if (!tr.visible) continue;
    try {
      windSeriesByTrack.set(tr, estimateWindAxisSeries(tr, { marks: state.marks }));
    } catch {
      windSeriesByTrack.set(tr, []); // 推定失敗は空系列として扱い、落とさない
    }
  }
  recomputeVmgWinners();
}

// 1分ごとVMG勝者(ネオンハイライト用)。vmgOn時のみ算出。風軸再計算後に呼ぶ。
let vmgOn = false; // VMG勝者ネオン表示。表示のみ・保存しない(windUpと同じ扱い)。
let vmgWinners = []; // [{boatId,color,lo,hi,pointOfSail,vmg}]（絶対epoch ms）
function recomputeVmgWinners() {
  if (!vmgOn) { vmgWinners = []; return; }
  const visible = state.tracks.filter((t) => t.visible);
  try {
    vmgWinners = minuteWinners(visible, windSeriesByTrack, {});
  } catch {
    vmgWinners = [];
  }
}

// elapsedモードでの軸オフセット(基準トラック開始)。軸時刻⇄絶対時刻の変換に使う。
function currentBase() {
  const refTrack = state.tracks.find((t) => t.visible) || null;
  return state.mode === 'elapsed' && refTrack ? refTrack.tRange.start : 0;
}

let mapRot = 0; // マップ回転角(ラジアン、表示のみ・保存しない)。fitTransform後に再適用。
let windUp = false; // 風軸を常に画面上へ向けるモード(再生時刻の推定風向に追従)。保存しない。

// windUp時: 基準トラックの推定風向を現在時刻で引き、風向が真上を向く回転(rot=-風向)を適用する。
// 風向データが無ければ回転は据え置き。スライダー/ラベル表示も同期する。
function applyWindUpRotation(now) {
  const ref = state.tracks.find((t) => t.visible) || null;
  const series = ref ? windSeriesByTrack.get(ref) : null;
  if (!ref || !series || series.length === 0) return;
  const lookupT = state.mode === 'elapsed' ? ref.tRange.start + now : now;
  const dir = windDirAt(series, lookupT);
  if (dir == null) return;
  mapRot = (-dir * Math.PI) / 180;
  state.transform.rot = mapRot;
  const d = Math.round(((-dir % 360) + 360) % 360);
  $('rotate-slider').value = String(d);
  $('rotate-label').textContent = `${d}°`;
}

function recomputeView() {
  const bounds = computeBounds(state.tracks);
  if (bounds) state.transform = fitTransform(bounds, mapCanvas.width, mapCanvas.height);
  state.transform.rot = mapRot;
  const range = globalRange(state.tracks, state.mode);
  state.crop = { ...range };
  playback.setRange(range);
  recomputeWindAxis();
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
    state.videos.map((v) => ({ id: v.id, t: v.t, tEnd: v.durationMs != null ? v.t + v.durationMs : null })),
    state.mode, base,
  );
  // ピンを軸時刻へ変換(タグ/動画と同様、絶対時刻で保持)
  const axisPins = remapEventsToAxis(state.pins.map((t) => ({ t })), state.mode, base).map((e) => e.t);

  // 風軸を上に向けるモード: drawScene の前に回転を現在時刻の風向へ更新する。
  if (windUp) applyWindUpRotation(now);

  drawScene(mapCtx, {
    transform: state.transform, tracks: state.tracks, events: state.events,
    marks: state.marks, videos: state.videos, activeVideoId: currentVideo?.id,
    now, mode: state.mode, crop: state.crop, referenceTrack: refTrack,
    vmgWinners,
  });
  timeline.render({ range, crop: state.crop, now, events: axisEvents, pending: pendingStart, videos: axisVideos, pins: axisPins });
  // 風軸ストリップ: 可視トラックの推定風向を軸時刻へ変換して重ね描き(色はマップと同じ)。
  // elapsed では各トラックを自身の開始で0起点にする(start-together規約。map描画と同じ)。
  const windSeries = state.tracks
    .filter((t) => t.visible && (windSeriesByTrack.get(t) || []).length)
    .map((t) => {
      const off = state.mode === 'elapsed' ? t.tRange.start : 0;
      return {
        color: t.color,
        series: windSeriesByTrack.get(t).map((p) => ({ tMs: p.tMs - off, windFromDeg: p.windFromDeg })),
      };
    });
  windstrip.render({ range, series: windSeries, now });
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
  // 埋め込み撮影時刻から録画開始を求めて優先(端末差は embeddedStartMs が吸収)。moov だけ部分読みする。
  let meta = null;
  try { meta = await parseMp4TimesFromFile(file); } catch { /* パース失敗はフォールバック */ }
  const embedded = embeddedStartMs(meta, file.name);
  const range = globalRange(state.tracks, 'absolute');
  if (embedded != null && embedded >= range.start && embedded <= range.end) {
    const src = '埋め込み撮影時刻(録画開始)';
    placeVideo(file, embedded, meta.durationMs ?? null, src);
  } else {
    const src = embedded != null ? '現在位置(撮影時刻は軌跡範囲外)' : '現在の再生位置';
    placeVideo(file, nowAbsolute(), meta?.durationMs ?? null, src);
  }
}

// 保存フォルダハンドル(セッション内キャッシュ)。起動時に IndexedDB から復元。
let projectDir = null;

// フォルダ選択ダイアログを毎回開き、選ばれたフォルダを保存フォルダにして永続化する。
// startIn に前回フォルダを渡すことで、Finder が前回と同じ場所(反省データ)で開く。
// 一度でも反省データを選べば IndexedDB に記憶され、以後はそこから開く。
async function chooseProjectDir() {
  if (!window.showDirectoryPicker) {
    statusEl.textContent = 'このブラウザは非対応です（Chrome/Edge で開いてください）';
    return null;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: projectDir || 'documents' });
  } catch { return null; } // キャンセル
  projectDir = dir;
  try { await saveDirHandle(dir); } catch { /* 永続化失敗は致命ではない */ }
  return projectDir;
}

// 保存フォルダを確保する。未設定/権限切れなら選択ダイアログを開く。
async function ensureProjectDir() {
  if (projectDir && await ensurePermission(projectDir)) return projectDir;
  return chooseProjectDir();
}

// 現在の状態を保存フォルダに書き出す。
async function saveProject() {
  const dir = await ensureProjectDir();
  if (!dir) return;
  const obj = serializeProject(state, { savedAt: new Date().toISOString() });
  // ファイル名は練習の実データ時刻(トラックGPS開始/動画配置の最小)で命名。
  // 実データが無い練習は従来どおり保存時刻へフォールバック。
  const dataMs = earliestContentMs(obj);
  const name = projectFileName(new Date(dataMs ?? Date.now()));
  try {
    await writeProject(dir, name, obj);
  } catch (e) {
    statusEl.textContent = `保存に失敗: ${e.message}`; return;
  }
  cacheSummary(name, practiceSummary(obj, { name })); // ホームのカードに即反映
  statusEl.textContent = `保存しました: ${name}`;
}

// 選択した練習ファイルを読み込み、state を置換する。成否を boolean で返す。
async function loadPractice(name) {
  if (state.tracks.length && !window.confirm('現在の内容を破棄して読み込みますか？')) {
    return false;
  }
  let data;
  try {
    data = deserializeProject(await readProject(projectDir, name));
  } catch (e) {
    statusEl.textContent = `読込に失敗: ${e.message}`;
    return false;
  }
  closeVideoPanel(); // stale currentVideo を破棄（パネルが閉じていれば即 return）
  state.mode = data.mode;
  state.accuracyFilter = data.accuracyFilter;
  state.tracks = data.tracks;
  state.events = data.events;
  state.marks = data.marks;
  state.pins = data.pins;
  for (const v of state.videos) if (v.url) URL.revokeObjectURL(v.url); // blob URL リーク防止
  state.videos = data.videos; // url なし=未リンク
  state.reflections = data.reflections;
  saveReflections(state.reflections); // localStorage にも反映
  $('align-mode').value = state.mode;
  $('accuracy-filter').checked = state.accuracyFilter;
  invalidateVmgCache();
  recomputeView(); // tracks から transform と既定 crop を再計算
  // 保存されたクロップ範囲が妥当なら復元(recomputeView の全域クロップを上書き)
  if (data.crop && data.crop.end > data.crop.start) {
    state.crop = { start: data.crop.start, end: data.crop.end };
    playback.setRange(state.crop);
  }
  renderSidebar();
  if (state.vmgEnabled) recomputeVmgFull();
  draw();
  const n = state.videos.length;
  statusEl.textContent = n
    ? `読込: ${name}。動画${n}本は未リンク（📁 動画フォルダ取込で再リンク）`
    : `読込: ${name}`;
  return true;
}

// ================= ホーム画面(カード型ランチャー) =================
const SUMMARY_KEY = 'sailviz.summaries.v3'; // v3: 練習日をトラック＋動画の最古時刻に変更(旧キャッシュ破棄)
// 要約キャッシュ: { ファイル名: 要約 }。ファイル名はタイムスタンプで不変なので陳腐化しない。
function loadSummaryCache() {
  try { return JSON.parse(localStorage.getItem(SUMMARY_KEY)) || {}; } catch { return {}; }
}
function cacheSummary(name, summary) {
  const c = loadSummaryCache();
  c[name] = summary;
  try { localStorage.setItem(SUMMARY_KEY, JSON.stringify(c)); } catch { /* quota は無視 */ }
}

function showHome() { document.body.classList.add('view-home'); renderHome(); }
async function showDashboard() {
  if (!projectDir && !(await ensureProjectDir())) return;
  document.body.classList.remove('view-home');
  document.body.classList.add('view-dashboard');
  await dashboard.render();
}
function backToHomeFromDashboard() {
  document.body.classList.remove('view-dashboard');
  showHome();
}
async function showProgress() {
  if (!projectDir && !(await ensureProjectDir())) return;
  document.body.classList.remove('view-home');
  document.body.classList.add('view-progress');
  await progress.render();
}
function backToHomeFromProgress() {
  document.body.classList.remove('view-progress');
  showHome();
}
function showTrack() {
  document.body.classList.remove('view-home');
  // ホーム中は stage が display:none だった → canvas バッファを再計算しないと潰れる
  resizeCanvas(); refitTransform(); draw();
}

// 現在の作業内容を空にする(新規練習用)。blob URL は解放。
function resetState() {
  closeVideoPanel();
  for (const v of state.videos) if (v.url) URL.revokeObjectURL(v.url);
  state.tracks = []; state.events = []; state.marks = []; state.pins = [];
  state.videos = []; state.reflections = [];
  state.crop = { start: 0, end: 0 };
  saveReflections(state.reflections);
  invalidateVmgCache();
  recomputeView(); renderSidebar(); draw();
}

function startNewPractice() {
  if (state.tracks.length && !window.confirm('現在の内容を破棄して新規練習を始めますか？')) return;
  resetState();
  showTrack();
}

async function openPractice(name) {
  if (await loadPractice(name)) showTrack();
}

// カードの中身(ラベル＋要約 or 読込中プレースホルダ)を描画。
function renderCard(card, item, summary) {
  // タイトルは練習日(要約のトラッキング日)を優先。未読込中はファイル名ラベルを仮表示。
  const title = summary?.label || item.label;
  const meta = summary
    ? `<div class="hc-meta"><span>トラック${summary.trackCount}</span>`
      + `<span>反省${summary.reflectionCount}</span>`
      + `<span>動画${summary.videoCount}</span></div>`
      + (summary.wind ? `<div class="hc-wind">💨 ${escapeHtml(summary.wind)}</div>` : '')
    : '<div class="hc-meta">読込中…</div>';
  card.innerHTML = `<div class="hc-title">${escapeHtml(title)}</div>${meta}`;
}

async function renderHome() {
  const grid = $('home-cards');
  const folderEl = $('home-folder');
  folderEl.innerHTML = '';
  // フォルダ選択はホーム画面に一本化。常に表示し、押すと Finder を開く。
  const pick = document.createElement('button');
  pick.className = 'btn';
  pick.textContent = projectDir ? `📁 ${projectDir.name}（変更）` : '▶ 反省データフォルダを選択…';
  pick.title = projectDir ? '別のフォルダに切り替える' : '練習データ(反省データ)のフォルダを選ぶ';
  pick.addEventListener('click', async () => { if (await chooseProjectDir()) renderHome(); });
  folderEl.appendChild(pick);

  grid.innerHTML = '';
  if (!projectDir) {
    const empty = document.createElement('div');
    empty.id = 'home-empty';
    empty.textContent = '保存フォルダを選択すると、過去の練習がここに並びます。';
    grid.appendChild(empty);
    return;
  }

  const items = await listProjectFiles(projectDir);
  const cache = loadSummaryCache();
  for (const it of items) {
    const card = document.createElement('button');
    card.className = 'home-card';
    renderCard(card, it, cache[it.name] ?? null);
    card.addEventListener('click', () => openPractice(it.name));
    grid.appendChild(card);
    // 未キャッシュはその1件だけ読んで要約(初回のみ。以後は即時)。
    if (!cache[it.name]) {
      readProject(projectDir, it.name)
        .then((proj) => { const s = practiceSummary(proj, { name: it.name }); cacheSummary(it.name, s); renderCard(card, it, s); })
        .catch(() => { renderCard(card, it, { trackCount: '?', reflectionCount: '?', videoCount: '?', wind: null }); });
    }
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
  // startIn で反省データフォルダから開く(前回選んだ保存フォルダを優先)
  try { dir = await window.showDirectoryPicker({ startIn: projectDir || 'documents' }); } catch { return; } // キャンセルは何もしない
  setFolderBtn('loading', '⏳ 走査中…');
  statusEl.textContent = '動画フォルダを走査中…';
  const range = globalRange(state.tracks, 'absolute');
  let res;
  try { res = await scanFolderVideos(dir, range); } catch (e) {
    setFolderBtn('error', '⚠️ 失敗');
    statusEl.textContent = `フォルダ走査に失敗: ${e.message}`; return;
  }
  // 読込済みで未リンクの動画を、フォルダ内の同名ファイルで再リンク
  const unlinked = new Set(state.videos.filter((v) => !v.url).map((v) => v.name));
  let relinked = 0;
  if (unlinked.size) {
    const files = await collectVideoFiles(dir, unlinked);
    for (const v of state.videos) {
      if (!v.url && files.has(v.name)) {
        v.url = URL.createObjectURL(files.get(v.name));
        if (v.durationMs == null) loadVideoDuration(v);
        relinked++;
      }
    }
  }
  const present = new Set(state.videos.map((v) => v.name));
  for (const m of res.matched) {
    if (!present.has(m.file.name)) placeVideo(m.file, m.t, m.durationMs, null);
  }
  draw(); renderSidebar();
  setFolderBtn('success', `✅ ${res.matched.length}本取込`);
  statusEl.textContent = `${res.scanned}本中${res.matched.length}本を取込`
    + `（スキップ${res.skipped}本: 時刻不明${res.noTime ?? 0} / 範囲外${res.outOfRange ?? 0}）`
    + (relinked ? `（再リンク${relinked}本）` : '');
  // 診断: スキップ動画の理由・抽出時刻を出す(GPS範囲と突き合わせて原因切り分け)
  if (res.skippedInfo?.length) {
    console.log('[SailViz] スキップ動画:', res.skippedInfo);
    console.log('[SailViz] GPS範囲(絶対ms):', range,
      new Date(range.start).toLocaleString('ja-JP'), '〜', new Date(range.end).toLocaleString('ja-JP'));
  }
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
  invalidateVmgCache();
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
      `<span class="swatch swatch-btn" style="background:${tr.color}" data-color="${i}" title="クリックで色を変更"></span>` +
      `<span class="track-name" data-i="${i}" title="ダブルクリックで名前を変更">${tr.name}</span>` +
      `<button data-del="${i}">×</button>`;
    tl.appendChild(row);
  });
  tl.querySelectorAll('.track-name').forEach((s) =>
    s.addEventListener('dblclick', (e) => startRenameTrack(+e.target.dataset.i, e.target)));
  tl.querySelectorAll('.swatch-btn').forEach((s) =>
    s.addEventListener('click', (e) => openColorMenu(+e.currentTarget.dataset.color, e.currentTarget)));
  tl.querySelectorAll('input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', (e) => {
      state.tracks[+e.target.dataset.i].visible = e.target.checked;
      invalidateVmgCache(); if (state.vmgEnabled) recomputeVmgFull();
      recomputeView(); draw();
    }));
  tl.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      state.tracks.splice(+e.target.dataset.del, 1);
      invalidateVmgCache(); if (state.vmgEnabled) recomputeVmgFull();
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
      recomputeWindAxis(); draw(); renderSidebar();
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

// トラック名をインライン編集。span を input に置換し、Enter/blur で確定・Escで取消。
function startRenameTrack(i, spanEl) {
  const tr = state.tracks[i];
  if (!tr) return;
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'rename-input'; input.value = tr.name;
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = input.value.trim(); if (v) tr.name = v; }
    draw(); renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  spanEl.replaceWith(input);
  input.focus(); input.select();
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
$('project-save').addEventListener('click', saveProject);

// 起動時: 保存フォルダを IndexedDB から復元し、ホームのカードに反映。
(async () => {
  try {
    const h = await loadDirHandle();
    if (h && await ensurePermission(h)) { projectDir = h; }
  } catch { /* 復元失敗は無視 */ }
  showHome(); // 起動時はホーム画面（renderHome が過去の練習を一覧化）
})();

$('app-title').addEventListener('click', showHome); // タイトルクリックでホームへ
$('home-dashboard-link').addEventListener('click', showDashboard);
$('dashboard-home-link').addEventListener('click', backToHomeFromDashboard);
$('home-progress-link').addEventListener('click', showProgress);
$('progress-home-link').addEventListener('click', backToHomeFromProgress);
$('home-new').addEventListener('click', startNewPractice);

$('play-btn').addEventListener('click', () => {
  playback.toggle();
  $('play-btn').textContent = playback.isPlaying() ? '⏸' : '▶';
});
$('speed-select').addEventListener('change', (e) => playback.setSpeed(+e.target.value));
$('align-mode').addEventListener('change', (e) => { state.mode = e.target.value; if (state.vmgEnabled) recomputeVmgFull(); recomputeView(); draw(); });
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

// マップ回転スライダー(0–360°)。表示のみ・保存しない。
function setMapRotationDeg(deg) {
  const d = ((deg % 360) + 360) % 360;
  mapRot = (d * Math.PI) / 180;
  state.transform.rot = mapRot;
  $('rotate-slider').value = String(d);
  $('rotate-label').textContent = `${d}°`;
  draw();
}
$('rotate-slider').addEventListener('input', (e) => setMapRotationDeg(+e.target.value));
$('rotate-reset').addEventListener('click', () => setMapRotationDeg(0));

// 風軸↑トグル: ONで風向追従の自動回転、手動スライダー/リセットは無効化。OFFで現在角のまま手動へ戻す。
$('windup-toggle').addEventListener('change', (e) => {
  windUp = e.target.checked;
  $('rotate-slider').disabled = windUp;
  $('rotate-reset').disabled = windUp;
  draw(); // ON時は即座に風向へ回転。OFF時はmapRotが現在角のまま維持される。
});

// VMG勝者ネオン トグル: ONで1分ごと最良VMG艇を発光表示。OFFで消灯。表示のみ・保存しない。
$('vmg-minute-toggle').addEventListener('change', (e) => {
  vmgOn = e.target.checked;
  recomputeVmgWinners();
  draw();
});

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
let videoRotation = 0; // 動画の表示回転角(度、表示のみ・保存しない)
// ステージに object-fit:contain で収まるよう動画のボックス寸法を決め、回転を適用。
function applyVideoRotation() {
  const stage = $('video-stage'); const vid = $('video-el');
  if (!stage) return;
  const box = rotatedFitBox(videoRotation, stage.clientWidth, stage.clientHeight);
  vid.style.width = `${box.w}px`;
  vid.style.height = `${box.h}px`;
  vid.style.transform = `translate(-50%, -50%) rotate(${videoRotation}deg)`;
}
function refitTransform() {
  const bounds = computeBounds(state.tracks);
  if (bounds) state.transform = fitTransform(bounds, mapCanvas.width, mapCanvas.height);
  state.transform.rot = mapRot;
}
// 動画の再生位置を絶対時刻に直し、現在モードの軸へ変換して playhead を追従させる。
function syncFromVideo() {
  if (!currentVideo) return;
  const r = firstVisibleTrack();
  const base = state.mode === 'elapsed' && r ? r.tRange.start : 0;
  playback.seek(currentVideo.t + $('video-el').currentTime * 1000 - base);
}
// syncFromVideo の逆算。軸時刻 t を動画の currentTime(秒) に直して動画をシーク。
// seeked イベント → syncFromVideo が playhead を追従させる。
function seekVideoToAxisTime(t) {
  if (!currentVideo) return;
  const vid = $('video-el');
  const r = firstVisibleTrack();
  const base = state.mode === 'elapsed' && r ? r.tRange.start : 0;
  const max = Number.isFinite(vid.duration) ? vid.duration : Infinity;
  vid.currentTime = Math.max(0, Math.min((t + base - currentVideo.t) / 1000, max));
}
function openVideoPanel(v) {
  const vid = $('video-el');
  $('video-name').textContent = v.name;
  vid.src = v.url;
  $('video-panel').classList.remove('hidden');
  // 動画をmasterにするので app のクロックは止める
  playback.pause(); $('play-btn').textContent = '▶';
  currentVideo = v;
  videoRotation = 0; // 表示のみ・毎回リセット
  // パネルで幅が変わってもユーザーの pan/zoom は保持(cx,cy,scale はそのまま、w/h だけ更新)。
  resizeCanvas(); draw(); renderSidebar();
  applyVideoRotation(); // パネル表示後にステージ寸法へ合わせる
  vid.play().catch(() => { /* autoplayブロックは手動再生に委ねる */ });
}
function closeVideoPanel() {
  const panel = $('video-panel');
  if (panel.classList.contains('hidden')) return;
  const vid = $('video-el');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  currentVideo = null;
  panel.classList.add('hidden');
  // 閉じても pan/zoom を保持(開く時と対称)。全体には戻さない。
  resizeCanvas(); draw(); renderSidebar();
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
    recomputeWindAxis(); hideMenu(); draw(); renderSidebar();
  }));
window.addEventListener('pointerdown', (e) => { if (!markMenu.contains(e.target)) hideMenu(); });

// トラック色変更: スウォッチ→パレット12色ポップアップ→クリックで変更
const colorMenu = $('color-menu');
let colorTargetIdx = null;
colorMenu.innerHTML = PALETTE.map((c) =>
  `<button class="color-swatch" style="background:${c}" data-c="${c}" title="${c}"></button>`).join('');
function hideColorMenu() { colorMenu.classList.add('hidden'); colorTargetIdx = null; }
function openColorMenu(i, anchorEl) {
  colorTargetIdx = i;
  const r = anchorEl.getBoundingClientRect();
  colorMenu.style.left = `${r.left}px`;
  colorMenu.style.top = `${r.bottom + 4}px`;
  colorMenu.querySelectorAll('.color-swatch').forEach((b) =>
    b.classList.toggle('active', b.dataset.c === state.tracks[i]?.color));
  colorMenu.classList.remove('hidden');
}
colorMenu.querySelectorAll('.color-swatch').forEach((b) =>
  b.addEventListener('click', () => {
    const tr = state.tracks[colorTargetIdx];
    if (tr) { tr.color = b.dataset.c; draw(); renderSidebar(); }
    hideColorMenu();
  }));
window.addEventListener('pointerdown', (e) => {
  if (!colorMenu.contains(e.target) && !e.target.classList.contains('swatch-btn')) hideColorMenu();
});

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); hideColorMenu(); cancelPending(); closeVideoPanel(); } });
$('video-close').addEventListener('click', closeVideoPanel);
$('video-rotate').addEventListener('click', () => { videoRotation = nextRotation(videoRotation); applyVideoRotation(); });
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

// 艇セッティング/反省内容の日本語ラベル(キー順は reflections.js の *_FIELDS に従う)。
const RIG_LABELS = {
  boatNo: '船番号', gear: 'ギア', prebend: 'プリベンド', rake: 'レーキ',
  sideTension: 'サイドテンション', foreTension: 'フォアテンション', puller: 'プラー',
  peakRope: 'ピークロープ', bridleHeight: 'ブライダル高', jibLeader: 'ジブリーダー',
  jibPull: 'ジブ引き量', vangPull: 'バング引き量',
};
const NOTE_LABELS = {
  goal: '目標', issue: '感じている課題', discovery: '発見',
  slowFactor: '遅かった要因', fastFactor: '速かった要因',
};

// 保存フォルダの全練習ファイルを deserialize して {name, project}[] で返す(projectDir 前提)。
// ダッシュボードと進捗画面で共有。
async function loadProjectEntries() {
  if (!projectDir) return [];
  const files = await listProjectFiles(projectDir);
  const entries = [];
  for (const f of files) {
    try { entries.push({ name: f.name, project: deserializeProject(await readProject(projectDir, f.name)) }); }
    catch { /* 壊れたファイルはスキップ */ }
  }
  return entries;
}

// getTrack/getMarks: ダッシュボード表示時に現在読込中の最初の可視トラック/マークを渡す(風軸パネル用)。
const dashboard = createDashboard({
  rigLabels: RIG_LABELS,
  loadEntries: loadProjectEntries,
  getTrack: () => state.tracks.find((t) => t.visible) ?? null,
  getMarks: () => state.marks,
  getCrop: () => state.crop,
});

// 進捗画面: 保存済み全練習に加え、現在の未保存練習(取込直後の反省を含む)も渡す。
// 反省 id で重複排除するため、保存済みと現在練習が同一でも二重計上しない(progress.js 側)。
const progress = createProgress({
  loadEntries: async () => {
    const entries = await loadProjectEntries();
    if (state.reflections.length) {
      entries.push({ name: '(現在の練習・未保存)', project: { reflections: state.reflections } });
    }
    return entries;
  },
  // 進捗オーバーレイは保存フォルダの sailviz-progress.json に永続化(フォルダごとDrive同期で引継可)。
  // フォルダ未選択時は localStorage のみ。旧 localStorage データはファイルが空なら初回だけ移行。
  loadProgressData: async () => {
    const local = loadProgress();
    if (!projectDir) return local;
    const file = await readProgress(projectDir);
    if (!Object.keys(file).length && Object.keys(local).length) {
      await writeProgress(projectDir, local); // 初回移行
      return local;
    }
    return file;
  },
  saveProgressData: async (obj) => {
    saveProgress(obj); // localStorage ミラー(フォルダ未選択/書込失敗の保険)
    if (projectDir) await writeProgress(projectDir, obj);
  },
});

// VMGキャッシュをクリアして無効化。トラック変更時に呼ぶ。
function invalidateVmgCache() {
  state.vmgLegs = []; state.vmgHighlightsAll = []; state.vmgColors = {};
  state.vmgWindSeries = []; state.vmgHighlights = [];
}

// ================= VMG比較 =================
// VMGパネル: DOM-less なテスト環境等で要素が無い場合に備え null ガード。
const vmgPanelEl = $('vmg-panel');
const vmgPanel = vmgPanelEl ? createVmgPanel({ mount: vmgPanelEl }) : null;

const setVmgSectionVisible = (show) => { const el = document.getElementById('vmg-section'); if (el) el.classList.toggle('hidden', !show); };

// 高コスト解析（crop非依存）。トグルON時・トラック変更時に1回だけ実行。
function recomputeVmgFull() {
  if (!state.vmgEnabled) return;
  if (state.mode !== 'absolute') {
    state.vmgHighlights = [];
    if (vmgPanel) vmgPanel.render([], [], { colors: {} });
    // elapsed モード通知
    if (vmgPanelEl) vmgPanelEl.querySelector('.vmg-mode-notice')?.remove();
    if (vmgPanelEl) {
      const notice = document.createElement('p');
      notice.className = 'vmg-mode-notice';
      notice.textContent = '絶対時刻モードでのみVMG比較できます';
      vmgPanelEl.prepend(notice);
    }
    setVmgSectionVisible(false); return;
  }
  // elapsed モード通知を消す
  if (vmgPanelEl) vmgPanelEl.querySelector('.vmg-mode-notice')?.remove();

  const visibleTracks = state.tracks.filter((t) => t.visible);
  if (visibleTracks.length === 0) {
    state.vmgHighlights = [];
    state.vmgLegs = []; state.vmgHighlightsAll = []; state.vmgColors = {}; state.vmgWindSeries = [];
    if (vmgPanel) vmgPanel.render([], [], { colors: {} });
    setVmgSectionVisible(false); return;
  }
  let windSeries;
  try {
    windSeries = unifyWindAxis(visibleTracks, { estimator: estimateWindAxisSeries, marks: state.marks });
  } catch {
    windSeries = [];
  }
  state.vmgWindSeries = windSeries;
  if (windSeries.length === 0) {
    state.vmgHighlights = [];
    state.vmgLegs = []; state.vmgHighlightsAll = []; state.vmgColors = {};
    if (vmgPanel) vmgPanel.render([], [], { colors: {} });
    setVmgSectionVisible(false); return;
  }
  const colors = Object.fromEntries(visibleTracks.map((t) => [t.id, t.color]));
  const { perBoatLegVmg, highlights, ranks } = analyzeFleetVmg(visibleTracks, windSeries, {});
  state.vmgLegs = perBoatLegVmg;
  state.vmgHighlightsAll = highlights;
  state.vmgColors = colors;
  state.vmgHighlights = highlights;
  if (vmgPanel) vmgPanel.render(perBoatLegVmg, ranks, { colors });
  setVmgSectionVisible(true);
}

// 安価なクロップ再ウィンドウ（drag中に呼ばれる）。高コスト再解析はしない。
function recomputeVmgCrop() {
  if (!state.vmgEnabled || state.vmgLegs.length === 0) return;
  const ranks = rankVmg(state.vmgLegs, {
    from: state.crop.start, to: state.crop.end, highlights: state.vmgHighlightsAll,
  });
  if (vmgPanel) vmgPanel.render(state.vmgLegs, ranks, { colors: state.vmgColors });
}

// VMG勝ちレグの地図ハイライト（VMG強調ボタン）は、風軸横の🏆VMGチェックボックス
// (vmg-minute-toggle) で代替されたため撤去。state.vmgEnabled は常に false のまま。

// 反省エディタの艇セッティング(数値12項目)と反省内容(テキスト5項目)を動的生成。
(function buildReflFields() {
  $('refl-rig').innerHTML = RIG_FIELDS.map((f) =>
    `<label>${RIG_LABELS[f]}<input id="rig-${f}" type="number" step="any" inputmode="decimal" /></label>`).join('');
  $('refl-notes').innerHTML = NOTE_FIELDS.map((f) =>
    `<label class="refl-note">${NOTE_LABELS[f]}<textarea id="note-${f}" rows="2"></textarea></label>`).join('');
})();

function setRigInputs(rig) {
  for (const f of RIG_FIELDS) $(`rig-${f}`).value = rig?.[f] ?? '';
}
function getRigInputs() {
  const out = {};
  for (const f of RIG_FIELDS) out[f] = $(`rig-${f}`).value;
  return out;
}
function setNotesInputs(notes) {
  for (const f of NOTE_FIELDS) $(`note-${f}`).value = notes?.[f] ?? '';
}
function getNotesInputs() {
  const out = {};
  for (const f of NOTE_FIELDS) out[f] = $(`note-${f}`).value;
  return out;
}

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
  // エディタ表示でステージが縮む → canvasバッファは再計算(潰れ防止)。ただし pan/zoom は保持(全体に戻さない)。
  resizeCanvas(); draw();
  hideMention();
  $('refl-text').focus();

  if (existing) {
    // 編集: 保存済みの艇セッティング/波高/反省内容を復元。
    setRigInputs(existing.rig);
    setNotesInputs(existing.notes);
    $('refl-waveHeight').value = existing.waveHeight ?? '';
  } else {
    // 新規: 直前の反省の艇セッティングを初期値にプリフィル(微調整だけで済む)。天候は引き継がない。
    setRigInputs(previousRig(state.reflections));
    setNotesInputs(null);
    $('refl-waveHeight').value = '';
  }

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
  // エディタを閉じるとステージが元の高さに戻る → canvasバッファは再計算。pan/zoom は保持(開く時と対称)。
  resizeCanvas(); draw();
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
  // 数値/テキストの正規化は createReflection に任せる(空欄→null 等)。
  const fields = {
    text, people, videos, wind,
    rig: getRigInputs(), waveHeight: $('refl-waveHeight').value, notes: getNotesInputs(),
  };

  if (editingId) {
    const idx = state.reflections.findIndex((r) => r.id === editingId);
    if (idx >= 0) {
      const prev = state.reflections[idx];
      state.reflections[idx] = createReflection({
        id: prev.id, createdAt: prev.createdAt, practice: prev.practice, ...fields,
      });
    }
  } else {
    state.reflections.push(createReflection({
      id: `refl${Date.now()}_${reflSeq++}`, createdAt: Date.now(),
      practice: practiceInfo(), ...fields,
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

// ================= 議事録一括インポート =================
let importRows = []; // [{ block, memberFullName|null, include }]

function openImportModal() {
  if (!firstVisibleTrack()) { statusEl.textContent = '先に練習(GPS)を読み込んでください'; return; }
  $('import-text').value = '';
  $('import-preview').innerHTML = '';
  $('import-wind').textContent = '';
  importRows = [];
  $('import-modal').classList.remove('hidden');
}
function closeImportModal() { $('import-modal').classList.add('hidden'); }

// テキストをパースしてプレビュー行を構築。
function rebuildImportPreview(text) {
  const roster = memberList();
  const blocks = parseMinutes(text);
  importRows = blocks.map((b) => {
    const { member } = matchMember(b.headerName, b.fullNameHint, roster);
    return { block: b, memberFullName: member?.fullName ?? null, include: true };
  });
  renderImportPreview(roster);
}

function renderImportPreview(roster = memberList()) {
  const el = $('import-preview');
  if (!importRows.length) { el.innerHTML = '<p>議事録を入力するとプレビューされます。</p>'; return; }
  const opts = (sel) => ['<option value="">(未割当)</option>']
    .concat(roster.map((m) => `<option value="${escapeHtml(m.fullName)}"${m.fullName === sel ? ' selected' : ''}>${escapeHtml(m.fullName)}</option>`)).join('');
  el.innerHTML = importRows.map((row, i) => {
    const b = row.block;
    return `<div class="import-row${row.memberFullName ? '' : ' unmatched'}">`
      + `<label><input type="checkbox" data-inc="${i}" ${row.include ? 'checked' : ''} /> 取込</label>`
      + `<span class="ir-head">${escapeHtml(b.headerName)}${b.fullNameHint ? '（' + escapeHtml(b.fullNameHint) + '）' : ''} →</span>`
      + `<select data-member="${i}">${opts(row.memberFullName)}</select>`
      + `<div class="ir-notes">目標: ${escapeHtml(b.goal || '—')}／課題: ${escapeHtml(b.issue || '—')}／発見: ${escapeHtml(b.discovery || '—')}</div>`
      + `</div>`;
  }).join('');
  el.querySelectorAll('select[data-member]').forEach((s) =>
    s.addEventListener('change', (e) => { importRows[+e.target.dataset.member].memberFullName = e.target.value || null; }));
  el.querySelectorAll('input[data-inc]').forEach((cb) =>
    cb.addEventListener('change', (e) => { importRows[+e.target.dataset.inc].include = e.target.checked; }));
}

// 取込実行: 練習の風を1回取得し、採用行を反省化して追加。
async function runImport() {
  const rows = importRows.filter((r) => r.include && r.memberFullName);
  if (!rows.length) { statusEl.textContent = '取込対象がありません(部員を割り当ててください)'; return; }
  const practice = practiceInfo();
  const target = firstVisibleTrack() ? nowAbsolute() : Date.now();
  const wind = await fetchWind(target) ?? await fetchWindFromCsv(target);
  for (const row of rows) {
    const b = row.block;
    state.reflections.push(createReflection({
      id: `refl${Date.now()}_${reflSeq++}`, createdAt: Date.now(),
      text: b.raw, people: [row.memberFullName], wind, practice,
      notes: { goal: b.goal, issue: b.issue, discovery: b.discovery },
    }));
  }
  persistReflections();
  renderReflectionList();
  closeImportModal();
  statusEl.textContent = `${rows.length}名分の反省を議事録から取込みました`;
}

$('reflection-import').addEventListener('click', openImportModal);
$('import-cancel').addEventListener('click', closeImportModal);
$('import-run').addEventListener('click', runImport);
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  $('import-text').value = text;
  rebuildImportPreview(text);
});
$('import-text').addEventListener('input', (e) => rebuildImportPreview(e.target.value));
// 反省内の各セクション(details)を展開/折りたたむとエディタ高さが変わりステージが伸縮する
// → canvasバッファは再計算(潰れ/伸び防止)。pan/zoom は保持(全体に戻さない)。
document.querySelectorAll('#reflection-editor .refl-section').forEach((d) =>
  d.addEventListener('toggle', () => { resizeCanvas(); draw(); }));
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

window.addEventListener('resize', () => { resizeCanvas(); recomputeView(); draw(); applyVideoRotation(); });
resizeCanvas();
draw();
renderReflectionList();
