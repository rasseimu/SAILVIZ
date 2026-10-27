// server/repos/fileRepo.js
// 保存の窓口(リポジトリ層)のファイル実装。storage.js の IO 関数を dataDir 束縛の
// メソッドとして包む。createApi はこの形のオブジェクトだけを使い、保存先(ファイル／DB)を
// 知らない。Phase 1 で同じメソッドを持つ DB 実装に差し替え、STORAGE=file|db で切り替える。
// バリデータ(isValid*/OVERLAY_NAMES)は保存先に依らない純ロジックなので storage.js から直接使う。
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isValidProjectName,
  listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay,
  saveUpload, readUpload, renameUpload,
  findReflectionByDate, findProjectByPracticeDate,
} from '../storage.js';
import { appendVideos } from '../../src/videolink.js';

// ファイル版の id はファイル名そのもの(id === name)。DB 版と同じ { id, name, label } の形にそろえる。
const item = (r) => (r ? { id: r.name, name: r.name, label: r.label } : null);

async function exists(dataDir, name) {
  try { await access(join(dataDir, 'projects', name)); return true; } catch { return false; }
}

const notFound = () => Object.assign(new Error('not found'), { code: 'not_found' });

export function createFileRepo(dataDir) {
  // 練習ファイルの書き込み(作成・全体の書き込み・動画の追記)は練習 ID ごとに直列にする
  // (同時の追記や全体の書き込みで読み→足し→書きが重なり、片方が消えないように)。
  const videoQueues = new Map();
  const serial = (id, fn) => {
    const run = (videoQueues.get(id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    videoQueues.set(id, tail);
    tail.then(() => { if (videoQueues.get(id) === tail) videoQueues.delete(id); });
    return run;
  };
  return {
    listProjects: async () => (await listProjects(dataDir)).map(item),
    readProject: (id) => readProject(dataDir, id),
    // 既存ファイルだけを更新する。無ければ code: 'not_found'(新規は createProject)。opts は無視。
    // 動画の追記と同じ列で直列にする(追記の読む→足す→書くの間に全体の書き込みが割り込まないように)。
    writeProject(id, obj) {
      return serial(id, async () => {
        if (!isValidProjectName(id)) throw new Error('invalid name');
        if (!(await exists(dataDir, id))) {
          const err = new Error('not found');
          err.code = 'not_found';
          throw err;
        }
        await writeProject(dataDir, id, obj);
      });
    },
    // 新規作成。name がそのまま id。同名ファイルがあれば code: 'exists'。orgId などは無視。
    createProject(obj, { name } = {}) {
      return serial(name, async () => {
        if (!isValidProjectName(name)) throw new Error('invalid name');
        if (await exists(dataDir, name)) {
          const err = new Error('exists');
          err.code = 'exists';
          throw err;
        }
        await writeProject(dataDir, name, obj);
        return { id: name, name };
      });
    },
    // 削除の直前に一時保管へ書き出す中身(保存 JSON そのもの)。無ければ null。
    async exportForTrash(id) {
      if (!isValidProjectName(id) || !(await exists(dataDir, id))) return null;
      return { name: id, data: { project: await readProject(dataDir, id) } };
    },
    deleteProject: (id) => deleteProject(dataDir, id),
    // 練習の動画一覧だけ。無ければ code: 'not_found'。
    async readVideos(id) {
      if (!isValidProjectName(id) || !(await exists(dataDir, id))) throw notFound();
      const proj = await readProject(dataDir, id);
      return Array.isArray(proj.videos) ? proj.videos : [];
    },
    // 動画だけを追記する(name + t が未登録のものだけ。他の項目は読んだまま書き戻す)。足したときだけ書く。
    // 無ければ code: 'not_found'。返り値 { videos, added }。
    appendVideos(id, entries) {
      return serial(id, async () => {
        if (!isValidProjectName(id) || !(await exists(dataDir, id))) throw notFound();
        const proj = await readProject(dataDir, id);
        const res = appendVideos(proj.videos, entries);
        if (res.added > 0) await writeProject(dataDir, id, { ...proj, videos: res.videos });
        return res;
      });
    },
    // opts({ orgId, scopeOrgId })はファイル版では組織を持たないので無視する。
    readOverlay: (name) => readOverlay(dataDir, name),
    writeOverlay: (name, obj) => writeOverlay(dataDir, name, obj),
    saveUpload: (importId, filename, text) => saveUpload(dataDir, importId, filename, text),
    readUpload: (importId, filename) => readUpload(dataDir, importId, filename),
    renameUpload: (importId, from, to) => renameUpload(dataDir, importId, from, to),
    findReflectionByDate: async (person, practiceDate) => item(await findReflectionByDate(dataDir, person, practiceDate)),
    findProjectByPracticeDate: async (practiceDate) => item(await findProjectByPracticeDate(dataDir, practiceDate)),
  };
}
