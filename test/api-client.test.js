// test/api-client.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiGetProject, apiPutProject, apiUnlock, apiCommitMinutes, apiCreateProject, apiListProjects, apiMe, apiDeleteProject,
  apiGetProjectVideos, apiAppendProjectVideos,
  apiListVideoComments, apiCreateVideoComment, apiUpdateVideoComment, apiDeleteVideoComment, apiVideoCommentsAvailable,
  apiListStudyComments, apiCreateStudyComment,
} from '../src/api.js';
import { getActiveOrgId, setActiveOrgId, resolveActiveOrg } from '../src/activeorg.js';

const realFetch = globalThis.fetch;
const lsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
// 表示中の組織は localStorage に覚える。テストごとに空の偽物を差す。
beforeEach(() => {
  const m = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) },
    configurable: true, writable: true,
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (lsDesc) Object.defineProperty(globalThis, 'localStorage', lsDesc);
  else delete globalThis.localStorage;
});

// fetch の呼び出しを記録する偽物。reply(url, init) が応答を返す。
function recordFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return reply(url, init); };
  return calls;
}
const okJson = (body, status = 200) => ({ ok: true, status, json: async () => body });
const orgHeader = (init) => (init.headers || {})['X-Sailviz-Org'];
// 表示中の組織の固定はモジュールの状態なので、ページの読み込みを真似るときは api.js を読み直す。
let freshSeq = 0;
const freshApi = () => import(`../src/api.js?fresh=${++freshSeq}`);

test('apiGetProject returns parsed json', async () => {
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => ({ version: 1, u }) });
  const p = await apiGetProject('x.sailviz.json');
  assert.equal(p.version, 1);
});

test('apiPutProject throws on non-2xx', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'x' }) });
  await assert.rejects(() => apiPutProject('x.sailviz.json', {}));
});

test('apiUnlock returns false on 401', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal(await apiUnlock('bad'), false);
});

test('apiCommitMinutes returns parsed json on 200', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ name: 'x.sailviz.json', added: 2, created: true }) });
  const r = await apiCommitMinutes({ practiceDate: 1, rows: [] });
  assert.equal(r.added, 2);
  assert.equal(r.name, 'x.sailviz.json');
});

test('apiCommitMinutes throws on non-2xx', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: '名簿外' }) });
  await assert.rejects(() => apiCommitMinutes({ practiceDate: 1, rows: [] }), /名簿外/);
});

test('api: 表示中の組織があれば X-Sailviz-Org を付ける', async () => {
  const calls = recordFetch(() => okJson([]));
  await apiListProjects();
  assert.equal(orgHeader(calls[0].init), undefined); // 無ければ付けない(ファイル版・共有ログイン)
  setActiveOrgId('org_a');
  await apiListProjects();
  await apiPutProject('pd_0123456789', { version: 1 });
  assert.equal(orgHeader(calls[1].init), 'org_a');
  assert.equal(orgHeader(calls[2].init), 'org_a');
  assert.equal(calls[2].init.headers['content-type'], 'application/json'); // 既存のヘッダーは残す
  assert.equal(calls[2].init.credentials, 'same-origin');
});

test('api: 練習の読み書きは ID を URL に入れる', async () => {
  const calls = recordFetch(() => okJson({}));
  await apiGetProject('pd_0123456789');
  await apiPutProject('pd_0123456789', {});
  assert.equal(calls[0].url, '/api/projects/pd_0123456789');
  assert.equal(calls[1].url, '/api/projects/pd_0123456789');
  assert.equal(calls[1].init.method, 'PUT');
});

test('api: apiCreateProject は POST /api/projects に { name, project } を送り { id, name } を返す', async () => {
  const calls = recordFetch(() => okJson({ id: 'pd_0123456789', name: '2026-01-02_0900.sailviz.json' }, 201));
  const r = await apiCreateProject('2026-01-02_0900.sailviz.json', { version: 1 });
  assert.deepEqual(r, { id: 'pd_0123456789', name: '2026-01-02_0900.sailviz.json' });
  assert.equal(calls[0].url, '/api/projects');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: '2026-01-02_0900.sailviz.json', project: { version: 1 } });
});

test('api: apiCreateProject は失敗で投げる', async () => {
  recordFetch(() => ({ ok: false, status: 409, json: async () => ({ error: 'exists' }) }));
  await assert.rejects(() => apiCreateProject('x.sailviz.json', {}), /409/);
});

