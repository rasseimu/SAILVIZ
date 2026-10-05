// server/repos/fileRepo.js
// 保存の窓口(リポジトリ層)のファイル実装。storage.js の IO 関数を dataDir 束縛の
// メソッドとして包む。createApi はこの形のオブジェクトだけを使い、保存先(ファイル／DB)を
// 知らない。Phase 1 で同じメソッドを持つ DB 実装に差し替え、STORAGE=file|db で切り替える。
// バリデータ(isValid*/OVERLAY_NAMES)は保存先に依らない純ロジックなので storage.js から直接使う。
import {
  listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay,
  saveUpload, readUpload, renameUpload,
  findReflectionByDate, findProjectByPracticeDate,
} from '../storage.js';

export function createFileRepo(dataDir) {
  return {
    listProjects: () => listProjects(dataDir),
    readProject: (name) => readProject(dataDir, name),
    writeProject: (name, obj) => writeProject(dataDir, name, obj),
    deleteProject: (name) => deleteProject(dataDir, name),
    readOverlay: (name) => readOverlay(dataDir, name),
    writeOverlay: (name, obj) => writeOverlay(dataDir, name, obj),
    saveUpload: (importId, filename, text) => saveUpload(dataDir, importId, filename, text),
    readUpload: (importId, filename) => readUpload(dataDir, importId, filename),
    renameUpload: (importId, from, to) => renameUpload(dataDir, importId, from, to),
    findReflectionByDate: (person, practiceDate) => findReflectionByDate(dataDir, person, practiceDate),
    findProjectByPracticeDate: (practiceDate) => findProjectByPracticeDate(dataDir, practiceDate),
  };
}
