// バックエンド /api への薄い fetch ラッパ。書き込みは same-origin Cookie を送る。
const OPTS = { credentials: 'same-origin' };

async function getJson(path) {
  const res = await fetch(path, OPTS);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function send(path, method, obj) {
  const res = await fetch(path, {
    ...OPTS, method,
    headers: { 'content-type': 'application/json' },
    body: obj === undefined ? undefined : JSON.stringify(obj),
  });
  return res;
}

export async function apiListProjects() { return getJson('/api/projects'); }
export async function apiListSummaries() { return getJson('/api/summaries'); }
export async function apiGetProject(name) { return getJson(`/api/projects/${encodeURIComponent(name)}`); }

export async function apiPutProject(name, obj) {
  const res = await send(`/api/projects/${encodeURIComponent(name)}`, 'PUT', obj);
  if (!res.ok) throw new Error(`保存に失敗 (${res.status})`);
}
export async function apiDeleteProject(name) {
  const res = await send(`/api/projects/${encodeURIComponent(name)}`, 'DELETE');
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

// ===== 閲覧ログイン(データ閲覧ゲート) =====
export async function apiSession() {
  const res = await fetch('/api/session', OPTS);
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
    throw new Error(d.error || `取込に失敗 (${res.status})`);
  }
  return res.json();
}
