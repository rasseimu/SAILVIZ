// test/reflection-extras-api.test.js — 反省の進捗とコメントの API(/api/reflections/:id/...。設計書 Phase 4 §6)。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, clock } from './helpers/apiHarness.js';

let h;
before(async () => { if (!skip) h = await startApi(); });
after(async () => { if (h) await h.close(); });

const refl = (over = {}) => ({
  origin: 'app', visibility: 'org', createdAt: 1791015000000, text: '', people: ['乗員1'], videos: [],
  sessionId: null, wind: null, practice: { date: '2026/10/26', startMs: null, endMs: null },
  rig: { boatNo: '4321', gear: null, prebend: 30 }, waveHeight: null,
  notes: { goal: 'g', issue: 'i', discovery: '', slowFactor: '', fastFactor: '' }, ...over,
});
let n = 0;
const rid = () => `refl1791015000000_x${++n}`;
const org = (o) => ({ 'x-sailviz-org': o.id });
// 反省を作る(作成者の表示中の組織を o にする)。
const mkRefl = async (u, o, visibility) => {
  const id = rid();
  const r = await h.call('PUT', `/api/me/reflections/${id}`, u.tok, refl({ visibility }), o ? org(o) : {});
  assert.equal(r.status, 200);
  return id;
};
const prog = (id, tok, method = 'GET', body, headers) => h.call(method, `/api/reflections/${id}/progress`, tok, body, headers);
const coms = (id, tok, method = 'GET', body, headers) => h.call(method, `/api/reflections/${id}/comments`, tok, body, headers);

test('progress: 本人は読み書きでき、同じ組織のメンバーは org の反省を読み書きできる', { skip }, async () => {
  const u = h.mkUser(); const m = h.mkUser(); const o = h.mkOrg(u, m);
  const id = await mkRefl(u, o, 'org');
  assert.deepEqual(await (await prog(id, u.tok)).json(), { issueStage: null, goalDone: false, text: null });
  const r1 = await prog(id, u.tok, 'PUT', { issueStage: 2, text: { goal: 'x' } });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { issueStage: 2, goalDone: false, text: { goal: 'x' } });
  // 渡したキーだけ更新する(issueStage・text はそのまま)
  const r2 = await prog(id, m.tok, 'PUT', { goalDone: true }, org(o));
  assert.equal(r2.status, 200);
  assert.deepEqual(await (await prog(id, m.tok, 'GET', undefined, org(o))).json(), { issueStage: 2, goalDone: true, text: { goal: 'x' } });
  // extra は保つ
  h.db.prepare('UPDATE reflection_progress SET extra = ? WHERE reflection_id = ?').run('{"deleted":{"goal":true}}', id);
  await prog(id, u.tok, 'PUT', { issueStage: null });
  const row = h.db.prepare('SELECT * FROM reflection_progress WHERE reflection_id = ?').get(id);
  assert.equal(row.extra, '{"deleted":{"goal":true}}');
  assert.equal(row.issue_stage, null);
  // 検証
  for (const b of [{ issueStage: 1.5 }, { issueStage: '1' }, { goalDone: 1 }, []]) {
    const r = await prog(id, u.tok, 'PUT', b);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
});

test('progress: 他人の private 反省は GET/PUT とも 404 で、存在しない ID と同じ応答', { skip }, async () => {
  const u = h.mkUser(); const m = h.mkUser(); const o = h.mkOrg(u, m);
  const id = await mkRefl(u, o, 'private');
  const none = rid();
  for (const [method, body] of [['GET'], ['PUT', { goalDone: true }]]) {
    const a = await prog(id, m.tok, method, body, org(o));
    const b = await prog(none, m.tok, method, body, org(o));
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.deepEqual(await a.json(), await b.json());
  }
  const c1 = await coms(id, m.tok, 'GET', undefined, org(o));
  const c2 = await coms(none, m.tok, 'GET', undefined, org(o));
  assert.equal(c1.status, 404);
  assert.deepEqual(await c1.json(), await c2.json());
  assert.equal((await coms(id, m.tok, 'POST', { field: 'goal', text: 'x' }, org(o))).status, 404);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM reflection_progress WHERE reflection_id = ?').get(id).c, 0);
});

test('progress: public の反省は組織外のログインユーザーが読めるが PUT は 403', { skip }, async () => {
  const u = h.mkUser(); const x = h.mkUser(); const o = h.mkOrg(u);
  const id = await mkRefl(u, o, 'public');
  await prog(id, u.tok, 'PUT', { issueStage: 1 });
  const g = await prog(id, x.tok);
  assert.equal(g.status, 200);
  assert.equal((await g.json()).issueStage, 1);
  // 未ログインも public は読める
  assert.equal((await prog(id, null)).status, 200);
  const p = await prog(id, x.tok, 'PUT', { issueStage: 3 });
  assert.equal(p.status, 403);
  assert.equal((await p.json()).error.code, 'forbidden');
  assert.equal((await prog(id, null, 'PUT', { issueStage: 3 })).status, 401);
  // 組織外のログインユーザーも public にはコメントできる
  assert.equal((await coms(id, x.tok, 'POST', { field: 'goal', text: '外から' })).status, 201);
});

