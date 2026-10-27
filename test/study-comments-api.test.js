// test/study-comments-api.test.js — 勉強動画(プロ動画)の瞬間コメントの API(③)。
//   GET/POST /api/study-comments、PATCH/DELETE /api/video-comments/:cid(②と共用)。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApi, skip, clock } from './helpers/apiHarness.js';
import { createApi } from '../server/api.js';

const SHARED_ORG = 'o_sharedstudy';
const PATH = '/api/study-comments';
let h;
before(async () => { if (!skip) h = await startApi({ migrationOrgId: SHARED_ORG }); });
after(async () => { if (h) await h.close(); });

const orgH = (o) => ({ 'x-sailviz-org': typeof o === 'string' ? o : o.id });
const body = (over = {}) => ({ videoName: 'clip01.mp4', videoSize: 123_456, positionMs: 12_340, text: 'ここのタック', ...over });
const json = async (r) => ({ status: r.status, json: await r.json() });
const post = async (u, o, b = body()) => json(await h.call('POST', PATH, typeof u === 'string' ? u : u?.tok, b, o ? orgH(o) : {}));
const list = async (u, o) => json(await h.call('GET', PATH, typeof u === 'string' ? u : u?.tok, undefined, o ? orgH(o) : {}));
const withApi = async (api, fn) => {
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { await new Promise((r) => s.close(r)); }
};

test('POST → GET: 形(videoSize 付き)・名前・canWrite・canEdit/canDelete・動画キー → 位置順', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const o = h.mkOrg(a, b); // a が管理者
  const r1 = await post(b, o, body({ videoName: 'clip02.mp4', videoSize: 20, positionMs: 0, text: 'B' }));
  assert.equal(r1.status, 201);
  assert.deepEqual(Object.keys(r1.json).sort(), ['authorName', 'authorUserId', 'canDelete', 'canEdit', 'createdAt', 'id', 'positionMs', 'text',
    'updatedAt', 'videoName', 'videoSize', 'videoT']);
  assert.equal(r1.json.videoSize, 20);
  assert.equal(r1.json.videoT, null);
  assert.equal(r1.json.authorName, b.user.name);
  assert.equal(r1.json.createdAt, clock);
  await post(a, o, body({ videoName: 'clip01.mp4', videoSize: 10, positionMs: 5000, text: 'A5' }));
  await post(a, o, body({ videoName: 'clip01.mp4', videoSize: 10, positionMs: 1000, text: 'A1' }));
  const la = await list(a, o);
  assert.equal(la.status, 200);
  assert.equal(la.json.canWrite, true);
  assert.deepEqual(la.json.comments.map((c) => [c.videoName, c.videoSize, c.text, c.canEdit, c.canDelete]), [
    ['clip01.mp4', 10, 'A1', true, true], ['clip01.mp4', 10, 'A5', true, true], ['clip02.mp4', 20, 'B', false, true],
  ]);
  const lb = await list(b, o);
  assert.deepEqual(lb.json.comments.map((c) => [c.canEdit, c.canDelete]), [[false, false], [false, false], [true, true]]);
  // 表には scope 'study'・練習 ID なし・組織 = 表示中の組織で入る
  const row = h.videoComments.get(r1.json.id);
  assert.equal(row.scope, 'study');
  assert.equal(row.practiceDayId, null);
  assert.equal(row.orgId, o.id);
  assert.equal(row.videoKey, '["clip02.mp4",20]');
});

test('同じ名前でもサイズが違えば別の動画。名前に区切り文字があっても混ざらない', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  await post(a, o, body({ videoName: 'a",1', videoSize: 2, text: 'x' }));
  await post(a, o, body({ videoName: 'a', videoSize: 1, text: 'y' }));
  await post(a, o, body({ videoName: 'a', videoSize: 2, text: 'z' }));
  const keys = new Set(h.videoComments.listStudy(o.id).map((c) => c.videoKey));
  assert.equal(keys.size, 3);
  const l = (await list(a, o)).json.comments;
  assert.deepEqual(l.filter((c) => c.videoName === 'a' && c.videoSize === 2).map((c) => c.text), ['z']);
});

