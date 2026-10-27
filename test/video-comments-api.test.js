// test/video-comments-api.test.js — 動画の瞬間コメントの API(②)。
//   GET/POST /api/projects/:id/video-comments、PATCH/DELETE /api/video-comments/:cid。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { startApi, skip, clock } from './helpers/apiHarness.js';
import { createApi } from '../server/api.js';

const SHARED_ORG = 'o_sharedtest';
let h;
before(async () => { if (!skip) h = await startApi({ migrationOrgId: SHARED_ORG }); });
after(async () => { if (h) await h.close(); });

const orgH = (o) => ({ 'x-sailviz-org': typeof o === 'string' ? o : o.id });
const pdId = () => `pd_${randomBytes(5).toString('hex')}`;
let rseq = 0;
// 練習日の器を直接作る。items は反省の公開範囲と作者([{ vis, owner, legacyName }])。器の組織は orgId(null 可)。
const mkDay = (orgId, items = []) => {
  const id = pdId();
  h.db.prepare("INSERT INTO practice_days (id, org_id, date, rev, created_at, updated_at) VALUES (?, ?, '2026-10-26', 0, 1, 1)").run(id, orgId);
  for (const it of items) {
    rseq += 1;
    h.db.prepare('INSERT INTO reflections (id, practice_day_id, position, author_user_id, legacy_author_name, visibility, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)')
      .run(`r_${rseq}`, id, rseq, it.owner ?? null, it.legacyName ?? null, it.vis, JSON.stringify({ id: `refl_${rseq}` }));
  }
  return id;
};
const vcPath = (id) => `/api/projects/${encodeURIComponent(id)}/video-comments`;
const body = (over = {}) => ({ videoName: 'IMG_0001.MOV', videoT: 1791015000000, positionMs: 12_340, text: 'タックが遅い', ...over });
const json = async (r) => ({ status: r.status, json: await r.json() });
const post = async (id, u, o, b = body()) => json(await h.call('POST', vcPath(id), u?.tok, b, o ? orgH(o) : {}));
const list = async (id, tok, headers = {}) => json(await h.call('GET', vcPath(id), tok, undefined, headers));

test('POST → GET: 位置順・形・名前(旧氏名 → 表示名)・canEdit/canDelete', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const o = h.mkOrg(a, b); // a が管理者
  // b はこの組織での旧氏名を持つ
  const id = mkDay(o.id, [{ vis: 'org', owner: b.user.id, legacyName: '旧氏名テスト' }]);
  const r1 = await post(id, b, o, body({ positionMs: 60_000, text: 'あと' }));
  assert.equal(r1.status, 201);
  assert.deepEqual(Object.keys(r1.json).sort(), ['authorName', 'authorUserId', 'canDelete', 'canEdit', 'createdAt', 'id', 'positionMs', 'text', 'updatedAt', 'videoName', 'videoT']);
  assert.equal(r1.json.authorName, '旧氏名テスト');
  assert.equal(r1.json.videoT, 1791015000000);
  assert.equal(r1.json.createdAt, clock);
  assert.equal(r1.json.canEdit, true);
  const r2 = await post(id, a, o, body({ positionMs: 1000, text: 'さき' }));
  assert.equal(r2.status, 201);
  assert.equal(r2.json.authorName, a.user.name);

  // a(管理者)から見る: 自分のは編集・削除、b のは削除だけ
  const la = await list(id, a.tok, orgH(o));
  assert.equal(la.status, 200);
  assert.equal(la.json.canWrite, true);
  assert.deepEqual(la.json.comments.map((c) => [c.text, c.authorName, c.canEdit, c.canDelete]), [
    ['さき', a.user.name, true, true], ['あと', '旧氏名テスト', false, true],
  ]);
  // b(管理者でない)から見る: 自分のだけ編集・削除
  const lb = await list(id, b.tok, orgH(o));
  assert.deepEqual(lb.json.comments.map((c) => [c.canEdit, c.canDelete]), [[false, false], [true, true]]);
  // 名前は表に保存しない
  const cols = h.db.prepare('PRAGMA table_info(video_comments)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /name/.test(c) && c !== 'video_name'));
});

