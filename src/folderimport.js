import { parseMp4TimesFromFile, embeddedStartMs } from './videometa.js';

const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

// 動画の録画区間が GPS 範囲と重なるか。
// startMs: 録画開始(絶対ms)。null(時刻不明)なら常に false。
// durationMs: 長さ。null なら「開始が範囲内か」で判定。
export function videoOverlapsRange(startMs, durationMs, range) {
  if (startMs == null) return false;
  if (durationMs == null) return startMs >= range.start && startMs <= range.end;
  return startMs <= range.end && startMs + durationMs >= range.start;
}

// FileSystemDirectoryHandle 直下の動画を走査し、GPS 範囲と重なるものを返す。
// readTimes は埋め込み時刻リーダ(既定 parseMp4TimesFromFile)。テスト時に注入する。
// 返り値: { matched: [{file, t, durationMs}], scanned: 動画本数, skipped: 範囲外/時刻不明数 }
export async function scanFolderVideos(dirHandle, range, readTimes = parseMp4TimesFromFile) {
  const matched = [];
  let scanned = 0;
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file' || !VIDEO_RE.test(entry.name)) continue;
    scanned++;
    const file = await entry.getFile();
    let meta = null;
    try { meta = await readTimes(file); } catch { /* パース失敗は時刻不明扱い */ }
    const t = embeddedStartMs(meta);
    if (videoOverlapsRange(t, meta?.durationMs ?? null, range)) {
      matched.push({ file, t, durationMs: meta?.durationMs ?? null });
    }
  }
  return { matched, scanned, skipped: scanned - matched.length };
}

// dirHandle 直下のファイルのうち、名前が nameSet に含まれるものを収集して
// Map<name, File> で返す。blob URL 生成はしない(呼び出し側で createObjectURL)。
export async function collectVideoFiles(dirHandle, nameSet) {
  const map = new Map();
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && nameSet.has(entry.name)) {
      map.set(entry.name, await entry.getFile());
    }
  }
  return map;
}
