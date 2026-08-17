// AMEDAS 非公式APIで風が取れないとき(取得失敗/配信範囲外の過去日)の
// フォールバック。気象庁「過去の気象データ・ダウンロード」で辻堂を出力した
// 時別値CSV(Shift-JIS)を読み、目標時刻に最も近い風を返す。
// 列: 年月日時, 風速(m/s), 風速品質, 風向, 風向品質, 均質番号, 気温, ...
// 風向は日本語16方位テキスト(例: 北北東)で、wind.js の DIR_NAMES と一致する。
import { DIR_NAMES, windDirName } from './wind.js';

export const CSV_STATION = '辻堂';
export const DEFAULT_CSV_URL = 'sample-data/data.csv';
const DEFAULT_TOLERANCE_MS = 90 * 60 * 1000; // 時別値なので ±90分まで採用

// 日本語16方位テキストを AMEDAS の整数(0=静穏, 1..16, 16=北)へ逆引き。
// 該当なし(欠測記号 '×' や空)は null。
export function dirIdxFromName(name) {
  const idx = DIR_NAMES.indexOf(name);
  return idx >= 0 ? idx : null;
}

// "2025/1/1 1:00:00"(JST, 1桁月日時あり)を epoch(ms) に。失敗は NaN。
function csvDateToMs(s) {
  const m = String(s).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m;
  const p = (x) => String(x).padStart(2, '0');
  return Date.parse(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+09:00`);
}

// CSVテキストから風の観測行を抽出。ヘッダ行や欠測(風速が空/非数値)は除外。
// 返り値: [{ obsMs, speed, dirIdx, dirName }]
export function parseWindCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const cols = line.split(',');
    const obsMs = csvDateToMs(cols[0]);
    if (Number.isNaN(obsMs)) continue;          // ヘッダ・空行を飛ばす
    const speed = Number(cols[1]);
    if (cols[1] === '' || Number.isNaN(speed)) continue; // 欠測
    const dirIdx = dirIdxFromName((cols[3] ?? '').trim());
    rows.push({ obsMs, speed, dirIdx, dirName: dirIdx == null ? '不明' : windDirName(dirIdx) });
  }
  return rows;
}

// 目標時刻に最も近い行を選ぶ。許容差を超える/行が無ければ null。
// 返り値は fetchWind と同形: { dir, dirIdx, speed, source, station, obsMs }。
export function pickWindFromRows(rows, targetMs, { toleranceMs = DEFAULT_TOLERANCE_MS } = {}) {
  let best = null;
  for (const r of rows) {
    const diff = Math.abs(r.obsMs - targetMs);
    if (!best || diff < best.diff) best = { diff, row: r };
  }
  if (!best || best.diff > toleranceMs) return null;
  const r = best.row;
  return {
    dir: r.dirName, dirIdx: r.dirIdx, speed: r.speed,
    source: 'csv', station: CSV_STATION, obsMs: r.obsMs,
  };
}

// CSVを取得(Shift-JISデコード)し、targetMs 時点の風を返す。失敗時は null。
// パース結果はメモ化(14k行を毎回読まない)。fetch は注入可(テスト用)。
let cachedRows = null;
export async function fetchWindFromCsv(targetMs, { fetch = globalThis.fetch, url = DEFAULT_CSV_URL } = {}) {
  try {
    if (!cachedRows) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('shift_jis').decode(buf);
      cachedRows = parseWindCsv(text);
    }
    return pickWindFromRows(cachedRows, targetMs);
  } catch {
    return null;
  }
}
