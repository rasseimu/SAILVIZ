// test/server-org-switch.test.js
// 旧 API の組織の切り替え(X-Sailviz-Org)とアカウントでの書き込みの結合テスト(設計書 §5.2〜§5.8)。
// DB 版 repo + アカウント。node:sqlite が要る(Node >=22.5 / 24)。
// 合成データのみ。実名・実位置・資格情報は使わない。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skip = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
const TOKEN = 'dummy-write';
const A = 'o_alpha', B = 'o_beta', C = 'o_gamma'; // C は誰も所属しない組織
const NA = 'sailviz-20260501-0900.sailviz.json'; // A の練習(作成者は Y)
const NAPUB = 'sailviz-20260502-0900.sailviz.json'; // A の public な練習
const NB = 'sailviz-20260503-0900.sailviz.json'; // B の練習

let db, repo, dataDir, server, base;
let xTok, yTok, yId;
const ids = {}; // 名前 → 練習 ID

const refl = (id, text, people = ['テスト部員A']) => ({ id, people, createdAt: 1, notes: { goal: text } });
const proj = (over = {}) => ({ version: 1, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 }, tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [], ...over });
const rows = (sql, ...a) => db.prepare(sql).all(...a);

const call = async (method, path, { body, auth, org } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (org !== undefined) headers['x-sailviz-org'] = org;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 本文なし */ }
  return { status: r.status, json };
};
const orgOfDay = (id) => rows('SELECT org_id FROM practice_days WHERE id = ?', id)[0]?.org_id;

before(async () => {
  if (!hasSqlite) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createDbRepo } = await import('../server/repos/dbRepo.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  const { issueAuthToken } = await import('../server/accountAuth.js');
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-org-switch-'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  repo = createDbRepo({ db, dataDir });
  const accounts = createAccountsRepo({ db });
  const mk = (email, orgs) => {
    const u = accounts.createUser({ email, name: 'テスト', affiliationText: 'テスト部', passwordHash: 'x', agreedAt: 1 });
    for (const o of orgs) accounts.linkMember({ orgId: o, userId: u.id });
    return { id: u.id, tok: issueAuthToken(accounts, u.id).token };
  };
  const x = mk('x@example.com', [A, B]); // 所属の先頭は A
  const y = mk('y@example.com', [A]);
  xTok = x.tok; yTok = y.tok; yId = y.id;

  const api = createApi({ repo, token: TOKEN, accounts, migrationOrgId: A });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  ids[NA] = repo.createProject(proj({ reflections: [refl('rA', 'Aの目標')] }), { name: NA, orgId: A }).id;
  ids[NAPUB] = repo.createProject(proj({ reflections: [refl('rApub', 'Aの公開')] }), { name: NAPUB, orgId: A }).id;
  ids[NB] = repo.createProject(proj({ reflections: [refl('rB', 'Bの目標')] }), { name: NB, orgId: B }).id;
  // A の反省の作成者は Y(X は作成者ではない)。NAPUB の反省は public。
  db.prepare('UPDATE reflections SET author_user_id = ? WHERE practice_day_id = ?').run(yId, ids[NA]);
  db.prepare("UPDATE reflections SET visibility = 'public' WHERE practice_day_id = ?").run(ids[NAPUB]);
});
after(async () => {
  if (!hasSqlite) return;
  await new Promise((r) => server.close(r));
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('X はヘッダー B で B の練習だけが一覧に出る(A の public も出ない)', { skip }, async () => {
  const list = await call('GET', '/api/projects', { auth: xTok, org: B });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((p) => p.id), [ids[NB]]);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ['id', 'label', 'name']);
  const sums = await call('GET', '/api/summaries', { auth: xTok, org: B });
  assert.deepEqual(sums.json.map((r) => [r.id, r.name]), [[ids[NB], NB]]);
  assert.equal((await call('GET', `/api/projects/${ids[NAPUB]}`, { auth: xTok, org: B })).status, 404, 'A の public も読めない');
});

