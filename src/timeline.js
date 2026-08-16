import { clamp } from './timeaxis.js';

const HANDLE_PX = 8;

export function createTimeline(canvas, { onCropChange, onScrub }) {
  const ctx = canvas.getContext('2d');
  let state = { range: { start: 0, end: 0 }, crop: { start: 0, end: 0 }, now: 0, events: [] };
  let drag = null; // 'left' | 'right' | 'scrub'

  const tToX = (t) => {
    const { start, end } = state.range;
    const w = canvas.width;
    return end <= start ? 0 : ((t - start) / (end - start)) * w;
  };
  const xToT = (x) => {
    const { start, end } = state.range;
    return start + (x / canvas.width) * (end - start);
  };

  function render(next) {
    state = next;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // ベースライン
    ctx.fillStyle = '#c7d3dd';
    ctx.fillRect(0, h / 2 - 2, w, 4);
    // クロップ範囲
    const xL = tToX(state.crop.start), xR = tToX(state.crop.end);
    ctx.fillStyle = 'rgba(28,114,184,0.25)';
    ctx.fillRect(xL, 0, xR - xL, h);
    // タグ
    for (const ev of state.events) {
      if (ev.kind === 'range' && ev.tEnd != null) {
        ctx.fillStyle = 'rgba(192,57,43,0.35)';
        ctx.fillRect(tToX(ev.t), h - 10, tToX(ev.tEnd) - tToX(ev.t), 8);
      } else {
        const x = tToX(ev.t);
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.moveTo(x, h - 12); ctx.lineTo(x - 5, h - 2); ctx.lineTo(x + 5, h - 2);
        ctx.closePath(); ctx.fill();
      }
    }
    // ハンドル
    ctx.fillStyle = '#0d3b5e';
    ctx.fillRect(xL - 2, 0, 4, h);
    ctx.fillRect(xR - 2, 0, 4, h);
    // 動画範囲(上端の濃紺バー。動画バッジと同色で対応づけ。長さ不明なら▶ティック)
    for (const v of state.videos || []) {
      const x0 = tToX(v.t);
      ctx.fillStyle = '#0d3b5e';
      if (v.tEnd != null) ctx.fillRect(x0, 1, Math.max(2, tToX(v.tEnd) - x0), 6);
      else ctx.fillRect(x0 - 1, 1, 2, 6);
    }
    // 区間選択の始点プレビュー(終点クリック待ち)
    if (state.pending != null) {
      const xP = tToX(state.pending);
      ctx.strokeStyle = '#e6a817';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(xP, 0); ctx.lineTo(xP, h); ctx.stroke();
      ctx.setLineDash([]);
    }
    // playhead
    const xN = tToX(state.now);
    ctx.strokeStyle = '#e67e22';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xN, 0); ctx.lineTo(xN, h); ctx.stroke();
  }

  function pickTarget(x) {
    if (Math.abs(x - tToX(state.crop.start)) <= HANDLE_PX) return 'left';
    if (Math.abs(x - tToX(state.crop.end)) <= HANDLE_PX) return 'right';
    return 'scrub';
  }
  function localX(e) {
    const rect = canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * canvas.width;
  }
  canvas.addEventListener('pointerdown', (e) => {
    drag = pickTarget(localX(e));
    try { canvas.setPointerCapture(e.pointerId); } catch { /* stale pointer */ }
    handleDrag(e);
  });
  canvas.addEventListener('pointermove', (e) => { if (drag) handleDrag(e); });
  canvas.addEventListener('pointerup', (e) => {
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  });

  function handleDrag(e) {
    const t = clamp(xToT(localX(e)), state.range.start, state.range.end);
    if (drag === 'left') onCropChange({ start: Math.min(t, state.crop.end), end: state.crop.end });
    else if (drag === 'right') onCropChange({ start: state.crop.start, end: Math.max(t, state.crop.start) });
    else onScrub(clamp(t, state.crop.start, state.crop.end));
  }

  return { render };
}
