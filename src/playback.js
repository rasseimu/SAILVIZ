import { clamp } from './timeaxis.js';

// 再生クロック。onTick(now) を毎フレーム呼ぶ。now はグローバル時間(ms)。
export function createPlayback({ onTick }) {
  let now = 0;
  let range = { start: 0, end: 0 };
  let speed = 1;
  let playing = false;
  let rafId = null;
  let lastTs = 0;

  function frame(ts) {
    if (!playing) return;
    const dt = ts - lastTs;
    lastTs = ts;
    now = clamp(now + dt * speed, range.start, range.end);
    onTick(now);
    if (now >= range.end) { pause(); return; }
    rafId = requestAnimationFrame(frame);
  }

  function play() {
    if (playing || range.end <= range.start) return;
    if (now >= range.end) now = range.start; // 末尾で押したら頭出し
    playing = true;
    lastTs = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function toggle() { playing ? pause() : play(); }
  function seek(t) { now = clamp(t, range.start, range.end); onTick(now); }
  function setSpeed(x) { speed = x; }
  function setRange(r) {
    range = r;
    now = clamp(now, range.start, range.end);
    onTick(now);
  }
  return {
    play, pause, toggle, seek, setSpeed, setRange,
    getNow: () => now,
    isPlaying: () => playing,
  };
}
