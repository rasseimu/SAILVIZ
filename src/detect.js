// ヘッダー列名からファイル種別を判定する。
// タグ判定を先に置く: タグCSVは latitude/longitude+time を持ち得る（parseTags が対応）ため、
// GPS三つ組を先に見ると そのようなタグCSVを GPS と誤判定してしまう。tag を確実に示すのは
// label / start&end のみなので、それらを優先する。
export function detectType(header) {
  const h = new Set(header.map((c) => c.toLowerCase()));
  if (h.has('label') || (h.has('start') && h.has('end'))) return 'tag';
  if (h.has('time') && h.has('latitude') && h.has('longitude')) return 'gps';
  return 'unknown';
}