test('comments: POST すると書いた人と名前が付いて GET に出る', { skip }, async () => {
  const u = h.mkUser(); const m = h.mkUser(); const o = h.mkOrg(u, m);
  const id = await mkRefl(u, o, 'org');
  const r = await coms(id, m.tok, 'POST', { field: 'goal', text: 'いいね' }, org(o));
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.id, `${id}#goal#0`);
  assert.equal(c.field, 'goal');
  assert.equal(c.text, 'いいね');
  assert.equal(c.ts, 1_000_000);
  assert.equal(c.authorUserId, m.user.id);
  assert.equal(c.authorName, m.user.name);
  const c2 = await (await coms(id, u.tok, 'POST', { field: 'goal', text: '次' })).json();
  assert.equal(c2.id, `${id}#goal#1`);
  // 作者のいない(Web の)コメントは authorName が null
  h.db.prepare('INSERT INTO reflection_comments (id, reflection_id, field, text, ts, author_user_id, extra) VALUES (?, ?, ?, ?, ?, NULL, NULL)')
    .run(`${id}#issue#0`, id, 'issue', '古い', 5);
  const l = await (await coms(id, u.tok)).json();
  assert.deepEqual(l.map((x) => [x.text, x.authorName]), [['古い', null], ['いいね', m.user.name], ['次', u.user.name]]);
  assert.deepEqual(Object.keys(l[1]).sort(), ['authorName', 'authorUserId', 'field', 'id', 'text', 'ts']);
});

test('comments: POST したコメントが互換 readOverlay(\'progress\') に field の配列として出る', { skip }, async () => {
  const u = h.mkUser(); const o = h.mkOrg(u);
  const id = await mkRefl(u, o, 'org');
  await coms(id, u.tok, 'POST', { field: 'issue', text: 'a' });
  await coms(id, u.tok, 'POST', { field: 'issue', text: 'b' });
  const ov = await h.repo.readOverlay('progress');
  assert.deepEqual(ov[id].comments.issue, [
    // 名前は Web の名簿と同じ(反省の people[0] '乗員1' がこの組織での旧氏名になる)
    { text: 'a', ts: 1_000_000, authorUserId: u.user.id, author: '乗員1', via: 'api' },
    { text: 'b', ts: 1_000_000, authorUserId: u.user.id, author: '乗員1', via: 'api' },
  ]);
  // 互換の全置き換えで往復しても変わらない
  await h.repo.writeOverlay('progress', ov);
  assert.deepEqual((await h.repo.readOverlay('progress'))[id], ov[id]);
  assert.equal((await (await coms(id, u.tok)).json()).length, 2);
});

test('comments: text が空・2000 字超は 422、未ログイン POST は 401', { skip }, async () => {
  const u = h.mkUser(); const o = h.mkOrg(u);
  const id = await mkRefl(u, o, 'public');
  for (const b of [{ field: 'goal', text: '' }, { field: 'goal', text: 'あ'.repeat(2001) }, { field: '', text: 'x' },
    { field: 'f'.repeat(51), text: 'x' }, { field: 'goal' }, { text: 'x' }]) {
    const r = await coms(id, u.tok, 'POST', b);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
  assert.equal((await coms(id, u.tok, 'POST', { field: 'goal', text: 'あ'.repeat(2000) })).status, 201);
  const a = await coms(id, null, 'POST', { field: 'goal', text: 'x' });
  assert.equal(a.status, 401);
  assert.equal((await a.json()).error.code, 'unauthorized');
});

test('互換の進捗保存: Web が読んだ後にアプリで足したコメントは、古い進捗の PUT でも消えない', { skip }, async () => {
  const u = h.mkUser(); const o = h.mkOrg(u);
  const id = await mkRefl(u, o, 'org');
  await prog(id, u.tok, 'PUT', { issueStage: 1 });
  const old = await (await h.call('GET', '/api/overlays/progress', u.tok)).json();
  await coms(id, u.tok, 'POST', { field: 'goal', text: 'アプリから' });
  const r = await h.call('PUT', '/api/overlays/progress', u.tok, { ...old, [id]: { ...old[id], issueStage: 2 } });
  assert.equal(r.status, 200);
  const after = await (await coms(id, u.tok)).json();
  assert.deepEqual(after.map((c) => c.text), ['アプリから']);
  assert.equal((await (await prog(id, u.tok)).json()).issueStage, 2);
});

test('DB でないとき（app 無し）は /api/reflections/* が 503', { skip }, async () => {
  const x = await startApi({ app: null });
  try {
    const u = x.mkUser();
    const r = await x.call('GET', '/api/reflections/refl1_x/progress', u.tok);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'unavailable');
  } finally { await x.close(); }
});

