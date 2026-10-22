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

// ファイル版の id はファイル名そのもの(id === name)。DB 版と同じ { id, name, label } の形にそろえる。
const item = (r) => (r ? { id: r.name, name: r.name, label: r.label } : null);

async function exists(dataDir, name) {
  try { await access(join(dataDir, 'projects', name)); return true; } catch { return false; }
}

export function createFileRepo(dataDir) {
  return {
    listProjects: async () => (await listProjects(dataDir)).map(item),
    readProject: (id) => readProject(dataDir, id),
    // 既存ファイルだけを更新する。無ければ code: 'not_found'(新規は createProject)。opts は無視。
    async writeProject(id, obj) {
      if (!isValidProjectName(id)) throw new Error('invalid name');
      if (!(await exists(dataDir, id))) {
        const err = new Error('not found');
        err.code = 'not_found';
        throw err;
      }
      await writeProject(dataDir, id, obj);
    },
    // 新規作成。name がそのまま id。同名ファイルがあれば code: 'exists'。orgId などは無視。
    async createProject(obj, { name } = {}) {
      if (!isValidProjectName(name)) throw new Error('invalid name');
      if (await exists(dataDir, name)) {
        const err = new Error('exists');
        err.code = 'exists';
        throw err;
      }
      await writeProject(dataDir, name, obj);
      return { id: name, name };
    },
    deleteProject: (id) => deleteProject(dataDir, id),
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
