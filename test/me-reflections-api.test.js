// test/me-reflections-api.test.js — 反省 API(/api/me/reflections。設計書 Phase 4 §4)。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip } from './helpers/apiHarness.js';

let h;
before(async () => { if (!skip) h = await startApi(); });
after(async () => { if (h) await h.close(); });

// アプリの buildReflection と同じ形の合成データ。
const refl = (over = {}) => ({
  origin: 'app', visibility: 'org', createdAt: 1791015000000, text: '', people: ['乗員1'], videos: [],
  sessionId: null, wind: null, practice: { date: '2026/10/26', startMs: null, endMs: null },
  rig: { boatNo: '4321', gear: null, prebend: 30 }, waveHeight: null,
  notes: { goal: 'g', issue: '', discovery: '', slowFactor: '', fastFactor: '' }, ...over,
});
let n = 0;
const rid = () => `refl1791015000000_t${++n}`;
const put = (id, tok, body, headers) => h.call('PUT', `/api/me/reflections/${id}`, tok, body, headers);
const list = async (tok, q = '') => (await h.call('GET', `/api/me/reflections${q}`, tok)).json();
const count = (id) => h.db.prepare("SELECT COUNT(*) c FROM reflections WHERE json_extract(body,'$.id') = ?").get(id).c;

test('PUT: 未ログインは 401', { skip }, async () => {
  const r = await put(rid(), null, refl());
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
});

test('PUT → GET: 送った反省が新しい順に出て、visibility と practiceDayId が付く', { skip }, async () => {
  const u = h.mkUser();
  const a = rid(); const b = rid();
  const ra = await put(a, u.tok, refl({ createdAt: 1791015000000, notes: { goal: 'old' } }));
  assert.equal(ra.status, 200);
  const { practiceDayId } = await ra.json();
  assert.ok(practiceDayId);
  await put(b, u.tok, refl({ createdAt: 1791015009999, notes: { goal: 'new' } }));
  const l = await list(u.tok);
  assert.deepEqual(l.map((x) => x.id), [b, a]);
  assert.equal(l[0].notes.goal, 'new');
  assert.equal(l[0].authorUserId, u.user.id);
  assert.equal(l[0].visibility, 'org');
  assert.equal(l[1].practiceDayId, practiceDayId);
});

test('PUT: 同じ reflId の再送は行が増えず created_at が変わらない', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const r1 = await (await put(id, u.tok, refl())).json();
  const c1 = h.db.prepare("SELECT created_at FROM reflections WHERE json_extract(body,'$.id') = ?").get(id).created_at;
  const r2 = await (await put(id, u.tok, refl({ notes: { goal: 'again' } }))).json();
  assert.deepEqual(r2, r1);
  assert.equal(count(id), 1);
  assert.equal(h.db.prepare("SELECT created_at FROM reflections WHERE json_extract(body,'$.id') = ?").get(id).created_at, c1);
  assert.equal((await list(u.tok))[0].notes.goal, 'again');
});

test('PUT: 日付の形の揺れは同じ器、日付が無ければ 422', { skip }, async () => {
  const u = h.mkUser();
  const a = await (await put(rid(), u.tok, refl({ practice: { date: '2026/10/26' } }))).json();
  const b = await (await put(rid(), u.tok, refl({ practice: { date: '2026-10-26' } }))).json();
  const c = await (await put(rid(), u.tok, refl({ practice: { date: '2026/1/5' } }))).json();
  const d = await (await put(rid(), u.tok, refl({ practice: { date: '2026-01-05' } }))).json();
  assert.equal(a.practiceDayId, b.practiceDayId);
  assert.equal(c.practiceDayId, d.practiceDayId);
  assert.notEqual(a.practiceDayId, c.practiceDayId);
  for (const practice of [{}, { date: '' }, { date: 'xx' }, { date: '2026/13/40' }, null]) {
    assert.equal((await put(rid(), u.tok, refl({ practice }))).status, 422);
  }
});

test('PUT: 日付を変えると別の器へ移る', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const a = await (await put(id, u.tok, refl({ practice: { date: '2026/10/26' } }))).json();
  const b = await (await put(id, u.tok, refl({ practice: { date: '2026/10/27' } }))).json();
  assert.notEqual(a.practiceDayId, b.practiceDayId);
  assert.equal(count(id), 1);
  assert.equal((await list(u.tok))[0].practiceDayId, b.practiceDayId);
  assert.equal(h.repo.readProject(a.practiceDayId).reflections.length, 0);
});

