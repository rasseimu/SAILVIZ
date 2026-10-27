// server/deletedData.js
// 削除した練習の一時保管(DATA_DIR/deleted_data_folder)。削除の直前に練習のデータを JSON で書き出し、
// 削除してから少なくとも1か月は残す: 削除した月の翌々月(日本時間)に入ったら片付ける(10月中の削除は 12/1 に消える)。
// ファイル名は「削除した日時(日本時間)_練習ID.json」。戻す画面は無い(必要なときは管理者がファイルから入れ直す)。
import { mkdir, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DELETED_DIR_NAME = 'deleted_data_folder';
const JST_MS = 9 * 60 * 60 * 1000;
const NAME_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_/;

// epoch ms → 日本時間の各部(UTC のメソッドで読む)。
const jstParts = (ms) => new Date(ms + JST_MS);
const pad = (n) => String(n).padStart(2, '0');
const monthIndex = (ms) => { const d = jstParts(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

export function deletedFileName(id, deletedAtMs) {
  const d = jstParts(deletedAtMs);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${stamp}_${String(id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_')}.json`;
}

// ファイル名の削除日時(epoch ms)。形が違う・ありえない日時なら null。
export function deletedAtFromName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - JST_MS;
  const back = jstParts(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return ms;
}

export const shouldPurge = (deletedAtMs, nowMs) => monthIndex(nowMs) - monthIndex(deletedAtMs) >= 2;

// 書き出して保存したファイル名を返す。書きかけを残さないよう一時ファイルに書いてから名前を変える。
// 失敗したら投げる(呼び出し側は削除しない)。
export async function saveDeleted(dir, { id, name = null, deletedBy = null, data }, nowMs = Date.now()) {
  await mkdir(dir, { recursive: true });
  const file = deletedFileName(id, nowMs);
  const tmp = join(dir, `.${file}.tmp`);
  const body = JSON.stringify({ id, name, deletedAt: new Date(nowMs).toISOString(), deletedBy, data });
  await writeFile(tmp, body);
  await rename(tmp, join(dir, file));
  return file;
}

// 少なくとも1か月たった分を消し、消したファイル名を返す。日時の読めないファイルは更新日時で判断する。
// フォルダが無ければ何もしない。1つ消せなくても残りは続ける。
export async function purgeDeleted(dir, nowMs = Date.now()) {
  let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const removed = [];
  for (const n of names) {
    const full = join(dir, n);
    try {
      let at = deletedAtFromName(n);
      if (at == null) {
        const s = await stat(full);
        if (!s.isFile()) continue;
        at = s.mtimeMs;
      }
      if (!shouldPurge(at, nowMs)) continue;
      await unlink(full);
      removed.push(n);
    } catch { /* 次の回にまた試す */ }
  }
  return removed;
}
