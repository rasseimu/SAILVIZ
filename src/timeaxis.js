export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 可視トラックのグローバル時間範囲。absolute=絶対時刻, elapsed=0起点の経過。
export function globalRange(tracks, mode) {
  const visible = tracks.filter((t) => t.visible);
  if (visible.length === 0) return { start: 0, end: 0 };
  if (mode === 'elapsed') {
    const maxDur = Math.max(...visible.map((t) => t.tRange.end - t.tRange.start));
    return { start: 0, end: maxDur };
  }
  return {
    start: Math.min(...visible.map((t) => t.tRange.start)),
    end: Math.max(...visible.map((t) => t.tRange.end)),
  };
}

// トラックの点列を引くための絶対時刻に変換。
export function trackLookupTime(track, now, mode) {
  return mode === 'elapsed' ? track.tRange.start + now : now;
}

// タイムライン軸に合わせてイベント時刻を変換。
// absolute: 絶対epoch のまま。elapsed: base(基準トラック開始)を引いて0起点に。
export function remapEventsToAxis(events, mode, base) {
  if (mode !== 'elapsed') return events;
  return events.map((e) => ({
    ...e,
    t: e.t - base,
    tEnd: e.tEnd == null ? null : e.tEnd - base,
  }));
}