test('403 org_forbidden で表示中の組織を消し、読み込み直したページで me の先頭に戻る', async () => {
  const page1 = await freshApi();
  setActiveOrgId('org_gone');
  page1.lockActiveOrg('org_gone');
  recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'org_forbidden' }) }));
  await assert.rejects(() => page1.apiListProjects());
  assert.equal(getActiveOrgId(), null); // api.js が消す
  // 読み込み直したページ(モジュールを読み直す)は起動時と同じく me を読み、所属の先頭を表示中にする。
  const page2 = await freshApi();
  const calls = recordFetch((url) => (url === '/api/me'
    ? okJson({ user: { id: 'u_1' }, orgs: [{ id: 'org_a', name: 'A', isAdmin: false }] })
    : okJson([])));
  const me = await page2.apiMe();
  page2.lockActiveOrg(resolveActiveOrg(me.orgs));
  await page2.apiListProjects();
  assert.equal(orgHeader(calls[1].init), 'org_a');
});

test('api: 403 でも org_forbidden 以外は表示中の組織を残す', async () => {
  setActiveOrgId('org_a');
  recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
  await assert.rejects(() => apiPutProject('pd_0123456789', {}));
  assert.equal(getActiveOrgId(), 'org_a');
});

test('api: apiMe は 401・503 で null を返す(共有ログイン・ファイル版)', async () => {
  recordFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal(await apiMe(), null);
  recordFetch(() => ({ ok: false, status: 503, json: async () => ({ error: 'accounts_unavailable' }) }));
  assert.equal(await apiMe(), null);
});

// ---- 表示中の組織はページを読み込んだときに一度だけ決める(古い画面で別組織を上書きしない) ----

test('api: 固定したあとに localStorage が変わっても、送るヘッダーは固定した組織のまま', async () => {
  const api = await freshApi();
  setActiveOrgId('org_a');
  api.lockActiveOrg('org_a');
  setActiveOrgId('org_b'); // 別タブ・組織管理ページで切り替えた
  const calls = recordFetch(() => okJson({}));
  await api.apiPutOverlay('roadmap', { teamGoal: 'x' });
  await api.apiListProjects();
  assert.equal(orgHeader(calls[0].init), 'org_a');
  assert.equal(orgHeader(calls[1].init), 'org_a');
});

test('api: org_forbidden のあとは、このページから要求を送らない(ヘッダー無しで送り直さない)', async () => {
  const api = await freshApi();
  setActiveOrgId('org_gone');
  api.lockActiveOrg('org_gone');
  let calls = recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'org_forbidden' }) }));
  await assert.rejects(() => api.apiListProjects());
  assert.equal(getActiveOrgId(), null);
  calls = recordFetch(() => okJson({}));
  await assert.rejects(() => api.apiPutOverlay('roadmap', { teamGoal: 'x' }), /読み込み直して/);
  await assert.rejects(() => api.apiPutProject('pd_0123456789', {}));
  assert.equal(calls.length, 0);
});

test('api: org_forbidden のあとでもログアウト(共有・アカウント)は送る。組織ヘッダーは付けない', async () => {
  const api = await freshApi();
  setActiveOrgId('org_gone');
  api.lockActiveOrg('org_gone');
  recordFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'org_forbidden' }) }));
  await assert.rejects(() => api.apiListProjects());
  const calls = recordFetch(() => okJson({ ok: true }));
  await api.apiLogout();
  await api.apiAccountLogout();
  assert.deepEqual(calls.map((c) => [c.url, c.init.method]), [['/api/logout', 'POST'], ['/api/auth/logout', 'POST']]);
  assert.equal(orgHeader(calls[0].init), undefined);
  assert.equal(orgHeader(calls[1].init), undefined);
  // 他の要求は引き続き送らない
  await assert.rejects(() => api.apiListProjects(), /読み込み直して/);
  assert.equal(calls.length, 2);
});

test('api: 組織が無いページ(ファイル版・アカウント無し)はヘッダー無しで普通に動く', async () => {
  const api = await freshApi();
  api.lockActiveOrg(null);
  const calls = recordFetch(() => okJson({}));
  await api.apiPutOverlay('roadmap', {});
  await api.apiListProjects();
  assert.equal(calls.length, 2);
  assert.equal(orgHeader(calls[0].init), undefined);
  assert.equal(orgHeader(calls[1].init), undefined);
});

