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

// JST(UTC+9, DST無し)の壁時計 'YYYY-MM-DDTHH:mm'(datetime-local 値) ⇄ 絶対ms。
// datetime-local はマシンローカルTZだが、アプリは Asia/Tokyo 固定表示のため
// 入力値を常に JST 壁時計として解釈する(マシンTZ非依存)。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstWallToMs(wall) {
  if (typeof wall !== 'string') return NaN;
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
}

export function msToJstWall(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