test('PUT: X-Sailviz-Org の組織×日付の器に入り、組織が無ければ本人×日付', { skip }, async () => {
  const u = h.mkUser(); const org = h.mkOrg(u);
  const inOrg = await (await put(rid(), u.tok, refl(), { 'x-sailviz-org': org.id })).json();
  const v = h.mkUser(); // 所属なしの利用者(所属が1つだけなら既定で表示中の組織になるため)
  const solo = await (await put(rid(), v.tok, refl())).json();
  const o = h.db.prepare('SELECT org_id, owner_user_id FROM practice_days WHERE id = ?');
  assert.equal(o.get(inOrg.practiceDayId).org_id, org.id);
  assert.equal(o.get(solo.practiceDayId).org_id, null);
  assert.equal(o.get(solo.practiceDayId).owner_user_id, v.user.id);
});

test('PUT: 他人の reflId は 409、作者なしの旧データの reflId も 409', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, a.tok, refl())).json();
  const r = await put(id, b.tok, refl());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'conflict');
  const legacy = rid();
  h.db.prepare(`INSERT INTO reflections (id, practice_day_id, position, author_user_id, visibility, body, created_at, updated_at)
                VALUES ('old_r_1', ?, 9, NULL, 'org', ?, 1, 1)`).run(practiceDayId, JSON.stringify({ id: legacy }));
  assert.equal((await put(legacy, a.tok, refl())).status, 409);
});

test('PUT: visibility が不正なら 422、本文が配列なら 422', { skip }, async () => {
  const u = h.mkUser();
  assert.equal((await put(rid(), u.tok, refl({ visibility: 'all' }))).status, 422);
  assert.equal((await put(rid(), u.tok, refl({ visibility: undefined }))).status, 422);
  assert.equal((await put(rid(), u.tok, [refl()])).status, 422);
});

test('PUT / DELETE: reflId の % エスケープが壊れていても 500 にせず 422', { skip }, async () => {
  const u = h.mkUser();
  for (const method of ['PUT', 'DELETE']) {
    const r = await h.call(method, '/api/me/reflections/bad%E0%A4%A', u.tok, method === 'PUT' ? refl() : undefined);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
});

test('PUT: 互換 GET /api/projects/:id の reflections に同じ内容で出る', { skip }, async () => {
  const u = h.mkUser(); const id = rid(); const body = refl();
  const { practiceDayId } = await (await put(id, u.tok, body)).json();
  const got = h.repo.readProject(practiceDayId).reflections;
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { ...body, id, authorUserId: u.user.id });
});

test('GET: limit の既定は 20、上限は 100', { skip }, async () => {
  const u = h.mkUser();
  for (let i = 0; i < 105; i += 1) await put(rid(), u.tok, refl({ createdAt: 1791015000000 + i }));
  assert.equal((await list(u.tok)).length, 20);
  assert.equal((await list(u.tok, '?limit=5')).length, 5);
  assert.equal((await list(u.tok, '?limit=1000')).length, 100);
  assert.equal((await list(u.tok, '?limit=abc')).length, 20);
});

test('DELETE: 自分の反省を消すと 204、GET から消え、進捗・コメントも消える。他人の反省は 404', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, a.tok, refl())).json();
  h.db.prepare("INSERT INTO reflection_progress (reflection_id, goal_done, updated_at) VALUES (?, 1, 1)").run(id);
  h.db.prepare("INSERT INTO reflection_comments (id, reflection_id, field, text, ts) VALUES ('c1', ?, 'goal', 'x', 1)").run(id);
  assert.equal((await h.call('DELETE', `/api/me/reflections/${id}`, b.tok)).status, 404);
  assert.equal(count(id), 1);
  const rev0 = h.db.prepare('SELECT rev FROM practice_days WHERE id = ?').get(practiceDayId).rev;
  assert.equal((await h.call('DELETE', `/api/me/reflections/${id}`, a.tok)).status, 204);
  assert.equal(count(id), 0);
  assert.equal((await list(a.tok)).some((x) => x.id === id), false);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM reflection_progress WHERE reflection_id = ?').get(id).c, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM reflection_comments WHERE reflection_id = ?').get(id).c, 0);
  assert.equal(h.db.prepare('SELECT rev FROM practice_days WHERE id = ?').get(practiceDayId).rev, rev0 + 1);
  assert.equal((await h.call('DELETE', `/api/me/reflections/${id}`, a.tok)).status, 404);
});

test('DELETE: 同じ body.id の別の行が残るときは進捗を消さない', { skip }, async () => {
  const a = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, a.tok, refl())).json();
  h.db.prepare(`INSERT INTO reflections (id, practice_day_id, position, author_user_id, visibility, body, created_at, updated_at)
                VALUES ('dup_r_1', ?, 9, NULL, 'org', ?, 1, 1)`).run(practiceDayId, JSON.stringify({ id }));
  h.db.prepare("INSERT INTO reflection_progress (reflection_id, goal_done, updated_at) VALUES (?, 1, 1)").run(id);
  assert.equal((await h.call('DELETE', `/api/me/reflections/${id}`, a.tok)).status, 204);
  assert.equal(count(id), 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM reflection_progress WHERE reflection_id = ?').get(id).c, 1);
});

