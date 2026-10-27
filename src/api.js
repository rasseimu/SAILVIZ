// バックエンド /api への薄い fetch ラッパ。書き込みは same-origin Cookie を送る。
// 表示中の組織(activeorg.js)があれば、すべての要求に X-Sailviz-Org を付ける。
import { ACTIVE_ORG_KEY, getActiveOrgId, setActiveOrgId } from './activeorg.js';

const OPTS = { credentials: 'same-origin' };

// 表示中の組織はページを読み込んだときに一度だけ決めて固定する(lockActiveOrg)。
// 画面のデータはその組織で読んだものなので、途中で localStorage が変わっても(別タブ・組織管理ページ)
// 固定した組織で送る。そうしないと古い組織の全置換データで別の組織を上書きしてしまう。
// 固定する前(起動直後の認証・me の確認)だけは localStorage をそのまま読む。
let locked = false;
let lockedOrgId = null;
// org_forbidden を受けたら、読み込み直すまでこのページからは何も送らない
// (ヘッダー無しで送り直すと所属の先頭の組織に書き込んでしまう)。
let blocked = false;
const RELOAD_MESSAGE = '表示中の組織に所属していません。読み込み直してください';

// 表示中の組織を固定する。起動時に resolveActiveOrg のあとで一度だけ呼ぶ(null = ヘッダー無し)。
// bfcache からの復元・別タブでの切り替えで localStorage が固定した組織と違えば読み込み直す。
export function lockActiveOrg(id) {
  locked = true;
  lockedOrgId = id || null;
  if (typeof globalThis.addEventListener !== 'function') return;
  const reloadIfChanged = () => {
    if (getActiveOrgId() !== lockedOrgId) globalThis.location?.reload();
  };
  globalThis.addEventListener('pageshow', (e) => { if (e?.persisted) reloadIfChanged(); });
  globalThis.addEventListener('storage', (e) => { if (e?.key === ACTIVE_ORG_KEY) reloadIfChanged(); });
}

// すべての fetch はここを通す。所属していない組織を指していた(403 org_forbidden)ら、
// 表示中の組織を消してから投げ、以後この画面からは送らない(次の起動で /api/me の先頭に戻る)。
// noOrg: 組織のデータに触れない要求(ログアウト)。blocked でも送り、X-Sailviz-Org を付けない。
async function request(path, init = {}, { noOrg = false } = {}) {
  if (blocked && !noOrg) throw new Error(RELOAD_MESSAGE);
  const orgId = noOrg ? null : (locked ? lockedOrgId : getActiveOrgId());
  const headers = orgId ? { ...init.headers, 'X-Sailviz-Org': orgId } : init.headers;
  const res = await fetch(path, { ...OPTS, ...init, ...(headers ? { headers } : {}) });
  if (res.status === 403) {
    // 呼び出し側も本文を読むことがあるので、読めるなら複製を読む。
    const body = await (res.clone ? res.clone() : res).json().catch(() => null);
    // 旧 API は { error: 'org_forbidden' }、アプリ向け API(動画コメントなど)は { error: { code: 'org_forbidden' } }。
    if (body?.error === 'org_forbidden' || body?.error?.code === 'org_forbidden') {
      setActiveOrgId(null);
      blocked = true;
      throw new Error(RELOAD_MESSAGE);
    }
  }
  return res;
}

async function getJson(path) {
  const res = await request(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function send(path, method, obj, opts) {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: obj === undefined ? undefined : JSON.stringify(obj),
  }, opts);
}

// 練習は ID で引く(DB 版は pd_…、ファイル版はファイル名)。表示は一覧の name・label を使う。
const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;