test('GET の判定表: 401 / 403 / 404 / 組織外は空', { skip }, async () => {
  const a = h.mkUser(); const m = h.mkUser(); const x = h.mkUser(); const two = h.mkUser();
  const o = h.mkOrg(a, m, two); const ox = h.mkOrg(x); h.accounts.linkMember({ orgId: ox.id, userId: two.user.id, rosterId: null, now: clock });
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  await post(id, a, o);
  const notFound = (r) => { assert.equal(r.status, 404); assert.equal(r.json.error.code, 'not_found'); };
  // 未ログイン
  const r401 = await list(id, null);
  assert.equal(r401.status, 401);
  assert.equal(r401.json.error.code, 'unauthorized');
  // 所属外の組織をヘッダーで指す
  const r403 = await list(id, a.tok, orgH(ox));
  assert.equal(r403.status, 403);
  assert.equal(r403.json.error.code, 'org_forbidden');
  // 他組織のユーザー
  notFound(await list(id, x.tok));
  // メンバーだが表示中の組織が別
  notFound(await list(id, two.tok, orgH(ox)));
  assert.equal((await list(id, two.tok, orgH(o))).json.comments.length, 1);
  // 存在しない練習・形の違う ID
  notFound(await list(pdId(), a.tok));
  notFound(await list('bad id', a.tok));
  // 全部他人の private の練習
  const priv = mkDay(o.id, [{ vis: 'private', owner: a.user.id }]);
  notFound(await list(priv, m.tok, orgH(o)));
  assert.equal((await list(priv, a.tok, orgH(o))).status, 200);
  // 組織を抜けた本人(自分の private でも)
  const leaver = h.mkUser(); h.accounts.linkMember({ orgId: o.id, userId: leaver.user.id, rosterId: null, now: clock });
  const mine = mkDay(o.id, [{ vis: 'private', owner: leaver.user.id }]);
  assert.equal((await list(mine, leaver.tok)).status, 200);
  h.accounts.unlinkMember(o.id, leaver.user.id);
  notFound(await list(mine, leaver.tok));
  // 他組織の public 練習は読めるが、コメントは空(名前を組織の外に出さない)
  const pub = mkDay(o.id, [{ vis: 'public', owner: a.user.id }]);
  await post(pub, a, o);
  const sharedOutside = await list(pub, 'shared-secret'); // SHARED_ORG の共有ログイン
  assert.equal(sharedOutside.status, 200);
  assert.deepEqual(sharedOutside.json, { comments: [], canWrite: false });
  // 組織の無い public の器: 読めるが空、書けない
  const noOrg = mkDay(null, [{ vis: 'public', owner: null }]);
  assert.deepEqual((await list(noOrg, 'shared-secret')).json, { comments: [], canWrite: false });
});

test('共有ログイン: 自組織の練習のコメントは読めるが、書けない・消せない・直せない', { skip }, async () => {
  h.db.prepare("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, 'テスト組織', 1)").run(SHARED_ORG);
  const a = h.mkUser();
  h.accounts.linkMember({ orgId: SHARED_ORG, userId: a.user.id, rosterId: null, now: clock });
  const id = mkDay(SHARED_ORG, [{ vis: 'org', owner: a.user.id }]);
  const c = (await post(id, a, SHARED_ORG)).json;
  const l = await list(id, 'shared-secret');
  assert.equal(l.status, 200);
  assert.equal(l.json.canWrite, false);
  assert.deepEqual(l.json.comments.map((x) => [x.id, x.canEdit, x.canDelete]), [[c.id, false, false]]);
  const p = await json(await h.call('POST', vcPath(id), 'shared-secret', body()));
  assert.equal(p.status, 403);
  assert.equal(p.json.error.code, 'forbidden');
  assert.equal((await h.call('PATCH', `/api/video-comments/${c.id}`, 'shared-secret', { text: 'x' })).status, 403);
  assert.equal((await h.call('DELETE', `/api/video-comments/${c.id}`, 'shared-secret')).status, 403);
  assert.equal(h.videoComments.get(c.id).text, 'タックが遅い');
});

test('MIGRATION_ORG_ID 未設定の共有ログインは 404', { skip }, async () => {
  const api = createApi({ repo: h.repo, token: 'shared-secret', accounts: h.accounts, app: h.app, videoComments: h.videoComments });
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const a = h.mkUser(); const o = h.mkOrg(a);
    const id = mkDay(o.id, [{ vis: 'public', owner: a.user.id }]);
    const r = await fetch(`http://127.0.0.1:${s.address().port}${vcPath(id)}`, { headers: { authorization: 'Bearer shared-secret' } });
    assert.equal(r.status, 404);
  } finally { await new Promise((r) => s.close(r)); }
});