test('組織で分かれる: 他組織・表示中でない自分の別組織のコメントは出ない。練習のコメントとも混ざらない', { skip }, async () => {
  const a = h.mkUser(); const x = h.mkUser(); const two = h.mkUser();
  const o = h.mkOrg(a, two); const ox = h.mkOrg(x, two);
  const ca = (await post(a, o, body({ text: 'o の' }))).json;
  const cx = (await post(x, ox, body({ text: 'ox の' }))).json;
  // 同じ組織の練習のコメント(scope 'practice')
  h.db.prepare("INSERT INTO practice_days (id, org_id, date, rev, created_at, updated_at) VALUES ('pd_51d0c0a7e1', ?, '2026-10-26', 0, 1, 1)").run(o.id);
  h.videoComments.insert({
    orgId: o.id, scope: 'practice', practiceDayId: 'pd_51d0c0a7e1', videoKey: '["clip01.mp4",123456]', videoName: 'clip01.mp4',
    positionMs: 0, text: '練習の', authorUserId: a.user.id, now: clock,
  });
  assert.deepEqual((await list(a, o)).json.comments.map((c) => c.id), [ca.id]);
  assert.deepEqual((await list(x, ox)).json.comments.map((c) => c.id), [cx.id]);
  // 両方に所属: 表示中の組織だけ。切り替えると変わる
  assert.deepEqual((await list(two, o)).json.comments.map((c) => c.id), [ca.id]);
  assert.deepEqual((await list(two, ox)).json.comments.map((c) => c.id), [cx.id]);
  // 書いた先も表示中の組織
  const c2 = (await post(two, ox, body({ text: 'two が ox に' }))).json;
  assert.equal(h.videoComments.get(c2.id).orgId, ox.id);
  // 他組織・表示中でない組織のコメントへの PATCH / DELETE は 404
  for (const [method, b] of [['PATCH', { text: 'x' }], ['DELETE', undefined]]) {
    assert.equal((await h.call(method, `/api/video-comments/${ca.id}`, x.tok, b)).status, 404, `${method} 他組織`);
    assert.equal((await h.call(method, `/api/video-comments/${c2.id}`, two.tok, b, orgH(o))).status, 404, `${method} 表示中でない組織`);
  }
  assert.equal(h.videoComments.get(c2.id).text, 'two が ox に');
  assert.equal((await h.call('PATCH', `/api/video-comments/${c2.id}`, two.tok, { text: '直した' }, orgH(ox))).status, 200);
  // ②の練習の一覧には勉強のコメントは出ない
  const pl = await json(await h.call('GET', '/api/projects/pd_51d0c0a7e1/video-comments', a.tok, undefined, orgH(o)));
  assert.deepEqual(pl.json.comments.map((c) => c.text), ['練習の']);
});

test('判定順: 401 / 403 org_forbidden / 403 no_org', { skip }, async () => {
  const a = h.mkUser(); const x = h.mkUser(); const lonely = h.mkUser();
  const o = h.mkOrg(a); const ox = h.mkOrg(x);
  for (const fn of [list, (u, org) => post(u, org)]) {
    const r401 = await fn(null);
    assert.equal(r401.status, 401);
    assert.equal(r401.json.error.code, 'unauthorized');
    const r403 = await fn(a, ox);
    assert.equal(r403.status, 403);
    assert.equal(r403.json.error.code, 'org_forbidden');
    const none = await fn(lonely);
    assert.equal(none.status, 403);
    assert.equal(none.json.error.code, 'no_org');
  }
  assert.equal((await list(a, o)).status, 200);
  // MIGRATION_ORG_ID の無い共有ログインは組織が無い
  await withApi(createApi({ repo: h.repo, token: 'shared-secret', accounts: h.accounts, app: h.app, videoComments: h.videoComments }), async (base) => {
    const r = await fetch(`${base}${PATH}`, { headers: { authorization: 'Bearer shared-secret' } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'no_org');
  });
});

test('共有ログイン: 自組織のコメントは読めるが、書けない・直せない・消せない', { skip }, async () => {
  h.db.prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, 'テスト組織', 1)").run(SHARED_ORG);
  const a = h.mkUser(); const x = h.mkUser(); const ox = h.mkOrg(x);
  h.accounts.linkMember({ orgId: SHARED_ORG, userId: a.user.id, rosterId: null, now: clock });
  const c = (await post(a, SHARED_ORG)).json;
  const other = (await post(x, ox, body({ text: '他組織' }))).json;
  const l = await list('shared-secret');
  assert.equal(l.status, 200);
  assert.equal(l.json.canWrite, false);
  assert.deepEqual(l.json.comments.map((y) => [y.id, y.canEdit, y.canDelete]), [[c.id, false, false]]);
  const p = await post('shared-secret');
  assert.equal(p.status, 403);
  assert.equal(p.json.error.code, 'forbidden');
  assert.equal((await h.call('PATCH', `/api/video-comments/${c.id}`, 'shared-secret', { text: 'x' })).status, 403);
  assert.equal((await h.call('DELETE', `/api/video-comments/${c.id}`, 'shared-secret')).status, 403);
  assert.equal((await h.call('DELETE', `/api/video-comments/${other.id}`, 'shared-secret')).status, 404);
  assert.equal(h.videoComments.get(c.id).text, 'ここのタック');
});

