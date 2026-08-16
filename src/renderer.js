import { worldToScreen } from './viewport.js';
import { project } from './projection.js';
import { positionAt } from './interpolate.js';
import { trackLookupTime } from './timeaxis.js';

function toScreen(lat, lon, T) {
  return worldToScreen(project(lat, lon, T.proj), T);
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

export function drawScene(ctx, state) {
  const { transform: T, tracks, events, now, mode, crop, referenceTrack, marks = [], videos = [], activeVideoId = null } = state;
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
}
