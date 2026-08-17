// 保存フォルダ直下の .sailviz.json の列挙・読み書き。
// FileSystemDirectoryHandle 互換を引数で受け取り、テストではフェイクを注入する。
const PROJECT_RE = /\.sailviz\.json$/i;

const pad = (n) => String(n).padStart(2, '0');

// Date → "sailviz-YYYYMMDD-HHMM.sailviz.json"
export function projectFileName(date) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `sailviz-${stamp}.sailviz.json`;
}

// ファイル名 → 読みやすい日時。合致しなければ名前をそのまま返す。
export function projectLabel(name) {
  const m = name.match(/sailviz-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return name;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

// dirHandle 直下の .sailviz.json を新しい順(名前降順=タイムスタンプ降順)で列挙。
export async function listProjectFiles(dirHandle) {
  const names = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && PROJECT_RE.test(entry.name)) names.push(entry.name);
  }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return names.map((name) => ({ name, label: projectLabel(name) }));
}

export async function readProject(dirHandle, name) {
  const fh = await dirHandle.getFileHandle(name);
  const file = await fh.getFile();
  return JSON.parse(await file.text());
}

export async function writeProject(dirHandle, name, obj) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(obj));
  await writable.close();
}
