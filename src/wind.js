// 気象庁アメダスの非公式JSON配信から、練習時間帯の風向・風速を取得する。
// エンドポイント: https://www.jma.go.jp/bosai/amedas/data/point/{地点}/{yyyyMMdd}_{HH}.json
//   HH は 3時間ブロックの開始時(00,03,...,21)。中身は10分値。
//   wind=[風速m/s, flag], windDirection=[1..16(16=北), flag]。
// 江の島最寄りの観測点=辻堂(46141)。非公式APIのため直近1〜2日分のみ。
// 取得失敗/範囲外は null を返し、UI側で手入力にフォールバックする。
export const AMEDAS_POINT = '46141';
export const AMEDAS_NAME = '辻堂';

// windDirection の整数(0=静穏, 1..16 を22.5°刻み, 16=北)を日本語16方位に。
export const DIR_NAMES = [
  '静穏', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '北',
];
export function windDirName(idx) {
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx <= 16
    ? DIR_NAMES[idx] : '不明';
}

// アメダスの16方位インデックス(1=北北東…16=北)を「風の吹いてくる向き」の度に変換。
// 0=静穏は方向なし(null)。16=北=0°。範囲外も null。
export function dirIdxToDeg(idx) {
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 1 || idx > 16) return null;
  return (idx % 16) * 22.5;
}

// epoch(ms) を Asia/Tokyo の {yyyy, MM, dd, HH, mm} に分解。
function jstParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour; // 一部環境で24時表記になる保険
  return { yyyy: p.year, MM: p.month, dd: p.day, HH: hour, mm: p.minute };
}

// 3時間ブロックの開始時(2桁文字列)を返す。10→'09', 23→'21'。
export function blockHour(hour) {
  const h = Number(hour);
  return String(Math.floor(h / 3) * 3).padStart(2, '0');
}

// epoch(ms) から取得すべきアメダスJSONのURLを組み立てる。
export function amedasUrl(ms, point = AMEDAS_POINT) {
  const { yyyy, MM, dd, HH } = jstParts(ms);
  return `https://www.jma.go.jp/bosai/amedas/data/point/${point}/${yyyy}${MM}${dd}_${blockHour(HH)}.json`;
}

// アメダスJSONのキー 'yyyyMMddHHmmss'(JST) を epoch(ms) に変換。
function keyToMs(key) {
  const s = String(key);
  // Asia/Tokyo(+09:00) のローカル時刻として解釈。
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T`
    + `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`;
  return Date.parse(iso);
}

// JSON(10分値の辞書)から targetMs に最も近く、風の値が有効なサンプルを選ぶ。
// 返り値: { speed, dirIdx, dirName, obsMs } / 該当なしは null。
export function parseWind(json, targetMs) {
  if (!json || typeof json !== 'object') return null;
  let best = null;
  for (const [key, entry] of Object.entries(json)) {
    const speed = entry?.wind?.[0];
    const dirIdx = entry?.windDirection?.[0];
    if (typeof speed !== 'number' || typeof dirIdx !== 'number') continue;
    const obsMs = keyToMs(key);
    if (Number.isNaN(obsMs)) continue;
    const diff = Math.abs(obsMs - targetMs);
    if (!best || diff < best.diff) best = { diff, speed, dirIdx, obsMs };
  }
  if (!best) return null;
  return { speed: best.speed, dirIdx: best.dirIdx, dirName: windDirName(best.dirIdx), obsMs: best.obsMs };
}

// targetMs 時点の風をアメダスから取得。fetch は注入可(テスト用)。
// 失敗時は null(UIは手入力にフォールバック)。
export async function fetchWind(targetMs, { fetch = globalThis.fetch, point = AMEDAS_POINT } = {}) {
  try {
    const res = await fetch(amedasUrl(targetMs, point));
    if (!res.ok) return null;
    const json = await res.json();
    const w = parseWind(json, targetMs);
    if (!w) return null;
    return {
      dir: w.dirName, dirIdx: w.dirIdx, speed: w.speed,
      source: 'amedas', station: AMEDAS_NAME, obsMs: w.obsMs,
    };
  } catch {
    return null;
  }
}