test('api: bfcache 復元・別タブの切替で、固定した組織と違えば読み込み直す', async () => {
  const api = await freshApi();
  const handlers = {};
  let reloads = 0;
  const addDesc = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const locDesc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'addEventListener', { value: (t, fn) => { handlers[t] = fn; }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { reload: () => { reloads++; } }, configurable: true, writable: true });
  try {
    setActiveOrgId('org_a');
    api.lockActiveOrg('org_a');
    handlers.pageshow({ persisted: true });
    handlers.storage({ key: 'sailviz.activeOrg.v1' });
    assert.equal(reloads, 0); // 同じ組織なら何もしない
    setActiveOrgId('org_b');
    handlers.pageshow({ persisted: false }); // 通常の表示は対象外
    handlers.storage({ key: 'other.key' });
    assert.equal(reloads, 0);
    handlers.pageshow({ persisted: true });
    handlers.storage({ key: 'sailviz.activeOrg.v1' });
    assert.equal(reloads, 2);
  } finally {
    if (addDesc) Object.defineProperty(globalThis, 'addEventListener', addDesc); else delete globalThis.addEventListener;
    if (locDesc) Object.defineProperty(globalThis, 'location', locDesc); else delete globalThis.location;
  }
});

// 進捗は読んだ時刻(X-Sailviz-Read-At)を覚え、保存のときに送り返す(それより前からあるコメントを Web から消せる)。
const withHeaders = (body, headers = {}) => ({
  ok: true, status: 200, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});
test('apiGetOverlay(progress) の読んだ時刻を、apiPutOverlay(progress) が X-Sailviz-Read-At で送り返す', async () => {
  const api = await freshApi();
  const calls = recordFetch((url, init) => (init.method === 'PUT' ? okJson({ ok: true }) : withHeaders({}, { 'x-sailviz-read-at': '12345' })));
  await api.apiGetOverlay('progress');
  await api.apiPutOverlay('progress', { r1: {} });
  assert.equal(calls[1].init.headers['X-Sailviz-Read-At'], '12345');
  // ロードマップには付けない
  await api.apiPutOverlay('roadmap', {});
  assert.equal(calls[2].init.headers['X-Sailviz-Read-At'], undefined);
});

test('apiPutOverlay(progress): 読む前・読んだ時刻の無い応答なら X-Sailviz-Read-At を付けない', async () => {
  const api = await freshApi();
  const calls = recordFetch((url, init) => (init.method === 'PUT' ? okJson({ ok: true }) : withHeaders({})));
  await api.apiPutOverlay('progress', {});
  await api.apiGetOverlay('progress');
  await api.apiPutOverlay('progress', {});
  assert.equal(calls[0].init.headers['X-Sailviz-Read-At'], undefined);
  assert.equal(calls[2].init.headers['X-Sailviz-Read-At'], undefined);
});

test('apiPutOverlay: 400 はサーバの理由(名簿外の名前など)を伝える', async () => {
  const api = await freshApi();
  recordFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'コメントに名前がありません' }) }));
  await assert.rejects(() => api.apiPutOverlay('progress', {}), /コメントに名前がありません/);
});

test('apiDeleteProject: 失敗したら HTTP の状態(403 など)を err.status に付けて投げる', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
  await assert.rejects(() => apiDeleteProject('pd_0123456789'), (e) => e.status === 403);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await apiDeleteProject('pd_0123456789');
});

test('api: apiGetProjectVideos は GET /api/projects/:id/videos の videos を返す', async () => {
  const calls = recordFetch(() => okJson({ videos: [{ id: 'vid0', t: 1, name: 'a.mp4', durationMs: null }] }));
  const v = await apiGetProjectVideos('pd_0123456789');
  assert.equal(calls[0].url, '/api/projects/pd_0123456789/videos');
  assert.equal(calls[0].init.method, undefined);
  assert.deepEqual(v.map((x) => x.name), ['a.mp4']);
});

test('api: apiAppendProjectVideos は POST で { videos } を送り { videos, added } を返す。失敗は err.status 付きで投げる', async () => {
  const calls = recordFetch(() => okJson({ videos: [], added: 0 }));
  const videos = [{ id: 'vid0', t: 1, name: 'a.mp4', durationMs: null }];
  assert.deepEqual(await apiAppendProjectVideos('x.sailviz.json', videos), { videos: [], added: 0 });
  assert.equal(calls[0].url, '/api/projects/x.sailviz.json/videos');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { videos });
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => apiAppendProjectVideos('x.sailviz.json', videos), (e) => e.status === 401);
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => apiGetProjectVideos('x.sailviz.json'), (e) => e.status === 404);
});

