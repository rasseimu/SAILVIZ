// app.js 向けの保存アダプタ。projectfs.js と同形だが dirHandle 不要(サーバー API 背後)。
import * as realApi from './api.js';

export function createStore(api) {
  let unlocked = false;
  return {
    listProjects: () => api.apiListProjects(),
    listSummaries: () => api.apiListSummaries(),
    // 練習は ID で読み書きする。新規だけ名前(採番済みのファイル名)を渡して作り、{ id, name } を受け取る。
    createProject: (name, obj) => api.apiCreateProject(name, obj),
    readProject: (id) => api.apiGetProject(id),
    writeProject: (id, obj) => api.apiPutProject(id, obj),
    deleteProject: (id) => api.apiDeleteProject(id),
    readProgress: () => api.apiGetOverlay('progress'),
    writeProgress: (obj) => api.apiPutOverlay('progress', obj),
    readRoadmap: () => api.apiGetOverlay('roadmap'),
    writeRoadmap: (obj) => api.apiPutOverlay('roadmap', obj),
    async refreshAuth() { unlocked = await api.apiAuthStatus(); return unlocked; },
    isUnlocked: () => unlocked,
    async unlock(pw) { unlocked = await api.apiUnlock(pw); return unlocked; },
    async lock() { await api.apiLock(); unlocked = false; },
    session: () => api.apiSession(),
    login: (user, pw) => api.apiLogin(user, pw),
    logout: () => api.apiLogout(),
    me: () => api.apiMe(),
  };
}

export const store = createStore(realApi);