test('DB でないとき（app 無し）は 503', { skip }, async () => {
  const x = await startApi({ app: null });
  try {
    const u = x.mkUser();
    const r = await x.call('PUT', '/api/me/reflections/refl1_x', u.tok, refl());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'unavailable');
  } finally { await x.close(); }
});

// ---- 互換保存(Web の writeProject)でアプリの反省を守る(設計書 Phase 4 §4) ----
const webSave = (pdId, proj) => h.repo.writeProject(pdId, proj, { managedReflection: () => true });
const ids = (pdId) => h.repo.readProject(pdId).reflections.map((r) => r.id);

test('互換保存: Web が読んだ後にアプリが反省を足し、古い一覧で保存しても残る', { skip }, async () => {
  const u = h.mkUser(); const first = rid(); const second = rid();
  const { practiceDayId } = await (await put(first, u.tok, refl())).json();
  const stale = h.repo.readProject(practiceDayId); // Web が読む
  await put(second, u.tok, refl({ notes: { goal: 'あとから' } })); // アプリが足す
  webSave(practiceDayId, stale); // 古い一覧のまま保存
  assert.deepEqual(ids(practiceDayId).sort(), [first, second].sort());
  assert.equal(count(second), 1);
});

test('互換保存: Web がアプリの反省の本文を直して保存すると、本文が直り二重にならない', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, u.tok, refl())).json();
  for (const dropRev of [false, true]) {
    const proj = h.repo.readProject(practiceDayId);
    if (dropRev) delete proj._rev; // 古い画面扱い(守りが働く経路)
    const target = proj.reflections.find((r) => r.id === id);
    target.notes = { ...target.notes, goal: dropRev ? 'Web直し2' : 'Web直し1' };
    webSave(practiceDayId, proj);
    assert.equal(count(id), 1);
    assert.equal(h.repo.readProject(practiceDayId).reflections.find((r) => r.id === id).notes.goal, dropRev ? 'Web直し2' : 'Web直し1');
  }
});

test('互換保存: _rev が今の rev と一致すれば、Web はアプリの反省を消せる', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, u.tok, refl())).json();
  const proj = h.repo.readProject(practiceDayId); // _rev は今の rev
  proj.reflections = proj.reflections.filter((r) => r.id !== id);
  webSave(practiceDayId, proj);
  assert.equal(count(id), 0);
});

test('互換保存: Web で作った反省（作者なし）は今までどおり消せる', { skip }, async () => {
  const u = h.mkUser(); const appId = rid(); const webId = rid();
  const { practiceDayId } = await (await put(appId, u.tok, refl())).json();
  const withWeb = h.repo.readProject(practiceDayId);
  withWeb.reflections.push({ id: webId, origin: 'web', createdAt: 1791015001000, notes: { goal: 'web' } });
  webSave(practiceDayId, withWeb);
  assert.equal(count(webId), 1);
  const stale = h.repo.readProject(practiceDayId); // 古い _rev にして保存の守りを働かせる
  stale._rev = 0;
  stale.reflections = stale.reflections.filter((r) => r.id !== webId);
  webSave(practiceDayId, stale);
  assert.equal(count(webId), 0); // 作者なしは消える
  assert.equal(count(appId), 1); // アプリの行は残る
});

test('互換保存: アプリが消した反省は、Web の古い画面からの保存で戻らない', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const { practiceDayId } = await (await put(id, u.tok, refl({ visibility: 'private' }))).json();
  const stale = h.repo.readProject(practiceDayId); // Web が読む
  assert.equal((await h.call('DELETE', `/api/me/reflections/${id}`, u.tok)).status, 204); // アプリが消す
  webSave(practiceDayId, stale); // 古い一覧のまま保存
  assert.equal(count(id), 0); // 作者なし・組織公開の行として戻らない
});

test('互換保存: アプリが別の日へ移した反省は、Web の古い画面からの保存で元の日に写しができない', { skip }, async () => {
  const u = h.mkUser(); const id = rid();
  const { practiceDayId: oldDay } = await (await put(id, u.tok, refl({ visibility: 'private' }))).json();
  const stale = h.repo.readProject(oldDay); // Web が元の日を読む
  const { practiceDayId: newDay } = await (await put(id, u.tok, refl({ visibility: 'private', practice: { date: '2026/10/27' } }))).json();
  assert.notEqual(newDay, oldDay);
  webSave(oldDay, stale); // 元の日を古い一覧のまま保存
  const rows = h.db.prepare("SELECT practice_day_id, author_user_id, visibility FROM reflections WHERE json_extract(body,'$.id') = ?").all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].practice_day_id, newDay);
  assert.equal(rows[0].author_user_id, u.user.id);
  assert.equal(rows[0].visibility, 'private');
});
