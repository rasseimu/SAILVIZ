import { worldToScreen } from './viewport.js';
import { project } from './projection.js';
import { positionAt, speedAt } from './interpolate.js';
import { trackLookupTime } from './timeaxis.js';

function toScreen(lat, lon, T) {
  return worldToScreen(project(lat, lon, T.proj), T);
}

// vmgHighlights の boatId から対象トラックを引く（純関数）。
export function trackForHighlight(tracks, boatId) {
  return tracks.find((t) => t.id === boatId) || null;
}

// コンパス方位(度,北=0,時計回り)＋地図回転(rad)→画面上の単位ベクトル(px右,py下)。
// worldToScreen と整合: 北ベクトル(0,1)は rot=0 で上(0,-1)、rot=π/2 で右(1,0)。
export function compassScreenVector(bearingDeg, rotRad = 0) {
  const a = (bearingDeg * Math.PI) / 180 + rotRad;
  return { dx: Math.sin(a), dy: -Math.cos(a) };
}

// 右上の風軸インジケータ。windFromDeg=風が吹いてくる方位を指す矢印＋数値。
// null（推定不可）ならミュート表示。地図回転(T.rot)に追従。screen空間・最前面。
function drawWindIndicator(ctx, T, windFromDeg) {
  const cx = T.w - 46, cy = 46, r = 22;
  const rot = T.rot || 0;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#12283a';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (windFromDeg == null) {
    ctx.fillStyle = '#8a97a3';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillText('風軸', cx, cy - 4);
    ctx.fillText('推定不可', cx, cy + 6);
    return;
  }

  // 北ティック（地図回転に追従）
  const n = compassScreenVector(0, rot);
  ctx.fillStyle = '#c0392b';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillText('N', cx + n.dx * (r - 6), cy + n.dy * (r - 6));

  // 風向矢印（風が吹いてくる方位を指す）
  const v = compassScreenVector(windFromDeg, rot);
  const tipX = cx + v.dx * (r - 3), tipY = cy + v.dy * (r - 3);
  const tailX = cx - v.dx * (r - 8), tailY = cy - v.dy * (r - 8);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#0d3b5e';
  ctx.stroke();
  const ah = 6, ang = Math.atan2(v.dy, v.dx);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ah * Math.cos(ang - 0.4), tipY - ah * Math.sin(ang - 0.4));
  ctx.lineTo(tipX - ah * Math.cos(ang + 0.4), tipY - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fillStyle = '#0d3b5e';
  ctx.fill();

  // 数値ラベル（バッジ下・画面固定）
  ctx.fillStyle = '#12283a';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`風 ${Math.round(windFromDeg) % 360}°`, cx, cy + r + 3);
}

// crop(グローバル時間)を各トラックの絶対時刻窓に変換
function trackWindow(track, crop, mode) {
  if (mode === 'elapsed') {
    return { lo: track.tRange.start + crop.start, hi: track.tRange.start + crop.end };
  }
  return { lo: crop.start, hi: crop.end };
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

export function drawScene(ctx, state) {
  const { transform: T, tracks, events, now, mode, crop, referenceTrack, marks = [], videos = [], activeVideoId = null, windAxisNow = null } = state;
  ctx.clearRect(0, 0, T.w, T.h);
  if (!T.proj) return;

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

  // VMG勝ちレグのハイライト（既存線の上に太い低透明グローを艇色で重ねる）
  const vmgHighlights = state.vmgHighlights || [];
  for (const h of vmgHighlights) {
    const tr = trackForHighlight(tracks, h.boatId);
    if (!tr || !tr.visible) continue;
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 7;
    ctx.globalAlpha = 0.35;
    ctx.lineCap = 'round';
    strokePolyline(ctx, tr.points, T, (p) => p.t >= h.lo && p.t <= h.hi);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 2; // 太い7pxを後続描画へ漏らさない
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
      if (!referenceTrack) continue;
      const pos = positionAt(referenceTrack.points, ev.t);
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

  // 動画バッジ。開始時刻(絶対epoch)を基準トラックで補間した位置に置く。
  for (const v of videos) {
    if (!referenceTrack) continue;
    const pos = positionAt(referenceTrack.points, v.t);
    if (!pos) continue;
    drawVideoBadge(ctx, toScreen(pos.lat, pos.lon, T), v.id === activeVideoId);
  }

  // 風軸インジケータ（最前面・右上）。windAxisNow=現在時刻の推定風向(度) or null。
  drawWindIndicator(ctx, T, windAxisNow);
}
