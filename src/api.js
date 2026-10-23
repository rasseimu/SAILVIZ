// バックエンド /api への薄い fetch ラッパ。書き込みは same-origin Cookie を送る。
// 表示中の組織(activeorg.js)があれば、すべての要求に X-Sailviz-Org を付ける。
import { getActiveOrgId, setActiveOrgId } from './activeorg.js';

const OPTS = { credentials: 'same-origin' };

// すべての fetch はここを通す。所属していない組織を指していた(403 org_forbidden)ら、
// 表示中の組織を消してから投げる(次の起動で /api/me の先頭に戻る)。
async function request(path, init = {}) {
  const orgId = getActiveOrgId();
  const headers = orgId ? { ...init.headers, 'X-Sailviz-Org': orgId } : init.headers;
  const res = await fetch(path, { ...OPTS, ...init, ...(headers ? { headers } : {}) });
  if (res.status === 403) {
    // 呼び出し側も本文を読むことがあるので、読めるなら複製を読む。
    const body = await (res.clone ? res.clone() : res).json().catch(() => null);
    if (body?.error === 'org_forbidden') {
      setActiveOrgId(null);
      throw new Error('表示中の組織に所属していません。読み込み直してください');
    }
  }
  return res;
}

async function getJson(path) {
  const res = await request(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function send(path, method, obj) {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: obj === undefined ? undefined : JSON.stringify(obj),
  });
}

// 練習は ID で引く(DB 版は pd_…、ファイル版はファイル名)。表示は一覧の name・label を使う。
const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;

export async function apiListProjects() { return getJson('/api/projects'); }
export async function apiListSummaries() { return getJson('/api/summaries'); }
export async function apiGetProject(id) { return getJson(projectPath(id)); }

// 新しい練習を作る。name は採番済みのファイル名。戻り値 { id, name }。
export async function apiCreateProject(name, obj) {
  const res = await send('/api/projects', 'POST', { name, project: obj });
  if (!res.ok) throw new Error(`保存に失敗 (${res.status})`);
  return res.json();
}
// 既にある練習を上書きする(無ければ 404)。
export async function apiPutProject(id, obj) {
  const res = await send(projectPath(id), 'PUT', obj);
  if (!res.ok) throw new Error(`保存に失敗 (${res.status})`);
}
export async function apiDeleteProject(id) {
  const res = await send(projectPath(id), 'DELETE');
  if (!res.ok) throw new Error(`削除に失敗 (${res.status})`);
}
export async function apiGetOverlay(name) { return getJson(`/api/overlays/${name}`); }
export async function apiPutOverlay(name, obj) {
  const res = await send(`/api/overlays/${name}`, 'PUT', obj);
  if (!res.ok) throw new Error(`同期に失敗 (${res.status})`);
}

export async function apiAuthStatus() { return (await getJson('/api/auth')).unlocked === true; }
export async function apiUnlock(password) {
  const res = await send('/api/unlock', 'POST', { password });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`ログインに失敗 (${res.status})`);
  return (await res.json()).unlocked === true;
}
export async function apiLock() { await send('/api/lock', 'POST'); }

// アカウントのログイン(所属組織の一覧)。未ログイン(401)・ファイル版(503)は null。
export async function apiMe() {
  const res = await request('/api/me');
  if (!res.ok) return null;
  return res.json();
}

// ===== 閲覧ログイン(データ閲覧ゲート) =====
export async function apiSession() {
  const res = await request('/api/session');
  if (!res.ok) return { loggedIn: false, gate: true };
  return res.json();
}
export async function apiLogin(user, password) {
  const res = await send('/api/login', 'POST', { user, password });
  if (res.status === 401) {
    const d = await res.json().catch(() => ({}));
    return { ok: false, error: d.error || 'ログインに失敗しました' };
  }
  if (!res.ok) return { ok: false, error: `ログインに失敗 (${res.status})` };
  return { ok: true };
}
export async function apiLogout() { await send('/api/logout', 'POST'); }

export async function apiCommitMinutes({ practiceDate, rows }) {
  const res = await send('/api/minutes-imports/commit', 'POST', { practiceDate, rows });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    // サーバの汎用コード(internal_error)は画面に出さず、日本語の文言にする。
    const msg = d.error && d.error !== 'internal_error' ? d.error : `取込に失敗 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}