test('api: 動画コメントの一覧は { comments, canWrite }。503 は unavailable、それ以外の失敗は err.status 付きで投げる', async () => {
  const calls = recordFetch(() => okJson({ comments: [{ id: 'vc_1' }], canWrite: true }));
  assert.deepEqual(await apiListVideoComments('pd_0123456789'), { comments: [{ id: 'vc_1' }], canWrite: true });
  assert.equal(calls[0].url, '/api/projects/pd_0123456789/video-comments');
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable' } }) });
  assert.deepEqual(await apiListVideoComments('x.sailviz.json'), { comments: [], canWrite: false, unavailable: true });
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { code: 'not_found' } }) });
  await assert.rejects(() => apiListVideoComments('pd_0123456789'), (e) => e.status === 404);
});

test('api: 動画コメントの作成・更新・削除のパスとメソッド。失敗はサーバの理由を添える', async () => {
  const calls = recordFetch(() => okJson({ id: 'vc_1' }, 201));
  const b = { videoName: 'a.mp4', videoT: 1, positionMs: 0, text: 'x' };
  assert.deepEqual(await apiCreateVideoComment('pd_0123456789', b), { id: 'vc_1' });
  await apiUpdateVideoComment('vc_1', 'y');
  await apiDeleteVideoComment('vc_1');
  assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
    ['POST', '/api/projects/pd_0123456789/video-comments'], ['PATCH', '/api/video-comments/vc_1'], ['DELETE', '/api/video-comments/vc_1'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), b);
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'y' });
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({ error: { code: 'invalid_input', message: 'text は 1〜1000 字' } }) });
  await assert.rejects(() => apiCreateVideoComment('pd_0123456789', b), (e) => e.status === 422 && /1〜1000/.test(e.message));
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden' } }) });
  await assert.rejects(() => apiDeleteVideoComment('vc_1'), (e) => e.status === 403);
});

test('api: アプリ向け API の形の org_forbidden({ error: { code } })でも表示中の組織を消して以後送らない', async () => {
  const api = await freshApi();
  setActiveOrgId('o_a');
  api.lockActiveOrg('o_a');
  const calls = recordFetch(() => ({ ok: false, status: 403, clone() { return this; }, json: async () => ({ error: { code: 'org_forbidden', message: 'x' } }) }));
  await assert.rejects(() => api.apiListVideoComments('pd_0123456789'), /読み込み直して/);
  assert.equal(getActiveOrgId(), null);
  await assert.rejects(() => api.apiListProjects(), /読み込み直して/);
  assert.equal(calls.length, 1);
});

test('api: apiVideoCommentsAvailable は 503 だけ false', async () => {
  const calls = recordFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(await apiVideoCommentsAvailable(), true);
  assert.equal(calls[0].url, '/api/projects/-/video-comments');
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await apiVideoCommentsAvailable(), false);
});

test('api: 勉強動画のコメント一覧は { comments, canWrite }。503 は unavailable、403 no_org は noOrg、他の失敗は投げる', async () => {
  const calls = recordFetch(() => okJson({ comments: [{ id: 'vc_1', videoName: 'clip01.mp4', videoSize: 10 }], canWrite: true }));
  assert.deepEqual(await apiListStudyComments(), { comments: [{ id: 'vc_1', videoName: 'clip01.mp4', videoSize: 10 }], canWrite: true });
  assert.equal(calls[0].url, '/api/study-comments');
  assert.equal(calls[0].init.method, undefined);
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable' } }) });
  assert.deepEqual(await apiListStudyComments(), { comments: [], canWrite: false, unavailable: true });
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'no_org' } }) });
  assert.deepEqual(await apiListStudyComments(), { comments: [], canWrite: false, noOrg: true });
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden' } }) });
  await assert.rejects(() => apiListStudyComments(), (e) => e.status === 403);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => apiListStudyComments(), (e) => e.status === 401);
});

test('api: 勉強動画のコメント作成は POST /api/study-comments。失敗はサーバの理由を添える', async () => {
  const calls = recordFetch(() => okJson({ id: 'vc_1' }, 201));
  const b = { videoName: 'clip01.mp4', videoSize: 10, positionMs: 0, text: 'x' };
  assert.deepEqual(await apiCreateStudyComment(b), { id: 'vc_1' });
  assert.deepEqual([calls[0].init.method, calls[0].url], ['POST', '/api/study-comments']);
  assert.deepEqual(JSON.parse(calls[0].init.body), b);
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: 'コメントを書く権限がありません' } }) });
  await assert.rejects(() => apiCreateStudyComment(b), (e) => e.status === 403 && /権限/.test(e.message));
});
