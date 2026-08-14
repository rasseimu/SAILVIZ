// ヘッダー列名からファイル種別を判定する。
export function detectType(header) {
  const h = new Set(header.map((c) => c.toLowerCase()));
  if (h.has('label') || (h.has('start') && h.has('end'))) return 'tag';
  if (h.has('time') && h.has('latitude') && h.has('longitude')) return 'gps';
  return 'unknown';
}
