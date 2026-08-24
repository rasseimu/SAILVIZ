// 期間ブラシの座標↔時刻変換とクランプ(DOM非依存の純ヘルパ)。
export function msToX(ms, { min, max, width }) {
  const span = max - min;
  if (span <= 0) return 0;
  return ((ms - min) / span) * width;
}

export function xToMs(x, { min, max, width }) {
  if (width <= 0) return min;
  return min + (x / width) * (max - min);
}

export function clampRange({ from, to }, { min, max }) {
  const lo = Math.max(min, Math.min(from, to));
  const hi = Math.min(max, Math.max(from, to));
  return { from: lo, to: hi };
}
