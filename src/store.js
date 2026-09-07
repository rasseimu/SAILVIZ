// app.js 向けの保存アダプタ。projectfs.js と同形だが dirHandle 不要(サーバー API 背後)。
import * as realApi from './api.js';

export function createStore(api) {
  let unlocked = false;
  return {
    listProjects: () => api.apiListProjects(),
    listSummaries: () => api.apiListSummaries(),
    readProject: (name) => api.apiGetProject(name),
    writeProject: (name, obj) => api.apiPutProject(name, obj),
    deleteProject: (name) => api.apiDeleteProject(name),
    readProgress: () => api.apiGetOverlay('progress'),
    writeProgress: (obj) => api.apiPutOverlay('progress', obj),
    readRoadmap: () => api.apiGetOverlay('roadmap'),
    writeRoadmap: (obj) => api.apiPutOverlay('roadmap', obj),
    async refreshAuth() { unlocked = await api.apiAuthStatus(); return unlocked; },
    isUnlocked: () => unlocked,
    async unlock(pw) { unlocked = await api.apiUnlock(pw); return unlocked; },
    async lock() { await api.apiLock(); unlocked = false; },
  };
}

export const store = createStore(realApi);
