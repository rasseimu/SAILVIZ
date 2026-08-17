import { clamp } from './timeaxis.js';

const HANDLE_PX = 8;
const LONG_PRESS_MS = 400;

// crop全体をdeltaTだけ平行移動。幅を保持し、range内にクランプ。
export function moveCropRange(crop, deltaT, range) {
  const width = crop.end - crop.start;
  const start = clamp(crop.start + deltaT, range.start, range.end - width);
  return { start, end: start + width };
}

// crop開始をstartTへ移動。幅を保持し、range内にクランプ。
export function cropStartTo(crop, startT, range) {
  const width = crop.end - crop.start;
  const start = clamp(startT, range.start, range.end - width);
  return { start, end: start + width };
}

// px空間で最も近いピンのindex。tol以内になければ-1。
export function pinHitIndex(pinXs, x, tol) {
  let best = -1, bd = tol;
  for (let i = 0; i < pinXs.length; i++) {
    const d = Math.abs(pinXs[i] - x);
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

export function createTimeline(canvas, { onCropChange, onScrub, onPinAdd, onPinRemove }) {
  const ctx = canvas.getContext('2d');
  let state = { range: { start: 0, end: 0 }, crop: { start: 0, end: 0 }, now: 0, events: [], pins: [] };
  let drag = null; // 'left' | 'right' | 'scrub' | 'inside'
  let lastX = 0;
  let longPressTimer = null;
  let lpActive = false; // crop内側で長押し(400ms)が成立したか
  let moveAnchor = null; // { anchorT, crop } 平行移動の起点(長押し成立時にリセット)

  const tToX = (t) => {
    const { start, end } = state.range;
    const w = canvas.width;
    return end <= start ? 0 : ((t - start) / (end - start)) * w;
  };
  const xToT = (x) => {
    const { start, end } = state.range;
    return start + (x / canvas.width) * (end - start);
  };
  const pinXs = () => (state.pins || []).map(tToX);

  function render(next) {
    state = next;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // ベースライン
    ctx.fillStyle = '#c7d3dd';
    ctx.fillRect(0, h / 2 - 2, w, 4);
    // クロップ範囲(長押し成立中はオレンジで「掴んでいる」ことを示す)
    const xL = tToX(state.crop.start), xR = tToX(state.crop.end);
    ctx.fillStyle = lpActive ? 'rgba(230,126,34,0.30)' : 'rgba(28,114,184,0.25)';
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
    // ピン(右クリックで自由に刺す。クリックでcrop開始をここへ移動。紫の縦線＋頭)
    for (const p of state.pins || []) {
      const x = tToX(p);
      ctx.strokeStyle = '#8e44ad';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 3); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillStyle = '#8e44ad';
      ctx.beginPath();
      ctx.moveTo(x, 8); ctx.lineTo(x - 4, 1); ctx.lineTo(x + 4, 1);
      ctx.closePath(); ctx.fill();
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

  // 'left' | 'right' | 'pin' | 'inside' | 'scrub'
  function pickTarget(x) {
    if (Math.abs(x - tToX(state.crop.start)) <= HANDLE_PX) return 'left';
    if (Math.abs(x - tToX(state.crop.end)) <= HANDLE_PX) return 'right';
    if (pinHitIndex(pinXs(), x, HANDLE_PX) >= 0) return 'pin';
    if (x > tToX(state.crop.start) && x < tToX(state.crop.end)) return 'inside';
    return 'scrub';
  }
  function localX(e) {
    const rect = canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * canvas.width;
  }
  function clearLongPress() {
    if (longPressTimer != null) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const x = lastX = localX(e);
    const target = pickTarget(x);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* stale pointer */ }
    if (target === 'pin') {
      // ピンをクリック → crop開始をそのピンへ(幅は保持)
      const idx = pinHitIndex(pinXs(), x, HANDLE_PX);
      onCropChange(cropStartTo(state.crop, state.pins[idx], state.range));
      drag = null;
      return;
    }
    if (target === 'inside') {
      // crop内側: クリック=シーク / 即時ドラッグ=scrub / 長押し400ms成立後=移動+scrub併走。
      // 待機中の微動では成立を諦めず、400msで必ず移動モードを起動する。
      drag = 'inside';
      lpActive = false;
      moveAnchor = { anchorT: xToT(x), crop: { ...state.crop } };
      onScrub(clamp(xToT(x), state.crop.start, state.crop.end)); // クリックでシーク
      clearLongPress();
      longPressTimer = setTimeout(() => {
        if (drag !== 'inside') return;
        lpActive = true;
        moveAnchor = { anchorT: xToT(lastX), crop: { ...state.crop } }; // 現在位置を起点に(ジャンプ防止)
        canvas.style.cursor = 'grabbing';
        render(state); // 成立を即座に色で反映(移動前でも)
      }, LONG_PRESS_MS);
      return;
    }
    drag = target === 'left' || target === 'right' ? target : 'scrub';
    handleDrag(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = lastX = localX(e);
    if (drag === 'inside') {
      const t = xToT(x);
      if (lpActive) {
        // 平行移動 + scrub併走。先にcrop変更(=範囲更新)してからseekし、playheadを正確に追従。
        const moved = moveCropRange(moveAnchor.crop, t - moveAnchor.anchorT, state.range);
        onCropChange(moved);
        onScrub(clamp(t, moved.start, moved.end));
      } else {
        onScrub(clamp(t, state.crop.start, state.crop.end)); // 即時ドラッグはscrubのみ
      }
      return;
    }
    handleDrag(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    clearLongPress();
    const wasActive = lpActive;
    drag = null;
    lpActive = false;
    moveAnchor = null;
    canvas.style.cursor = '';
    if (wasActive) render(state); // 掴み解除で色を元に戻す
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const x = localX(e);
    const idx = pinHitIndex(pinXs(), x, HANDLE_PX);
    if (idx >= 0) onPinRemove?.(idx);
    else onPinAdd?.(clamp(xToT(x), state.range.start, state.range.end));
  });

  function handleDrag(e) {
    const t = clamp(xToT(localX(e)), state.range.start, state.range.end);
    if (drag === 'left') onCropChange({ start: Math.min(t, state.crop.end), end: state.crop.end });
    else if (drag === 'right') onCropChange({ start: state.crop.start, end: Math.max(t, state.crop.start) });
    else onScrub(clamp(t, state.crop.start, state.crop.end));
  }

  return { render };
}
