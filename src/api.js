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