test('X はヘッダーなしで所属の先頭の組織の一覧になる', { skip }, async () => {
  const list = await call('GET', '/api/projects', { auth: xTok });
  assert.deepEqual(list.json.map((p) => p.id).sort(), [ids[NA], ids[NAPUB]].sort());
});

test('X は作成者でない A の練習・反省を PUT でき、B の器への PUT は 403', { skip }, async () => {
  const put = await call('PUT', `/api/projects/${ids[NA]}`, { auth: xTok, org: A, body: proj({ reflections: [refl('rA', 'Xが直した')] }) });
  assert.equal(put.status, 200);
  const got = await call('GET', `/api/projects/${ids[NA]}`, { auth: yTok });
  assert.equal(got.json.reflections[0].notes.goal, 'Xが直した');
  // 所有者のカラムは変えない(設計書 §5.5)
  assert.deepEqual(rows('SELECT author_user_id FROM reflections WHERE practice_day_id = ?', ids[NA]).map((r) => r.author_user_id), [yId]);
  const other = await call('PUT', `/api/projects/${ids[NB]}`, { auth: xTok, org: A, body: proj() });
  assert.equal(other.status, 403);
  assert.equal((await call('GET', `/api/projects/${ids[NB]}`, { auth: xTok, org: B })).json.reflections[0].notes.goal, 'Bの目標');
  assert.equal((await call('DELETE', `/api/projects/${ids[NB]}`, { auth: xTok, org: A })).status, 403);
  assert.equal((await call('PUT', '/api/projects/pd_0000000000', { auth: xTok, org: A, body: proj() })).status, 404, '無い器への PUT は 404');
});

test('X が POST した練習はヘッダーの組織に入る', { skip }, async () => {
  const name = 'sailviz-20260510-0900.sailviz.json';
  const r = await call('POST', '/api/projects', { auth: xTok, org: B, body: { name, project: proj({ reflections: [refl('rNewB', '新')] }) } });
  assert.equal(r.status, 201);
  assert.equal(r.json.name, name);
  assert.match(r.json.id, /^pd_[0-9a-f]{10}$/);
  assert.equal(orgOfDay(r.json.id), B);
  // 新しい反省の所有者は NULL のまま、公開範囲は org(設計書 §5.5)
  assert.deepEqual({ ...rows('SELECT author_user_id, visibility FROM reflections WHERE practice_day_id = ?', r.json.id)[0] }, { author_user_id: null, visibility: 'org' });
  const noHeader = await call('POST', '/api/projects', { auth: xTok, body: { name, project: proj() } });
  assert.equal(noHeader.status, 201, 'DB 版は同名でも作れる');
  assert.equal(orgOfDay(noHeader.json.id), A, 'ヘッダーなしは所属の先頭');
  assert.equal((await call('POST', '/api/projects', { auth: xTok, body: { name: 'bad', project: proj() } })).status, 400);
});

test('同名の練習が 2 組織にあっても ID で別々に読み書き・削除できる', { skip }, async () => {
  const name = 'sailviz-20260520-0900.sailviz.json';
  const a = (await call('POST', '/api/projects', { auth: xTok, org: A, body: { name, project: proj({ reflections: [refl('rSa', 'A版')] }) } })).json.id;
  const b = (await call('POST', '/api/projects', { auth: xTok, org: B, body: { name, project: proj({ reflections: [refl('rSb', 'B版')] }) } })).json.id;
  assert.notEqual(a, b);
  assert.equal((await call('GET', `/api/projects/${a}`, { auth: xTok, org: A })).json.reflections[0].notes.goal, 'A版');
  assert.equal((await call('GET', `/api/projects/${b}`, { auth: xTok, org: B })).json.reflections[0].notes.goal, 'B版');
  assert.equal((await call('PUT', `/api/projects/${b}`, { auth: xTok, org: B, body: proj({ reflections: [refl('rSb', 'B版2')] }) })).status, 200);
  assert.equal((await call('GET', `/api/projects/${a}`, { auth: xTok, org: A })).json.reflections[0].notes.goal, 'A版', 'A は変わらない');
  assert.equal((await call('DELETE', `/api/projects/${a}`, { auth: xTok, org: A })).status, 200);
  assert.equal(rows('SELECT 1 FROM practice_days WHERE id = ?', a).length, 0);
  assert.equal((await call('GET', `/api/projects/${b}`, { auth: xTok, org: B })).json.reflections[0].notes.goal, 'B版2', 'B は残る');
});