export async function apiListProjects() { return getJson('/api/projects'); }
export async function apiListSummaries() { return getJson('/api/summaries'); }
// 練習ごとの反省だけ [{ id, name, reflections }](軌跡を含まない。進捗画面の集計用)。
export async function apiListReflections() { return getJson('/api/reflections'); }
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
  if (!res.ok) throw Object.assign(new Error(`削除に失敗 (${res.status})`), { status: res.status });
}
// 練習の動画一覧だけを読む(全体保存の直前に、他のメンバーが追記した動画を取り込むため)。戻り値 videos の配列。
export async function apiGetProjectVideos(id) {
  const res = await request(`${projectPath(id)}/videos`);
  if (!res.ok) throw Object.assign(new Error(`動画一覧の取得に失敗 (${res.status})`), { status: res.status });
  return (await res.json()).videos;
}
// 練習に動画だけを追記する(name + t が未登録のものだけ足される)。戻り値 { videos: 保存後の一覧, added: 足した本数 }。
export async function apiAppendProjectVideos(id, videos) {
  const res = await send(`${projectPath(id)}/videos`, 'POST', { videos });
  if (!res.ok) throw Object.assign(new Error(`動画の保存に失敗 (${res.status})`), { status: res.status });
  return res.json();
}
// 動画の瞬間コメント(②)。練習の全動画ぶんを読む。戻り値 { comments, canWrite }。
// このサーバでは使えない(ファイル版・503)ときは { comments: [], canWrite: false, unavailable: true }。
export async function apiListVideoComments(projectId) {
  const res = await request(`${projectPath(projectId)}/video-comments`);
  if (res.status === 503) return { comments: [], canWrite: false, unavailable: true };
  if (!res.ok) throw Object.assign(new Error(`コメントの取得に失敗 (${res.status})`), { status: res.status });
  const body = await res.json();
  return { comments: Array.isArray(body?.comments) ? body.comments : [], canWrite: body?.canWrite === true };
}
// このサーバで動画コメントを使えるか(ファイル版は false)。未保存の練習の案内を出すかに使う(ページで1回だけ)。
// 練習 ID の形でない '-' を指すので、DB 版はどの練習も読まずに 404、ファイル版はパスが一致した時点で 503 を返す。
export async function apiVideoCommentsAvailable() {
  const res = await request(`${projectPath('-')}/video-comments`);
  return res.status !== 503;
}
// 失敗はサーバの理由(message)があれば添えて投げる。
async function videoCommentError(res, what) {
  const reason = (await res.json().catch(() => null))?.error?.message;
  return Object.assign(new Error(`${what} (${res.status})${reason ? `: ${reason}` : ''}`), { status: res.status });
}
// 本文 { videoName, videoT, positionMs, text } → 作ったコメント。
export async function apiCreateVideoComment(projectId, comment) {
  const res = await send(`${projectPath(projectId)}/video-comments`, 'POST', comment);
  if (!res.ok) throw await videoCommentError(res, 'コメントの保存に失敗');
  return res.json();
}
// 勉強動画(プロ動画。③)のコメント。表示中の組織の全件。戻り値 { comments, canWrite }。
// このサーバでは使えない(ファイル版・503)ときは unavailable: true、組織に入っていない(403 no_org)ときは noOrg: true。
export async function apiListStudyComments() {
  const res = await request('/api/study-comments');
  if (res.status === 503) return { comments: [], canWrite: false, unavailable: true };
  if (res.status === 403) {
    const code = (await res.json().catch(() => null))?.error?.code;
    if (code === 'no_org') return { comments: [], canWrite: false, noOrg: true };
  }
  if (!res.ok) throw Object.assign(new Error(`コメントの取得に失敗 (${res.status})`), { status: res.status });
  const body = await res.json();
  return { comments: Array.isArray(body?.comments) ? body.comments : [], canWrite: body?.canWrite === true };
}
// 本文 { videoName, videoSize, positionMs, text } → 作ったコメント。編集・削除は apiUpdateVideoComment / apiDeleteVideoComment。
export async function apiCreateStudyComment(comment) {
  const res = await send('/api/study-comments', 'POST', comment);
  if (!res.ok) throw await videoCommentError(res, 'コメントの保存に失敗');
  return res.json();
}
export async function apiUpdateVideoComment(commentId, text) {
  const res = await send(`/api/video-comments/${encodeURIComponent(commentId)}`, 'PATCH', { text });
  if (!res.ok) throw await videoCommentError(res, 'コメントの更新に失敗');
  return res.json();
}
export async function apiDeleteVideoComment(commentId) {
  const res = await send(`/api/video-comments/${encodeURIComponent(commentId)}`, 'DELETE');
  if (!res.ok) throw await videoCommentError(res, 'コメントの削除に失敗');
}
// 進捗を読んだサーバの時刻(X-Sailviz-Read-At)。保存のときに送り返すと、サーバはそれより前からあるコメントを
// 「この画面で消したもの」として消し、読んだ後にアプリで足されたコメントだけを残す。保存では更新しない(読み直すまで同じ)。
let progressReadAt = null;
export async function apiGetOverlay(name) {
  const path = `/api/overlays/${name}`;
  const res = await request(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  if (name === 'progress') progressReadAt = res.headers?.get?.('x-sailviz-read-at') || null;
  return res.json();
}
export async function apiPutOverlay(name, obj) {
  const readAt = name === 'progress' ? progressReadAt : null;
  const res = await request(`/api/overlays/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(readAt ? { 'X-Sailviz-Read-At': readAt } : {}) },
    body: JSON.stringify(obj),
  });
  if (!res.ok) {
    // 400 はサーバの理由(コメントの名前が無い・名簿外など)を伝える。
    const reason = res.status === 400 ? (await res.json().catch(() => null))?.error : null;
    throw new Error(reason ? `同期に失敗: ${reason}` : `同期に失敗 (${res.status})`);
  }
}

export async function apiAuthStatus() { return (await getJson('/api/auth')).unlocked === true; }
export async function apiUnlock(password) {
  const res = await send('/api/unlock', 'POST', { password });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`ログインに失敗 (${res.status})`);
  return (await res.json()).unlocked === true;
}
export async function apiLock() { await send('/api/lock', 'POST'); }

// メンバー候補(サーバーが読み書きの主体と同じ判定で決めた名簿。src/members.js の形)。未ログインは例外。
export async function apiMembers() { return getJson('/api/members'); }

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
// アカウントのログイン(メールアドレス+パスワード)。成功するとセッション Cookie(sailviz_session)が付く。
export async function apiAccountLogin(email, password) {
  const res = await send('/api/auth/login', 'POST', { email, password }, { noOrg: true });
  if (res.ok) return { ok: true };
  const d = await res.json().catch(() => ({}));
  return { ok: false, error: d.error?.message || `ログインに失敗 (${res.status})` };
}
export async function apiLogout() { await send('/api/logout', 'POST', undefined, { noOrg: true }); }
// アカウントのセッションも失効させる。未ログイン(401)・ファイル版(503)・通信失敗は無視する。
export async function apiAccountLogout() {
  try { await send('/api/auth/logout', 'POST', undefined, { noOrg: true }); } catch { /* 無視 */ }
}

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
