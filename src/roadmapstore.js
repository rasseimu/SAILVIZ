// 部員別の目標ロードマップ(大目標＋順序付きマイルストーン)を localStorage に持つ軽量オーバーレイ。
// キー = 部員フルネーム。反省(真実源)とは別ストアにし、達成トグルで練習ファイルを書き戻さない。
// マイルストーンの順序 = 段階順。現在地(現在の段階)は「最初の未達」を指す(roadmapProgress)。
// id/ts は呼び出し側から注入し、純ロジックを決定論的にテストできるようにする(progressstore と同方針)。
export const STORAGE_KEY = 'sailviz.roadmap';

export function loadRoadmap(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveRoadmap(obj, storage = globalThis.localStorage) {
  storage?.setItem(STORAGE_KEY, JSON.stringify(obj));
  return obj;
}

// 部員エントリを {goal:'', milestones:[]} で補完して不変に取り出す。
function entryOf(obj, member) {
  const prev = obj[member] || { goal: '', milestones: [] };
  return { goal: '', milestones: [], ...prev };
}

// milestones を写像し直して不変更新するヘルパ。
function withMilestones(obj, member, milestones) {
  return { ...obj, [member]: { ...entryOf(obj, member), milestones } };
}

export function setGoal(obj, member, text) {
  return { ...obj, [member]: { ...entryOf(obj, member), goal: String(text) } };
}

export function addMilestone(obj, member, id, title) {
  const t = String(title).trim();
  if (t === '') return obj;
  const list = entryOf(obj, member).milestones;
  return withMilestones(obj, member, [...list, { id, title: t, done: false, doneAt: null }]);
}

export function renameMilestone(obj, member, id, title) {
  const t = String(title).trim();
  if (t === '') return obj;
  const list = entryOf(obj, member).milestones.map((m) => (m.id === id ? { ...m, title: t } : m));
  return withMilestones(obj, member, list);
}

export function removeMilestone(obj, member, id) {
  const list = entryOf(obj, member).milestones.filter((m) => m.id !== id);
  return withMilestones(obj, member, list);
}

export function moveMilestone(obj, member, id, dir) {
  const list = [...entryOf(obj, member).milestones];
  const i = list.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return obj;
  [list[i], list[j]] = [list[j], list[i]];
  return withMilestones(obj, member, list);
}

export function toggleMilestone(obj, member, id, done, ts) {
  const list = entryOf(obj, member).milestones.map((m) =>
    (m.id === id ? { ...m, done: !!done, doneAt: done ? ts : null } : m));
  return withMilestones(obj, member, list);
}

// 現在地 = 先頭からの「最初の未達」index。全達成なら total を指す(=末尾の先)。
// done は非連続でもよく、その場合も最初の未達を現在地とみなす。
export function roadmapProgress(milestones = []) {
  const total = milestones.length;
  const done = milestones.filter((m) => m.done).length;
  let currentIndex = milestones.findIndex((m) => !m.done);
  if (currentIndex === -1) currentIndex = total;
  return { total, done, currentIndex };
}

// ===== 保存フォルダ(FileSystemDirectoryHandle)への永続化 =====
// 進捗の sailviz-progress.json と同様に、フォルダ直下の JSON に置く。
// 練習ファイル(*.sailviz.json)の命名にはマッチしないので列挙には出ない。
export const ROADMAP_FILE = 'sailviz-roadmap.json';

// ロードマップファイルを寛容に読む。無い/壊れている場合は {} を返す。
export async function readRoadmapFile(dirHandle) {
  try {
    const fh = await dirHandle.getFileHandle(ROADMAP_FILE);
    const file = await fh.getFile();
    const obj = JSON.parse(await file.text());
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export async function writeRoadmapFile(dirHandle, obj) {
  const fh = await dirHandle.getFileHandle(ROADMAP_FILE, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(obj));
  await writable.close();
}
