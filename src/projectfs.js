// 保存フォルダ直下の .sailviz.json の列挙・読み書き。
// FileSystemDirectoryHandle 互換を引数で受け取り、テストではフェイクを注入する。
const PROJECT_RE = /\.sailviz\.json$/i;

// Date → "sailviz-YYYYMMDD-HHMM.sailviz.json"。
// 練習の実データ時刻(UTC epoch)を JST で整形するため、Intl で Asia/Tokyo 固定。
// マシンのタイムゾーンに依らず、表示ラベル(summary/dashboard)と同じ日時になる。
export function projectFileName(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (type) => parts.find((p) => p.type === type).value;
  const stamp = `${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}`;
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

// 進捗オーバーレイ(課題ステージ・目標達成・テキスト上書き)を保存フォルダ直下に置く。
// 練習ファイル(*.sailviz.json)の命名にはマッチしないので listProjectFiles には出ない。
export const PROGRESS_FILE = 'sailviz-progress.json';

// 進捗ファイルを寛容に読む。無い/壊れている場合は {} を返す。
export async function readProgress(dirHandle) {
  try {
    const fh = await dirHandle.getFileHandle(PROGRESS_FILE);
    const file = await fh.getFile();
    const obj = JSON.parse(await file.text());
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export async function writeProgress(dirHandle, obj) {
  const fh = await dirHandle.getFileHandle(PROGRESS_FILE, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(obj));
  await writable.close();
}