test('X が A と B の __team__ をそれぞれ保存でき、互いに変わらない', { skip }, async () => {
  const save = (org, goal) => call('PUT', '/api/overlays/roadmap', { auth: xTok, org, body: { __team__: { goal, milestones: [] } } });
  assert.equal((await save(A, 'Aの全体目標')).status, 200);
  assert.equal((await save(B, 'Bの全体目標')).status, 200);
  assert.equal((await save(A, 'Aの全体目標2')).status, 200);
  assert.deepEqual((await call('GET', '/api/overlays/roadmap', { auth: xTok, org: A })).json, { __team__: { goal: 'Aの全体目標2', milestones: [] } });
  assert.deepEqual((await call('GET', '/api/overlays/roadmap', { auth: xTok, org: B })).json, { __team__: { goal: 'Bの全体目標', milestones: [] } });
  const team = rows("SELECT org_id, goal, user_id FROM roadmaps WHERE legacy_name = '__team__' ORDER BY org_id").map((r) => ({ ...r }));
  assert.deepEqual(team, [{ org_id: A, goal: 'Aの全体目標2', user_id: null }, { org_id: B, goal: 'Bの全体目標', user_id: null }]);
});

test('所属外のヘッダーは GET・PUT とも 403 org_forbidden', { skip }, async () => {
  for (const [m, p, body] of [
    ['GET', '/api/projects'], ['GET', '/api/summaries'], ['GET', `/api/projects/${ids[NA]}`],
    ['GET', '/api/overlays/roadmap'], ['GET', '/api/overlays/progress'],
    ['PUT', `/api/projects/${ids[NA]}`, proj()], ['POST', '/api/projects', { name: 'sailviz-20260530-0900.sailviz.json', project: proj() }],
    ['DELETE', `/api/projects/${ids[NA]}`], ['PUT', '/api/overlays/roadmap', {}], ['PUT', '/api/overlays/progress', {}],
  ]) {
    const r = await call(m, p, { auth: yTok, org: B, body });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.deepEqual(r.json, { error: 'org_forbidden' }, `${m} ${p}`);
  }
  assert.equal((await call('GET', '/api/projects', { auth: xTok, org: C })).json.error, 'org_forbidden');
  assert.equal(rows('SELECT 1 FROM practice_days WHERE id = ?', ids[NA]).length, 1);
});

test('書き込みトークンは今までどおり A を読み書きし、ヘッダーを無視する', { skip }, async () => {
  const list = await call('GET', '/api/projects', { auth: TOKEN, org: B });
  assert.equal(list.status, 200);
  assert.ok(list.json.some((p) => p.id === ids[NA]));
  assert.ok(!list.json.some((p) => p.id === ids[NB]), 'B の org の練習は出ない');
  const r = await call('POST', '/api/projects', { auth: TOKEN, org: B, body: { name: 'sailviz-20260531-0900.sailviz.json', project: proj() } });
  assert.equal(r.status, 201);
  assert.equal(orgOfDay(r.json.id), A);
  assert.equal((await call('PUT', `/api/projects/${ids[NB]}`, { auth: TOKEN, org: B, body: proj() })).status, 403);
  assert.equal((await call('GET', '/api/projects', { auth: TOKEN, org: C })).status, 200, '所属外のヘッダーでも 403 にしない');
  assert.equal((await call('PUT', '/api/overlays/roadmap', { auth: TOKEN, org: B, body: { __team__: { goal: 'トークン', milestones: [] } } })).status, 200);
  assert.equal(rows("SELECT goal FROM roadmaps WHERE legacy_name = '__team__' AND org_id = ?", A)[0].goal, 'トークン');
  assert.equal(rows("SELECT goal FROM roadmaps WHERE legacy_name = '__team__' AND org_id = ?", B)[0].goal, 'Bの全体目標');
});