test('POST の判定順と入力検証', { skip }, async () => {
  const a = h.mkUser(); const x = h.mkUser(); const o = h.mkOrg(a); const ox = h.mkOrg(x);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  assert.equal((await post(id, null)).status, 401);
  assert.equal((await post(id, a, ox)).status, 403); // org_forbidden
  assert.equal((await post(id, x)).status, 404);
  assert.equal((await post(pdId(), a)).status, 404);
  // 組織の無い器(読めるが書けない)は 403。ユーザーは組織の無い器を読めないので 404。
  const noOrg = mkDay(null, [{ vis: 'public', owner: null }]);
  assert.equal((await post(noOrg, a)).status, 404);
  // 入力不正は 422(本文の検証は権限の後)
  for (const b of [
    [], 'x', body({ videoName: '' }), body({ videoName: 'n'.repeat(256) }), body({ videoT: -1 }), body({ videoT: 1.5 }),
    body({ positionMs: -1 }), body({ positionMs: 86_400_001 }), body({ positionMs: 1.2 }), body({ text: '' }), body({ text: '  ' }),
    body({ text: 'a'.repeat(1001) }),
  ]) {
    const r = await post(id, a, o, b);
    assert.equal(r.status, 422, JSON.stringify(b).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid_input');
  }
  // 壊れた JSON は 422、大きすぎる本文は 413
  const bad = await fetch(`${h.base}${vcPath(id)}`, { method: 'POST', headers: { authorization: `Bearer ${a.tok}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 422);
  const big = await post(id, a, o, body({ text: 'a'.repeat(70 * 1024) }));
  assert.equal(big.status, 413);
  // 動画が練習の videos に無くても保存できる(動画の一覧と独立)
  assert.equal((await post(id, a, o, body({ videoName: 'まだ無い.mp4', positionMs: 86_400_000, text: 'a'.repeat(1000) }))).status, 201);
  assert.equal(h.videoComments.listByPracticeDay(id).length, 1);
});

test('PATCH: 本人だけ直せる(管理者も他人のは不可)。判定順と検証', { skip }, async () => {
  const a = h.mkUser(); const m = h.mkUser(); const x = h.mkUser(); const o = h.mkOrg(a, m); const ox = h.mkOrg(x);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  const c = (await post(id, m, o)).json; // m が書いた。a は管理者
  const patch = async (u, b, headers = {}) => json(await h.call('PATCH', `/api/video-comments/${c.id}`, u?.tok, b, headers));
  assert.equal((await patch(null, { text: 'x' })).status, 401);
  assert.equal((await patch(m, { text: 'x' }, orgH(ox))).status, 403);
  assert.equal((await patch(x, { text: 'x' })).status, 404);
  assert.equal((await json(await h.call('PATCH', '/api/video-comments/vc_none', m.tok, { text: 'x' }))).status, 404);
  const admin = await patch(a, { text: '管理者' });
  assert.equal(admin.status, 403);
  assert.equal(admin.json.error.code, 'forbidden');
  for (const b of [{ text: '' }, { text: ' ' }, { text: 'a'.repeat(1001) }, {}, []]) assert.equal((await patch(m, b)).status, 422);
  const ok = await patch(m, { text: '直した' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.text, '直した');
  assert.equal(ok.json.canEdit, true);
  assert.equal(h.videoComments.get(c.id).text, '直した');
});

test('DELETE: 本人と組織の管理者は消せる。他のメンバーは 403', { skip }, async () => {
  const a = h.mkUser(); const m = h.mkUser(); const n = h.mkUser(); const o = h.mkOrg(a, m, n);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  const c1 = (await post(id, m, o)).json;
  const c2 = (await post(id, m, o)).json;
  const del = async (u, cid) => json(await h.call('DELETE', `/api/video-comments/${cid}`, u?.tok));
  assert.equal((await del(null, c1.id)).status, 401);
  assert.equal((await del(n, c1.id)).status, 403);
  assert.deepEqual(await del(m, c1.id), { status: 200, json: { ok: true } });
  assert.deepEqual(await del(a, c2.id), { status: 200, json: { ok: true } });
  assert.equal((await del(m, c1.id)).status, 404);
  assert.equal(h.videoComments.listByPracticeDay(id).length, 0);
});

test('練習を消してもコメントの行は残り、読み書きは 404', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  const c = (await post(id, a, o)).json;
  const r = await h.call('DELETE', `/api/projects/${id}`, a.tok);
  assert.equal(r.status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM practice_days WHERE id = ?').get(id).c, 0);
  assert.ok(h.videoComments.get(c.id), 'コメントの行は残る');
  assert.equal((await list(id, a.tok)).status, 404);
  assert.equal((await h.call('PATCH', `/api/video-comments/${c.id}`, a.tok, { text: 'x' })).status, 404);
  assert.equal((await h.call('DELETE', `/api/video-comments/${c.id}`, a.tok)).status, 404);
  assert.ok(h.videoComments.get(c.id));
});

test('コメントしても GET /api/projects/:id と動画一覧は変わらない', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const project = { version: 1, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 }, tracks: [], events: [], marks: [], pins: [], reflections: [],
    videos: [{ id: 'vid0', t: 1791015000000, name: 'IMG_0001.MOV', durationMs: 60_000 }] };
  const cr = await h.call('POST', '/api/projects', a.tok, { name: 'sailviz-20261026-0900.sailviz.json', project }, orgH(o));
  assert.equal(cr.status, 201);
  const { id } = await cr.json();
  const before = await (await h.call('GET', `/api/projects/${id}`, a.tok)).json();
  const vBefore = await (await h.call('GET', `/api/projects/${id}/videos`, a.tok)).json();
  assert.equal((await post(id, a, o)).status, 201);
  const c = h.videoComments.listByPracticeDay(id)[0];
  await h.call('PATCH', `/api/video-comments/${c.id}`, a.tok, { text: '直す' });
  assert.deepEqual(await (await h.call('GET', `/api/projects/${id}`, a.tok)).json(), before);
  assert.deepEqual(await (await h.call('GET', `/api/projects/${id}/videos`, a.tok)).json(), vBefore);
  // 練習の中身が空(反省・軌跡なし)の器も、組織のメンバーはコメントを読める
  assert.equal((await list(id, a.tok)).json.comments.length, 1);
});

test('別の動作: 対象外のメソッドは no route、ファイル版(repo なし)は 503', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  assert.equal((await h.call('PUT', vcPath(id), a.tok, {})).status, 404);
  assert.equal((await h.call('GET', '/api/video-comments/vc_x', a.tok)).status, 404);
  // コメントの repo の無い createApi と、ファイル版(STORAGE=file と同じ。アカウント・DB なし)
  for (const api of [
    createApi({ repo: h.repo, token: 'shared-secret', accounts: h.accounts }),
    createApi({ dataDir: '/nonexistent-sailviz-test', token: 'shared-secret', viewUser: 'dummy-user', viewPassword: 'dummy-pass' }),
  ]) {
    const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      for (const [method, path] of [['GET', vcPath(id)], ['POST', vcPath(id)], ['PATCH', '/api/video-comments/vc_x'], ['DELETE', '/api/video-comments/vc_x']]) {
        const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${a.tok}` } });
        assert.equal(r.status, 503, `${method} ${path}`);
        assert.equal((await r.json()).error.code, 'unavailable');
      }
    } finally { await new Promise((r) => s.close(r)); }
  }
});

