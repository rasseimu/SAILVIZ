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

export function drawScene(ctx, state) {
  const { transform: T, tracks, events, now, mode, crop } = state;
  ctx.clearRect(0, 0, T.w, T.h);
  if (!T.proj) return;

  // ポリライン
  for (const tr of tracks) {
    if (!tr.visible || tr.points.length < 2) continue;
    const win = trackWindow(tr, crop, mode);
    ctx.beginPath();
    let started = false;
    for (const p of tr.points) {
      if (p.t < win.lo || p.t > win.hi) { started = false; continue; }
      const s = toScreen(p.lat, p.lon, T);
      if (!started) { ctx.moveTo(s.px, s.py); started = true; }
      else ctx.lineTo(s.px, s.py);
    }
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 現在位置マーカー
  for (const tr of tracks) {
    if (!tr.visible) continue;
    const lookup = trackLookupTime(tr, now, mode);
    const pos = positionAt(tr.points, lookup);
    if (!pos) continue;
    const s = toScreen(pos.lat, pos.lon, T);
    ctx.beginPath();
    ctx.arc(s.px, s.py, 6, 0, Math.PI * 2);
    ctx.fillStyle = tr.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // タグピン（lat/lon があるものだけトラック上に表示）
  for (const ev of events) {
    if (ev.lat == null || ev.lon == null) continue;
    const s = toScreen(ev.lat, ev.lon, T);
    ctx.beginPath();
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(s.px - 6, s.py - 14);
    ctx.lineTo(s.px + 6, s.py - 14);
    ctx.closePath();
    ctx.fillStyle = '#c0392b';
    ctx.fill();
  }
}
