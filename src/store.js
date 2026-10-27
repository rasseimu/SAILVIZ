// app.js 向けの保存アダプタ。projectfs.js と同形だが dirHandle 不要(サーバー API 背後)。
import * as realApi from './api.js';

export function createStore(api) {
  let unlocked = false;
  return {
    listProjects: () => api.apiListProjects(),
    listSummaries: () => api.apiListSummaries(),
    listReflections: () => api.apiListReflections(),
    // 練習は ID で読み書きする。新規だけ名前(採番済みのファイル名)を渡して作り、{ id, name } を受け取る。
    createProject: (name, obj) => api.apiCreateProject(name, obj),
    readProject: (id) => api.apiGetProject(id),
    writeProject: (id, obj) => api.apiPutProject(id, obj),
    deleteProject: (id) => api.apiDeleteProject(id),
    // 動画一覧だけの読み・追記(練習全体の PUT を使わない)。
    readProjectVideos: (id) => api.apiGetProjectVideos(id),
    appendProjectVideos: (id, videos) => api.apiAppendProjectVideos(id, videos),
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
    // ランディングのログイン: 部内共有のログインを先に試し、だめでメールアドレスの形ならアカウントで試す。
    // 戻り値 { ok, kind: 'shared' | 'account', error }。共有ログインが無効なサーバーは共有ログインを 401 で断る。
    async loginAny(id, pw) {
      const shared = await api.apiLogin(id, pw);
      if (shared.ok) return { ok: true, kind: 'shared' };
      if (!String(id).includes('@')) return { ok: false, error: shared.error };
      const account = await api.apiAccountLogin(id, pw);
      return account.ok ? { ok: true, kind: 'account' } : { ok: false, error: account.error };
    },
    // 共有ログインとアカウントのセッションの両方を失効させる。片方が失敗しても他方は呼ぶ。
    // 共有ログアウトの失敗は従来どおり呼び出し側へ投げる。
    async logout() {
      const [shared] = await Promise.allSettled([api.apiLogout(), api.apiAccountLogout()]);
      if (shared.status === 'rejected') throw shared.reason;
    },
    me: () => api.apiMe(),
  };
}

export const store = createStore(realApi);