test('進捗 PUT は表示中の組織の反省だけを変える', { skip }, async () => {
  repo.writeOverlay('progress', { rA: { issueStage: 1 }, rB: { issueStage: 2 } });
  assert.deepEqual(Object.keys((await call('GET', '/api/overlays/progress', { auth: xTok, org: B })).json), ['rB']);
  // B を表示中に、A の項目を送らず B だけを全置き換えで送る
  const put = await call('PUT', '/api/overlays/progress', { auth: xTok, org: B, body: { rB: { issueStage: 5 }, rA: { issueStage: 9 } } });
  assert.equal(put.status, 200);
  assert.deepEqual(repo.readOverlay('progress'), { rA: { issueStage: 1 }, rB: { issueStage: 5 } });
  // A を表示中に、空で送ると A の項目だけが消える
  assert.equal((await call('PUT', '/api/overlays/progress', { auth: xTok, org: A, body: {} })).status, 200);
  assert.deepEqual(repo.readOverlay('progress'), { rB: { issueStage: 5 } });
});

test('取込み: 応答に id が入り、ユーザーの取込みは表示中の組織の器を使う', { skip }, async () => {
  const { memberList } = await import('../src/members.js');
  const day = Date.UTC(2026, 4, 31, 15, 0, 0); // JST 2026-06-01 0 時(センサー取込みの practiceDate と完全一致する)
  // ユーザーの取込みの名簿は表示中の組織のメンバー(x は A・B の両方に所属)。従来の名簿の名前は組織に居なければ通らない
  const body = { practiceDate: day, rows: [{ fullName: 'テスト', goal: '議事録' }] }; // x のアカウント名(mk の name)
  const outside = await call('POST', '/api/minutes-imports/commit', { auth: xTok, org: B, body: { practiceDate: day, rows: [{ fullName: memberList()[0].fullName, goal: 'x' }] } });
  assert.equal(outside.status, 400, '組織に居ない名前は名簿外');
  const r = await call('POST', '/api/minutes-imports/commit', { auth: xTok, org: B, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created, true);
  assert.equal(orgOfDay(r.json.id), B);
  const r2 = await call('POST', '/api/minutes-imports/commit', { auth: xTok, org: A, body });
  assert.equal(r2.json.created, true, 'A を表示中なら B の器は使わない');
  assert.equal(orgOfDay(r2.json.id), A);
  const r3 = await call('POST', '/api/minutes-imports/commit', { auth: xTok, org: B, body });
  assert.deepEqual([r3.json.id, r3.json.created], [r.json.id, false]);
  // センサー取込み: matched に id。commit は { id, boatNumber }
  const person = 'テスト'; // 上の取込みで反省を書いた人
  const csv = ['time,latitude,longitude,speed,bearing,horizontalAccuracy', ...Array.from({ length: 5 }, (_, i) => `${(Date.UTC(2026, 5, 1, 3, 0, i)) * 1e6},10.0,100.0,2,90,4`)].join('\n') + '\n';
  const pdDay = rows("SELECT json_extract(web_state, '$.practiceDate') AS d FROM practice_days WHERE id = ?", r.json.id)[0].d;
  assert.equal(Number(pdDay), day);
  const up = await call('POST', '/api/sensor-imports', { auth: xTok, org: B, body: { person, csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.matched, { id: r.json.id, name: r.json.name, label: up.json.matched?.label });
  const c = await call('POST', `/api/sensor-imports/${encodeURIComponent(up.json.importId)}/commit`, { auth: xTok, org: B, body: { id: r.json.id, boatNumber: '1234' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(c.json, { id: r.json.id });
  assert.equal(rows('SELECT 1 FROM rec_sessions WHERE practice_day_id = ?', r.json.id).length, 1);
  const legacyName = await call('POST', `/api/sensor-imports/${encodeURIComponent(up.json.importId)}/commit`, { auth: xTok, org: B, body: { name: 'x.sailviz.json', boatNumber: '1' } });
  assert.equal(legacyName.status, 400, 'name は受けない');
});
