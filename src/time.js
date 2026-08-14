// 入力(string|number)を epoch ms に正規化する。失敗時は NaN。
// - 桁の大きい数値(>1e15)は epoch ns とみなし /1e6
// - それ以外の数値は既に ms 相当としてそのまま
// - 文字列は上記数値判定 -> だめなら Date.parse(ISO想定)
export function parseTime(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return value > 1e15 ? value / 1e6 : value;
  }
  if (typeof value !== 'string') return NaN;
  const s = value.trim();
  if (s === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e15 ? n / 1e6 : n;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? NaN : parsed;
}