test('互換の進捗保存: 進捗行の無いうちに Web が読み、その後アプリで最初のコメントを足しても、古い進捗の PUT で消えない', { skip }, async () => {
  const u = h.mkUser(); const o = h.mkOrg(u);
  const id = await mkRefl(u, o, 'org');
  const old = await (await h.call('GET', '/api/overlays/progress', u.tok)).json();
  assert.equal(id in old, false);
  await coms(id, u.tok, 'POST', { field: 'issue', text: '最初' });
  const r = await h.call('PUT', '/api/overlays/progress', u.tok, old);
  assert.equal(r.status, 200);
  assert.deepEqual((await (await coms(id, u.tok)).json()).map((c) => c.text), ['最初']);
  assert.deepEqual(await (await prog(id, u.tok)).json(), { issueStage: null, goalDone: false, text: null });
});

// ---------- Web のコメントの名前と、読んだ時刻による削除 ----------
// 時計を進められるサーバ(t を書き換える)。
let t = clock;
let k;
before(async () => { if (!skip) k = await startApi({ authOptions: { now: () => t } }); });
after(async () => { if (k) await k.close(); });
const kRefl = async (u, o) => {
  const id = rid();
  assert.equal((await k.call('PUT', `/api/me/reflections/${id}`, u.tok, refl({ visibility: 'org' }), org(o))).status, 200);
  return id;
};
const kGet = async (u) => {
  const r = await k.call('GET', '/api/overlays/progress', u.tok);
  assert.equal(r.status, 200);
  return { readAt: r.headers.get('x-sailviz-read-at'), body: await r.json() };
};
const kPut = (u, body, readAt) => k.call('PUT', '/api/overlays/progress', u.tok, body, readAt ? { 'x-sailviz-read-at': readAt } : {});
const kComs = async (id, u) => (await (await k.call('GET', `/api/reflections/${id}/comments`, u.tok)).json());

test('互換の進捗: GET は読んだ時刻を X-Sailviz-Read-At で返す', { skip }, async () => {
  const u = k.mkUser(); k.mkOrg(u);
  t = clock + 5000;
  assert.equal((await kGet(u)).readAt, String(clock + 5000));
});

test('互換の進捗: 読んだ後にアプリで足したコメントは、読んだ時刻付きの古い PUT でも残る', { skip }, async () => {
  const u = k.mkUser(); const o = k.mkOrg(u);
  const id = await kRefl(u, o);
  t = clock + 10_000;
  const old = await kGet(u);
  t = clock + 20_000;
  await k.call('POST', `/api/reflections/${id}/comments`, u.tok, { field: 'goal', text: 'アプリから' });
  assert.equal((await kPut(u, old.body, old.readAt)).status, 200);
  assert.deepEqual((await kComs(id, u)).map((c) => c.text), ['アプリから']);
});

test('互換の進捗: 読んだ時刻より前からあるアプリのコメントは、Web から消せる', { skip }, async () => {
  const u = k.mkUser(); const o = k.mkOrg(u);
  const id = await kRefl(u, o);
  t = clock + 30_000;
  await k.call('POST', `/api/reflections/${id}/comments`, u.tok, { field: 'goal', text: '消す' });
  t = clock + 40_000;
  const cur = await kGet(u);
  assert.equal(cur.body[id].comments.goal.length, 1);
  const r = await kPut(u, { ...cur.body, [id]: { ...cur.body[id], comments: {} } }, cur.readAt);
  assert.equal(r.status, 200);
  assert.deepEqual(await kComs(id, u), []);
});

test('互換の進捗: Web は名簿の名前付きでコメントを足せて、消せる', { skip }, async () => {
  const u = k.mkUser(); const o = k.mkOrg(u);
  const id = await kRefl(u, o);
  t = clock + 50_000;
  const cur = await kGet(u);
  // 名簿の名前は旧氏名(反省の people[0] '乗員1')
  const c = { text: 'Web から', ts: clock + 50_001, author: '乗員1' };
  assert.equal((await kPut(u, { ...cur.body, [id]: { comments: { issue: [c] } } }, cur.readAt)).status, 200);
  assert.deepEqual((await k.repo.readOverlay('progress'))[id].comments.issue, [c]);
  t = clock + 60_000;
  const cur2 = await kGet(u);
  assert.equal((await kPut(u, { ...cur2.body, [id]: { comments: {} } }, cur2.readAt)).status, 200);
  assert.equal((await k.repo.readOverlay('progress'))[id]?.comments, undefined);
});

test('互換の進捗: Web の新しいコメントに名前が無い・名簿外なら 400 で、何も保存しない', { skip }, async () => {
  const u = k.mkUser(); const o = k.mkOrg(u);
  const id = await kRefl(u, o);
  const cur = await kGet(u);
  // 新しいコメント(読んだ時刻より後の ts)
  const ts = Number(cur.readAt) + 1;
  for (const c of [{ text: '名無し', ts }, { text: '部外', ts, author: '部外者' }]) {
    const r = await kPut(u, { ...cur.body, [id]: { issueStage: 2, comments: { goal: [c] } } }, cur.readAt);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /名前/);
  }
  assert.equal((await k.repo.readOverlay('progress'))[id], undefined);
});