test('練習の組織とコメントの組織が違う行は GET に出さない', { skip }, async () => {
  const a = h.mkUser(); const o = h.mkOrg(a);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  const ok = (await post(id, a, o)).json;
  // 何らかの理由で別の組織の行が同じ練習 ID に付いている(手で入れた・移行の誤り)
  const stray = h.videoComments.insert({
    orgId: 'o_elsewhere', scope: 'practice', practiceDayId: id, videoKey: '["IMG_0001.MOV",1791015000000]', videoName: 'IMG_0001.MOV',
    positionMs: 0, text: '別組織', authorUserId: a.user.id, now: clock,
  });
  const l = await list(id, a.tok, orgH(o));
  assert.deepEqual(l.json.comments.map((c) => c.id), [ok.id]);
  // 個別の操作でも読めない扱い(404)
  assert.equal((await h.call('PATCH', `/api/video-comments/${stray.id}`, a.tok, { text: 'x' }, orgH(o))).status, 404);
  assert.equal((await h.call('DELETE', `/api/video-comments/${stray.id}`, a.tok, undefined, orgH(o))).status, 404);
});

test('別の組織の管理者で、この組織では管理者でない人は、この組織の他人のコメントを削除できない', { skip }, async () => {
  const a = h.mkUser(); const m = h.mkUser();
  const o = h.mkOrg(a, m); // a が o の管理者
  const ox = h.mkOrg(m); // m は ox の管理者
  assert.equal(h.accounts.isOrgAdmin(ox.id, m.user.id), true);
  assert.equal(h.accounts.isOrgAdmin(o.id, m.user.id), false);
  const id = mkDay(o.id, [{ vis: 'org', owner: a.user.id }]);
  const c = (await post(id, a, o)).json;
  const l = await list(id, m.tok, orgH(o));
  assert.deepEqual(l.json.comments.map((y) => [y.id, y.canDelete]), [[c.id, false]]);
  for (const org of [o, ox]) {
    const r = await h.call('DELETE', `/api/video-comments/${c.id}`, m.tok, undefined, orgH(org));
    assert.equal(r.status, org === o ? 403 : 404);
  }
  assert.ok(h.videoComments.get(c.id));
});

test('使えるかの確認(練習 ID の形でない - )は DB 版で 404、ファイル版で 503', { skip }, async () => {
  assert.equal((await h.call('GET', '/api/projects/-/video-comments', null)).status, 404);
  const api = createApi({ dataDir: '/nonexistent-sailviz-test', token: 'shared-secret', viewUser: 'dummy-user', viewPassword: 'dummy-pass' });
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/api/projects/-/video-comments`)).status, 503);
  } finally { await new Promise((r) => s.close(r)); }
});