test('POST の入力検証(422)と境界。壊れた JSON は 422、大きすぎる本文は 413', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  for (const b of [
    [], 'x', body({ videoName: '' }), body({ videoName: 'n'.repeat(256) }), body({ videoSize: -1 }), body({ videoSize: 1.5 }),
    body({ videoSize: '10' }), body({ videoSize: Number.MAX_SAFE_INTEGER + 1 }), body({ positionMs: -1 }), body({ positionMs: 1.2 }),
    body({ text: '' }), body({ text: '  ' }), body({ text: 'a'.repeat(1001) }),
  ]) {
    const r = await post(a, o, b);
    assert.equal(r.status, 422, JSON.stringify(b).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid_input');
  }
  const bad = await fetch(`${h.base}${PATH}`, { method: 'POST', headers: { authorization: `Bearer ${a.tok}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 422);
  assert.equal((await post(a, o, body({ text: 'a'.repeat(70 * 1024) }))).status, 413);
  // 上の境界ちょうどは通る(位置は 24 時間を超えてもよい)
  const ok = await post(a, o, body({ videoName: 'n'.repeat(255), videoSize: 0, positionMs: 90_000_000, text: 'a'.repeat(1000) }));
  assert.equal(ok.status, 201);
  assert.equal(h.videoComments.listStudy(o.id).length, 1);
});

test('PATCH / DELETE(②と共用): 編集は本人だけ、削除は本人か組織の管理者', { skip }, async () => {
  const a = h.mkUser(); const m = h.mkUser(); const n = h.mkUser(); const o = h.mkOrg(a, m, n); // a が管理者
  const c1 = (await post(m, o)).json;
  const c2 = (await post(m, o)).json;
  const patch = async (u, cid, b) => json(await h.call('PATCH', `/api/video-comments/${cid}`, u.tok, b));
  assert.equal((await patch(a, c1.id, { text: '管理者' })).status, 403);
  assert.equal((await patch(n, c1.id, { text: '他人' })).status, 403);
  assert.equal((await patch(m, c1.id, { text: '' })).status, 422);
  const ok = await patch(m, c1.id, { text: '直した' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.text, '直した');
  assert.equal(ok.json.videoSize, 123_456);
  const del = async (u, cid) => (await h.call('DELETE', `/api/video-comments/${cid}`, u.tok)).status;
  assert.equal(await del(n, c1.id), 403);
  assert.equal(await del(m, c1.id), 200);
  assert.equal(await del(a, c2.id), 200);
  assert.equal(await del(m, c1.id), 404);
  assert.equal(h.videoComments.listStudy(o.id).length, 0);
});

test('上限件数より多いコメントは上限までを返す', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const { createStudyCommentsRoute } = await import('../server/routes/studyComments.js');
  const route = createStudyCommentsRoute({ repo: h.videoComments, accounts: h.accounts, limit: 2 });
  for (let i = 0; i < 3; i++) await post(a, o, body({ positionMs: i * 1000 }));
  const { resolveSubject } = await import('../server/compatPrincipal.js');
  await withApi(async (req, res) => {
    const ctx = { path: new URL(req.url, 'http://x').pathname, method: req.method, getSubject: () => resolveSubject(req, { token: 'shared-secret', accounts: h.accounts, now: clock }) };
    return route(req, res, ctx);
  }, async (base) => {
    const r = await fetch(`${base}${PATH}`, { headers: { authorization: `Bearer ${a.tok}`, 'x-sailviz-org': o.id } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).comments.map((c) => c.positionMs), [0, 1000]);
  });
});

test('ファイル版・コメントの repo の無い版は 503。対象外のメソッドは no route', { skip }, async () => {
  const a = h.mkUser(); h.mkOrg(a);
  assert.equal((await h.call('PUT', PATH, a.tok, {})).status, 404);
  assert.equal((await h.call('GET', `${PATH}/x`, a.tok)).status, 404);
  for (const api of [
    createApi({ repo: h.repo, token: 'shared-secret', accounts: h.accounts }),
    createApi({ dataDir: '/nonexistent-sailviz-test', token: 'shared-secret', viewUser: 'dummy-user', viewPassword: 'dummy-pass' }),
  ]) {
    await withApi(api, async (base) => {
      for (const method of ['GET', 'POST']) {
        const r = await fetch(`${base}${PATH}`, { method, headers: { authorization: `Bearer ${a.tok}` } });
        assert.equal(r.status, 503, method);
        assert.equal((await r.json()).error.code, 'unavailable');
      }
    });
  }
});

test('POST: videoName は NFC にそろえて保存し、NFD で送っても同じ動画のコメントになる', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const nfc = 'プロのタック.mp4';
  const r1 = await post(a, o, body({ videoName: nfc.normalize('NFD'), videoSize: 77, text: 'NFD で送った' }));
  assert.equal(r1.status, 201);
  assert.equal(r1.json.videoName, nfc);
  const row = h.videoComments.get(r1.json.id);
  assert.equal(row.videoName, nfc);
  assert.equal(row.videoKey, JSON.stringify([nfc, 77]));
  await post(a, o, body({ videoName: nfc, videoSize: 77, text: 'NFC で送った' }));
  assert.equal(new Set(h.videoComments.listStudy(o.id).map((c) => c.videoKey)).size, 1);
});
