import { worldToScreen } from './viewport.js';
import { project } from './projection.js';
import { positionAt, speedAt, positionOnTracksAt } from './interpolate.js';
import { trackLookupTime } from './timeaxis.js';

function toScreen(lat, lon, T) {
  return worldToScreen(project(lat, lon, T.proj), T);
}

// vmgHighlights の boatId から対象トラックを引く（純関数）。
export function trackForHighlight(tracks, boatId) {
  return tracks.find((t) => t.id === boatId) || null;
}

// crop(グローバル時間)を各トラックの絶対時刻窓に変換
function trackWindow(track, crop, mode) {
  if (mode === 'elapsed') {
    return { lo: track.tRange.start + crop.start, hi: track.tRange.start + crop.end };
  }
  return { lo: crop.start, hi: crop.end };
}

// 背景地図(合成済みラスタ)を軌跡の下敷きに敷く。被覆boundsの矩形を project→screen で
// 平行四辺形に写し、その基底ベクトルから画像px→画面のアフィン変換を作って貼る。
// これでパン・ズーム・回転に軌跡と完全追従する。未ロード/未設定なら何もしない。
function drawBasemap(ctx, basemap, T) {
  const img = basemap && basemap.img;
  if (!img || !img.complete || !img.naturalWidth) return;
  const b = basemap.bounds;
  const tl = toScreen(b.maxLat, b.minLon, T); // 画像左上 = 高緯度・小経度
  const tr = toScreen(b.maxLat, b.maxLon, T); // 右上
  const bl = toScreen(b.minLat, b.minLon, T); // 左下
  const iw = img.naturalWidth, ih = img.naturalHeight;
  // origin=tl, u軸(画像右方向)=(tr-tl)/iw, v軸(画像下方向)=(bl-tl)/ih
  const a = (tr.px - tl.px) / iw, bcoef = (tr.py - tl.py) / iw;
  const c = (bl.px - tl.px) / ih, d = (bl.py - tl.py) / ih;
  ctx.save();
  ctx.setTransform(a, bcoef, c, d, tl.px, tl.py);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// 地理院タイル利用時の帰属表示(右下・小さく)。
function drawAttribution(ctx, T) {
  const txt = '地理院タイル';
  ctx.save();
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(txt).width;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillRect(T.w - w - 8, T.h - 15, w + 8, 15);
  ctx.fillStyle = '#333';
  ctx.fillText(txt, T.w - 4, T.h - 3);
  ctx.restore();
}

// 点列を折れ線で描く。include(p) が真の点だけを繋ぐ(偽の点で線を切る)。
function strokePolyline(ctx, points, T, include) {
  ctx.beginPath();
  let started = false;
  for (const p of points) {
    if (include && !include(p)) { started = false; continue; }
    const s = toScreen(p.lat, p.lon, T);
    if (!started) { ctx.moveTo(s.px, s.py); started = true; }
    else ctx.lineTo(s.px, s.py);
  }
  ctx.stroke();
}

// コースマーク(回航ブイ等)。クリック地点中心に 三角/丸 を塗り＋濃い輪郭で描く。
function drawMark(ctx, s, mark) {
  ctx.beginPath();
  if (mark.shape === 'triangle') {
    ctx.moveTo(s.px, s.py - 11);
    ctx.lineTo(s.px - 10, s.py + 7);
    ctx.lineTo(s.px + 10, s.py + 7);
    ctx.closePath();
  } else {
    ctx.arc(s.px, s.py, 8, 0, Math.PI * 2);
  }
  ctx.fillStyle = mark.color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#12283a';
  ctx.stroke();
}

// 動画バッジ。開始時刻に当たる軌跡点へ 角丸矩形＋白い▶ を描く(クリックで再生)。
function drawVideoBadge(ctx, s, active = false) {
  const w = 22, h = 16, r = 4;
  const x = s.px - w / 2, y = s.py - h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = active ? '#e67e22' : '#0d3b5e'; // 再生中の動画はオレンジ
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  // 白い再生三角
  ctx.beginPath();
  ctx.moveTo(s.px - 3, s.py - 4);
  ctx.lineTo(s.px - 3, s.py + 4);
  ctx.lineTo(s.px + 5, s.py);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
}

// 現在地マーカー横の速度ラベル。白縁取り＋トラック色で明暗どちらの水面でも読める。
function drawSpeedLabel(ctx, s, text, color) {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const x = s.px + 13, y = s.py - 11;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// 1分ごとVMG勝者のネオンハイライトを1本描く。艇自身の色で、太い低透過グロー＋明るいコアの2パス。
// shadowBlur/shadowColor で発光させ、勝者トラック tr の [lo,hi] 区間だけを重ね描く。
// 勝者は track オブジェクト参照で特定する(idは艇間で重複しうるため使わない)。
function drawVmgNeon(ctx, tr, T, lo, hi) {
  if (!(hi > lo)) return;
  const include = (p) => p.t >= lo && p.t <= hi;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = tr.color;
  ctx.shadowColor = tr.color;
  // 外側グロー(太・低透過・強ブラー)
  ctx.shadowBlur = 16;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 10;
  strokePolyline(ctx, tr.points, T, include);
  // 内側コア(細・高透過・弱ブラー)
  ctx.shadowBlur = 8;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 3;
  strokePolyline(ctx, tr.points, T, include);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

export function drawScene(ctx, state) {
  const { transform: T, tracks, events, now, mode, crop, referenceTrack, marks = [], videos = [], activeVideoId = null, vmgWinners = [], basemap = null } = state;
  ctx.clearRect(0, 0, T.w, T.h);
  if (!T.proj) return;

  // 背景地図があれば、まずキャンバス全体を画像の海の色で塗る。これで回転隅や地図外も
  // 白ではなく海色になり、軌跡が通る場所は常に背景を持つ。その上に地図画像→軌跡を重ねる。
  if (basemap && basemap.img && basemap.img.complete && basemap.img.naturalWidth) {
    ctx.fillStyle = basemap.seaColor || '#bfd3ff';
    ctx.fillRect(0, 0, T.w, T.h);
  }
  drawBasemap(ctx, basemap, T);

  // ポリライン: 範囲外は点線(文脈として残す)、範囲内は実線。重複描画しないので破線が隠れない。
  for (const tr of tracks) {
    if (!tr.visible || tr.points.length < 2) continue;
    const win = trackWindow(tr, crop, mode);
    const inWin = (p) => p.t >= win.lo && p.t <= win.hi;
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 4]);
    strokePolyline(ctx, tr.points, T, (p) => !inWin(p)); // 範囲外のみ点線
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    strokePolyline(ctx, tr.points, T, inWin); // 範囲内のみ実線
  }

  // VMGネオン: 実線ポリラインの上、マーク/現在地マーカーの下に勝者区間を発光表示。
  // 勝者区間は絶対epoch。各トラックの表示窓と交差させて実線区間に一致させる。
  // 勝者は w.track(オブジェクト参照)で特定(idは艇間で重複しうる)。
  for (const w of vmgWinners) {
    const tr = w.track;
    if (!tr || !tr.visible || tr.points.length < 2) continue;
    const win = trackWindow(tr, crop, mode);
    drawVmgNeon(ctx, tr, T, Math.max(win.lo, w.lo), Math.min(win.hi, w.hi));
  }

  // コースマーク(ポリラインの上・現在地マーカーの下)
  for (const mk of marks) {
    drawMark(ctx, toScreen(mk.lat, mk.lon, T), mk);
  }

  // 現在位置マーカー
  for (const tr of tracks) {
    if (!tr.visible) continue;
    const lookup = trackLookupTime(tr, now, mode);
    const pos = positionAt(tr.points, lookup);
    if (!pos) continue;
    const s = toScreen(pos.lat, pos.lon, T);
    // 現在地: 塗り(トラック色) + 白の内輪郭 + 黒の外輪郭で明暗どちらの背景でも目立たせる
    ctx.beginPath();
    ctx.arc(s.px, s.py, 9, 0, Math.PI * 2);
    ctx.fillStyle = tr.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.px, s.py, 10.5, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    // 現在の移動速度(m/s)をマーカー右上に表示。GPS(playhead)に同期。
    const speed = speedAt(tr.points, lookup);
    if (speed != null) drawSpeedLabel(ctx, s, `${speed.toFixed(1)} m/s`, tr.color);
  }

  // タグピン。lat/lon があればその座標に、無ければ基準トラックの絶対時刻位置を補間して配置。
  // (ev.t は絶対epoch ms、referenceTrack.points も絶対時刻なので lookup は ev.t をそのまま使う)
  for (const ev of events) {
    let lat = ev.lat;
    let lon = ev.lon;
    if (lat == null || lon == null) {
      const pos = positionOnTracksAt(tracks, referenceTrack, ev.t);
      if (!pos) continue;
      lat = pos.lat;
      lon = pos.lon;
    }
    const s = toScreen(lat, lon, T);
    ctx.beginPath();
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(s.px - 6, s.py - 14);
    ctx.lineTo(s.px + 6, s.py - 14);
    ctx.closePath();
    ctx.fillStyle = '#c0392b';
    ctx.fill();
  }

  // 動画バッジ。開始時刻(絶対epoch)を、その時刻を含むトラック(基準優先)で補間した位置に置く。
  // 午前・午後を別トラックで読み込んでも、各動画は該当する側のトラックに表示される。
  for (const v of videos) {
    const pos = positionOnTracksAt(tracks, referenceTrack, v.t);
    if (!pos) continue;
    drawVideoBadge(ctx, toScreen(pos.lat, pos.lon, T), v.id === activeVideoId);
  }

  // 帰属表示(背景地図があるときのみ・最前面)。
  if (basemap && basemap.img && basemap.img.complete && basemap.img.naturalWidth) {
    drawAttribution(ctx, T);
  }
}
