import { parseMp4TimesFromFile, embeddedStartMs } from './videometa.js';
import { videoKey, pickRelinkFile } from './videolink.js';

// 動画として扱う拡張子(③のプロ動画の一覧でも使う)。
export const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

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
// 返り値: { matched: [{file, t, durationMs}], scanned: 動画本数, skipped: 範囲外/時刻不明数,
//   entries: 走査した全動画 [{file, t, durationMs}](範囲外・時刻不明も含む。再リンクの候補に使う) }
export async function scanFolderVideos(dirHandle, range, readTimes = parseMp4TimesFromFile) {
  const matched = [];
  const entries = [];
  const skippedInfo = []; // 診断用: 各スキップ動画の理由と抽出時刻
  let scanned = 0;
  let noTime = 0;     // 埋め込み時刻が取れずスキップ
  let outOfRange = 0; // 時刻は取れたが GPS 範囲外でスキップ
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file' || !VIDEO_RE.test(entry.name)) continue;
    scanned++;
    const file = await entry.getFile();
    let meta = null;
    try { meta = await readTimes(file); } catch { /* パース失敗は時刻不明扱い */ }
    const t = embeddedStartMs(meta, file.name);
    const durationMs = meta?.durationMs ?? null;
    entries.push({ file, t, durationMs });
    if (videoOverlapsRange(t, durationMs, range)) {
      matched.push({ file, t, durationMs });
    } else if (t == null) {
      noTime++;
      skippedInfo.push({ name: file.name, reason: 'noTime', t: null, durationMs, apple: meta?.appleCreationMs ?? null });
    } else {
      outOfRange++;
      skippedInfo.push({ name: file.name, reason: 'outOfRange', t, durationMs, apple: meta?.appleCreationMs ?? null });
    }
  }
  return { matched, scanned, skipped: scanned - matched.length, noTime, outOfRange, skippedInfo, entries };
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

// ===== 練習動画フォルダ(<ルート>/<年>練習/<月日>)の探索 =====

// 年フォルダ名(例 `2026練習`)から年を返す。違えば null。全角数字も可。
export function parseYearFolder(name) {
  if (typeof name !== 'string') return null;
  const m = name.normalize('NFKC').trim().match(/^(\d{4})練習$/);
  return m ? Number(m[1]) : null;
}

// 月日フォルダ名(例 `8 27(木)`・`8:27`・`2 22日`・`8月27日`)の先頭から月と日を読む。違えば null。
// 区切りは空白・`:`・`/`・`月`。後ろの括弧・曜日・`日`・メモは無視する。全角(数字・コロン・空白)は NFKC で半角にする。
export function parseMonthDayFolder(name) {
  if (typeof name !== 'string') return null;
  const m = name.normalize('NFKC').match(/^\s*(\d{1,2})\s*(?:[\s:/]|月)\s*(\d{1,2})(?!\d)/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

async function childDirs(dirHandle) {
  const out = [];
  for await (const entry of dirHandle.values()) if (entry.kind === 'directory') out.push(entry);
  return out;
}

// 動画ルートから練習日の月日フォルダを探す。ルート直下の `<年>練習`、またはルート自体が `<年>練習` なら
// それを年フォルダにする。年フォルダ直下で月日が一致するフォルダを全部返す(孫は見ない)。
// 返り値 { status: 'ok' | 'noYear' | 'noDay', yearDirs, dayDirs }
export async function findPracticeDayFolders(root, { year, month, day }) {
  const yearDirs = parseYearFolder(root.name) === year
    ? [root]
    : (await childDirs(root)).filter((d) => parseYearFolder(d.name) === year);
  if (!yearDirs.length) return { status: 'noYear', yearDirs, dayDirs: [] };
  const dayDirs = [];
  for (const y of yearDirs) {
    for (const d of await childDirs(y)) {
      const md = parseMonthDayFolder(d.name);
      if (md && md.month === month && md.day === day) dayDirs.push(d);
    }
  }
  return { status: dayDirs.length ? 'ok' : 'noDay', yearDirs, dayDirs };
}

// ローカルファイルの見分け(サイズ + 更新時刻)。ドロップした File とフォルダから読んだ File は、
// 同じディスク上のファイルなら同じになる。どちらも無ければ null(見分けない)。
export function fileSignature(file) {
  if (!file || (file.size == null && file.lastModified == null)) return null;
  return `${file.size ?? ''}:${file.lastModified ?? ''}`;
}

// フォルダ走査の結果を、今の動画一覧(stateVideos。url が無いものは未リンク)にどう反映するかを決める。
// entries: 走査した全動画 [{file, t, durationMs}]、matched: そのうち GPS 範囲と重なるもの。
// - 再リンク: 未リンク動画ごとに同名ファイルを候補にする。その名前の未リンク動画が1本で候補も1つならそのまま
//   (旧来どおり)。それ以外は撮影時刻が t に最も近い(±2秒以内)1つ。同じファイルは2本につながない。
// - 新規: matched のうち、再リンクに使ったファイル・name + t が一覧にあるもの・matched 同士の重複を除く。
//   リンク済みの動画と同名で同じファイル(fileSig = fileSignature が一致)のものも除く
//   (ドロップで現在位置に置いた動画は t が撮影時刻と違うので、name + t だけでは二重に足してしまう)。
// 返り値 { relink: [{ video, file }], add: [{ file, t, durationMs }] }
export function planFolderImport({ stateVideos, entries, matched }) {
  const videos = Array.isArray(stateVideos) ? stateVideos : [];
  const all = Array.isArray(entries) ? entries : [];
  const unlinked = videos.filter((v) => !v.url);
  const unlinkedCount = new Map();
  for (const v of unlinked) unlinkedCount.set(v.name, (unlinkedCount.get(v.name) || 0) + 1);
  const used = new Set(); // 再リンクに使った File
  const relink = [];
  for (const v of unlinked) {
    const candidates = all.filter((e) => e.file.name === v.name && !used.has(e.file));
    const pick = unlinkedCount.get(v.name) === 1 && candidates.length === 1
      ? candidates[0]
      : pickRelinkFile(candidates, v.t);
    if (!pick) continue;
    used.add(pick.file);
    relink.push({ video: v, file: pick.file });
  }
  const keys = new Set(videos.map(videoKey));
  const linkedFiles = new Set(videos.filter((v) => v.url && v.fileSig != null).map((v) => JSON.stringify([v.name, v.fileSig])));
  const add = [];
  for (const m of Array.isArray(matched) ? matched : []) {
    if (used.has(m.file)) continue;
    const sig = fileSignature(m.file);
    if (sig != null && linkedFiles.has(JSON.stringify([m.file.name, sig]))) continue;
    const key = videoKey({ name: m.file.name, t: m.t });
    if (keys.has(key)) continue;
    keys.add(key);
    add.push({ file: m.file, t: m.t, durationMs: m.durationMs ?? null });
  }
  return { relink, add };
}
