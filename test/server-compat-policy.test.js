// test/server-compat-policy.test.js
// 互換 API の認可を policy に切り替えた結合テスト(S2.5-P2)。DB 版 repo + アカウント。node:sqlite が要る(Node >=22.5 / 24)。
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
const TOKEN = 'dummy-write', VU = 'dummy-user', VP = 'dummy-pass';
const ORG = 'o_main', OTHER = 'o_other';
const D1 = 'sailviz-20260101-0900.sailviz.json'; // org の反省 + private の反省
const D2 = 'sailviz-20260102-0900.sailviz.json'; // private だけ(共有ログインには器ごと見えない)
const D3 = 'sailviz-20260103-0900.sailviz.json'; // 他組織の器(org と public)
const D4 = 'sailviz-20260104-0900.sailviz.json'; // 全部見える(削除できる)

let db, repo, accounts, dataDir, serverA, serverB, baseA, baseB, issueAuthToken, createAccountsRepo, createDbRepo;
let openDb, migrate, loadMigrations;
let memberTok, outsiderTok, ownerTok;
let cookie; // 共有ログイン(閲覧ゲート)の Cookie

const pt = (t) => ({ t, lat: 10, lon: 100, speed: 1 });
const trk = (id, t0) => ({ id, name: id, color: '#e6194B', visible: true, points: [pt(t0), pt(t0 + 1)], bounds: { minLat: 10, maxLat: 10, minLon: 100, maxLon: 100 } });
const refl = (id, text) => ({ id, people: ['テスト部員A'], createdAt: 1, notes: { goal: text } });
const proj = (over = {}) => ({ version: 1, mode: 'absolute', accuracyFilter: true, crop: { start: 0, end: 0 }, tracks: [], events: [], marks: [], pins: [], videos: [], reflections: [], ...over });

async function listen(api) {
  const s = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, base: `http://127.0.0.1:${s.address().port}` };
}
const call = async (base, method, path, { body, auth, ck } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (ck) headers.cookie = ck;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 本文なし */ }
  return { status: r.status, json, headers: r.headers };
};
const loginCookie = async (base) => {
  const r = await call(base, 'POST', '/api/login', { body: { user: VU, password: VP } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const rows = (sql, ...a) => db.prepare(sql).all(...a);
// 練習 ID(practice_days.id)。このファイルの器の名前は重ならないので名前から引ける。
// 見つからなければ投げる(仕込みの失敗を 403/404 の確認で見逃さない)。
const pid = (name) => {
  const id = rows('SELECT id FROM practice_days WHERE legacy_name = ?', name)[0]?.id;
  if (!id) throw new Error(`器が見つからない(仕込みの失敗): ${name}`);
  return id;
};

before(async () => {
  if (!hasSqlite) return;
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createDbRepo } = await import('../server/repos/dbRepo.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
  ({ issueAuthToken } = await import('../server/accountAuth.js'));
  dataDir = await mkdtemp(join(tmpdir(), 'sailviz-compat-policy-'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  repo = createDbRepo({ db, dataDir });
  accounts = createAccountsRepo({ db });

  const mk = (email, orgs) => {
    const u = accounts.createUser({ email, name: 'テスト', affiliationText: 'テスト部', passwordHash: 'x', agreedAt: 1 });
    for (const o of orgs) accounts.linkMember({ orgId: o, userId: u.id });
    return { id: u.id, tok: issueAuthToken(accounts, u.id).token };
  };
  const member = mk('member@example.com', [ORG]);
  const outsider = mk('outsider@example.com', [OTHER]);
  const owner = mk('owner@example.com', [ORG]);
  memberTok = member.tok; outsiderTok = outsider.tok; ownerTok = owner.tok;

  const api = createApi({ repo, token: TOKEN, viewUser: VU, viewPassword: VP, accounts, migrationOrgId: ORG });
  const apiNoOrg = createApi({ repo, token: TOKEN, viewUser: VU, viewPassword: VP, accounts }); // MIGRATION_ORG_ID 未設定
  ({ s: serverA, base: baseA } = await listen(api));
  ({ s: serverB, base: baseB } = await listen(apiNoOrg));
  cookie = await loginCookie(baseA);

  // --- 種まき: 共有ログイン(トークン)の互換 POST で器を作る(org_id = MIGRATION_ORG_ID が付く)---
  const post = (name, p) => call(baseA, 'POST', '/api/projects', { body: { name, project: p }, auth: TOKEN });
  assert.equal((await post(D1, proj({ tracks: [trk('a', 1000)], reflections: [refl('rOrg', '見える目標'), refl('rPriv', '秘密の目標')] }))).status, 201);
  assert.equal((await post(D2, proj({ tracks: [trk('b', 2000)], reflections: [refl('rP2', '秘密2')] }))).status, 201);
  assert.equal((await post(D4, proj({ reflections: [refl('rAll', '全部見える')] }))).status, 201);
  // 他組織の器は repo 直書き
  repo.createProject(proj({ tracks: [trk('c', 3000)], reflections: [refl('rOtherOrg', '他組織org'), refl('rOtherPub', '他組織public')] }), { name: D3, orgId: OTHER });
  // 公開範囲を変える(アプリ・新 API が後から設定する想定)
  const setVis = (bodyId, vis, author = null) => {
    for (const r of rows('SELECT id, body FROM reflections')) {
      if (JSON.parse(r.body).id === bodyId) db.prepare('UPDATE reflections SET visibility = ?, author_user_id = ? WHERE id = ?').run(vis, author, r.id);
    }
  };
  setVis('rPriv', 'private', owner.id);
  setVis('rP2', 'private', owner.id);
  setVis('rOtherPub', 'public');
  db.prepare("UPDATE rec_sessions SET visibility = 'private', owner_user_id = ? WHERE practice_day_id = (SELECT id FROM practice_days WHERE legacy_name = ?)").run(owner.id, D2);
});
after(async () => {
  if (!hasSqlite) return;
  await new Promise((r) => serverA.close(r));
  await new Promise((r) => serverB.close(r));
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

// ---- (5)(1) 主体: 閲覧ゲートの Cookie・書込トークン・Bearer ----
test('(1) 未ログインは 401。閲覧ゲートの Cookie・書込トークンで共有ログインとして入れる', { skip }, async () => {
  assert.equal((await call(baseA, 'GET', '/api/projects')).status, 401);
  assert.equal((await call(baseA, 'GET', '/api/projects', { ck: cookie })).status, 200);
  assert.equal((await call(baseA, 'GET', '/api/projects', { auth: TOKEN })).status, 200);
  assert.equal((await call(baseA, 'GET', '/api/projects', { auth: 'wrong' })).status, 401);
  assert.equal((await call(baseA, 'GET', '/api/projects', { auth: memberTok })).status, 200, 'アカウントの Bearer');
});

// ---- (2) 互換 GET ----
test('(2) 共有ログインの一覧: 見える中身のある器だけ。private だけの器・他組織の org だけの器は出ない', { skip }, async () => {
  const names = (await call(baseA, 'GET', '/api/projects', { ck: cookie })).json.map((p) => p.name).sort();
  assert.deepEqual(names, [D1, D3, D4].sort()); // D3 は他組織の public が見える
});

test('(2) 共有ログインの GET: 見える中身だけ返す。見えない器は 404', { skip }, async () => {
  const d1 = (await call(baseA, 'GET', `/api/projects/${pid(D1)}`, { ck: cookie })).json;
  assert.deepEqual(d1.reflections.map((r) => r.id), ['rOrg']);
  assert.equal(d1.tracks.length, 1);
  assert.equal(d1._rev, 1);
  assert.equal((await call(baseA, 'GET', `/api/projects/${pid(D2)}`, { ck: cookie })).status, 404);
  const d3 = (await call(baseA, 'GET', `/api/projects/${pid(D3)}`, { ck: cookie })).json;
  assert.deepEqual(d3.reflections.map((r) => r.id), ['rOtherPub'], '他組織は public だけ');
});

test('(2) summaries も見える中身だけで数える・見えない器は出ない', { skip }, async () => {
  const rowsOut = (await call(baseA, 'GET', '/api/summaries', { ck: cookie })).json;
  assert.deepEqual(rowsOut.map((r) => r.name).sort(), [D1, D3, D4].sort());
});

test('(1)(2) ログインユーザー(Bearer): 組織メンバーは org まで、作成者は自分の private も、他組織は public だけ', { skip }, async () => {
  const ids = async (tok, name) => (await call(baseA, 'GET', `/api/projects/${pid(name)}`, { auth: tok })).json?.reflections?.map((r) => r.id);
  assert.deepEqual(await ids(memberTok, D1), ['rOrg']);
  assert.deepEqual(await ids(ownerTok, D1), ['rOrg', 'rPriv'], '作成者は自分の private も');
  assert.equal((await call(baseA, 'GET', `/api/projects/${pid(D2)}`, { auth: memberTok })).status, 404);
  assert.deepEqual(await ids(ownerTok, D2), ['rP2']);
  // 他組織のメンバー: D1 の org は見えない(public も無い)ので 404、D3 は自組織の器なので全部
  assert.equal((await call(baseA, 'GET', `/api/projects/${pid(D1)}`, { auth: outsiderTok })).status, 404);
  assert.deepEqual(await ids(outsiderTok, D3), ['rOtherOrg', 'rOtherPub']);
  const list = (await call(baseA, 'GET', '/api/projects', { auth: outsiderTok })).json.map((p) => p.name);
  assert.deepEqual(list, [D3]);
});

// 設計書 §5.4 で動きが変わった: ログインユーザーは表示中の組織の器なら書ける。他組織の器は 403。
test('(1) ログインユーザーの互換 PUT・DELETE は表示中の組織の器なら通り、他組織の器は 403', { skip }, async () => {
  const body = proj({ reflections: [refl('rAll', '全部見える')] });
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D4)}`, { auth: ownerTok, body })).status, 200);
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D3)}`, { auth: ownerTok, body: proj() })).status, 403, '他組織の器');
  assert.equal((await call(baseA, 'DELETE', `/api/projects/${pid(D3)}`, { auth: ownerTok })).status, 403, '他組織の器');
  assert.equal(rows('SELECT 1 FROM practice_days WHERE legacy_name = ?', D3).length, 1);
  // 消せる器(全部書ける)は消せる
  const c = await call(baseA, 'POST', '/api/projects', { auth: ownerTok, body: { name: 'sailviz-20260111-0900.sailviz.json', project: proj() } });
  assert.equal(c.status, 201);
  assert.equal((await call(baseA, 'DELETE', `/api/projects/${c.json.id}`, { auth: ownerTok })).status, 200);
  assert.equal(rows('SELECT 1 FROM practice_days WHERE id = ?', c.json.id).length, 0);
  // 取込み CSV は今までどおり共有ログインだけ
  assert.equal((await call(baseA, 'GET', '/api/uploads/imp_x/raw.csv', { auth: ownerTok })).status, 403);
});

// ---- (3) 互換 PUT: 見えない項目は消さない ----
test('(3) 共有ログインの PUT: private の反省・その公開範囲と作者は消えない・変わらない', { skip }, async () => {
  const before = rows("SELECT id, visibility, author_user_id FROM reflections WHERE body LIKE '%rPriv%'")[0];
  const body = proj({ tracks: [trk('a', 1000)], reflections: [refl('rOrg', '書き換えた目標'), refl('rNew', '新しい反省')] });
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D1)}`, { ck: cookie, body })).status, 200);
  const after = rows("SELECT id, visibility, author_user_id FROM reflections WHERE body LIKE '%rPriv%'")[0];
  assert.deepEqual(after, before, 'private の反省の行はそのまま');
  const shared = (await call(baseA, 'GET', `/api/projects/${pid(D1)}`, { ck: cookie })).json.reflections;
  assert.deepEqual(shared.map((r) => r.id).sort(), ['rNew', 'rOrg']);
  assert.equal(shared.find((r) => r.id === 'rOrg').notes.goal, '書き換えた目標');
  const own = (await call(baseA, 'GET', `/api/projects/${pid(D1)}`, { auth: ownerTok })).json.reflections;
  assert.deepEqual(own.map((r) => r.id).sort(), ['rNew', 'rOrg', 'rPriv']);
  assert.equal(own.find((r) => r.id === 'rPriv').notes.goal, '秘密の目標');
});

test('(3) PUT で既存の反省の公開範囲・作者が初期化されない (public に設定済みの反省が org に戻らない)', { skip }, async () => {
  const r0 = rows("SELECT id FROM reflections WHERE body LIKE '%\"rOrg\"%'")[0];
  db.prepare("UPDATE reflections SET visibility = 'public', author_user_id = 'u_x' WHERE id = ?").run(r0.id);
  const body = proj({ tracks: [trk('a', 1000)], reflections: [refl('rOrg', 'もう一度'), refl('rNew', '新しい反省')] });
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D1)}`, { ck: cookie, body })).status, 200);
  const r1 = rows('SELECT visibility, author_user_id FROM reflections WHERE id = ?', r0.id)[0];
  assert.deepEqual({ ...r1 }, { visibility: 'public', author_user_id: 'u_x' });
  db.prepare("UPDATE reflections SET visibility = 'org', author_user_id = NULL WHERE id = ?").run(r0.id);
});

test('(3) PUT で反省を送らなかった(消した)場合、見える反省だけが消える', { skip }, async () => {
  const body = proj({ tracks: [trk('a', 1000)], reflections: [refl('rOrg', 'もう一度')] });
  await call(baseA, 'PUT', `/api/projects/${pid(D1)}`, { ck: cookie, body });
  const own = (await call(baseA, 'GET', `/api/projects/${pid(D1)}`, { auth: ownerTok })).json.reflections;
  assert.deepEqual(own.map((r) => r.id).sort(), ['rOrg', 'rPriv'], 'rNew は消え、見えない rPriv は残る');
});

test('(3) 互換 PUT は他組織の器・見えない private の器の軌跡も壊さない: 他組織の器への PUT は 403', { skip }, async () => {
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D3)}`, { ck: cookie, body: proj() })).status, 403);
  assert.equal(rows("SELECT 1 FROM reflections WHERE body LIKE '%rOtherOrg%'").length, 1);
});

test('(3) 新しい器は MIGRATION_ORG_ID の組織で作られる', { skip }, async () => {
  const pd = rows('SELECT org_id FROM practice_days WHERE legacy_name = ?', D4)[0];
  assert.equal(pd.org_id, ORG);
});

test('(3) 閲覧ゲート無効でもアカウント機能がある版は、未ログインを共有ログインにしない(読みも 401・ランディングへ)。書込トークンなら書ける', { skip }, async () => {
  const apiOpen = createApi({ repo, token: TOKEN, accounts, migrationOrgId: ORG }); // 閲覧ゲート無効
  const { s, base } = await listen(apiOpen);
  try {
    assert.equal((await call(base, 'GET', '/api/projects')).status, 401);
    assert.equal((await call(base, 'GET', '/api/overlays/progress')).status, 401);
    assert.equal((await call(base, 'GET', '/api/members')).status, 401);
    const sess = await call(base, 'GET', '/api/session');
    assert.equal(sess.json.loggedIn, false);
    assert.equal(sess.json.gate, false);
    assert.equal((await call(base, 'GET', '/api/session', { auth: TOKEN })).json.loggedIn, true);
    // 共有ログインは無いので、成功を装わず 401(Cookie の無い「ログイン済み」にしない)
    const login = await call(base, 'POST', '/api/login', { body: { user: 'x', password: 'y' } });
    assert.equal(login.status, 401);
    assert.equal((await call(base, 'GET', '/api/projects', { auth: TOKEN })).status, 200);
    assert.equal((await call(base, 'PUT', `/api/projects/${pid(D4)}`, { body: proj() })).status, 401);
    assert.equal((await call(base, 'PUT', `/api/projects/${pid(D4)}`, { body: proj({ reflections: [refl('rAll', '全部見える')] }), auth: TOKEN })).status, 200);
  } finally { await new Promise((r) => s.close(r)); }
});

test('(3) DELETE: 見えない中身がある器は 403、全部見える器は消せる', { skip }, async () => {
  assert.equal((await call(baseA, 'DELETE', `/api/projects/${pid(D1)}`, { ck: cookie })).status, 403);
  assert.equal((await call(baseA, 'DELETE', `/api/projects/${pid(D3)}`, { ck: cookie })).status, 403);
  assert.equal(rows('SELECT 1 FROM practice_days WHERE legacy_name = ?', D1).length, 1);
  const c = await call(baseA, 'POST', '/api/projects', { ck: cookie, body: { name: 'sailviz-20260110-0900.sailviz.json', project: proj({ reflections: [refl('rDel', 'x')] }) } });
  assert.equal(c.status, 201);
  assert.equal((await call(baseA, 'DELETE', `/api/projects/${c.json.id}`, { ck: cookie })).status, 200);
  assert.equal(rows("SELECT 1 FROM practice_days WHERE legacy_name = 'sailviz-20260110-0900.sailviz.json'").length, 0);
});

// ---- (4) オーバーレイ ----
test('(4)(c)(d) progress: 見える反省の進捗だけ読める。private の進捗は PUT しても書き換わらない', { skip }, async () => {
  db.exec('DELETE FROM reflection_comments; DELETE FROM reflection_progress;');
  repo.writeOverlay('progress', {
    rOrg: { issueStage: 1, goalDone: false },
    rPriv: { issueStage: 2, goalDone: true, comments: { goal: [{ text: '秘密のコメント', ts: 5 }] } },
    rOtherOrg: { issueStage: 3 },
    rOtherPub: { issueStage: 4 },
  });
  const got = (await call(baseA, 'GET', '/api/overlays/progress', { ck: cookie })).json;
  assert.deepEqual(Object.keys(got).sort(), ['rOrg', 'rOtherPub']);
  // 共有ログインの PUT(自分に見えるものだけを送る)
  const put = await call(baseA, 'PUT', '/api/overlays/progress', {
    ck: cookie,
    body: {
      rOrg: { issueStage: 9, goalDone: true, comments: { goal: [{ text: '自組織へのコメント', ts: 6 }] } },
      rOtherPub: { issueStage: 99, comments: { goal: [{ text: '他組織へ', ts: 7 }] } },
      rPriv: { issueStage: 77 },
    },
  });
  assert.equal(put.status, 200);
  const all = repo.readOverlay('progress');
  assert.equal(all.rOrg.issueStage, 9);
  assert.equal(all.rOrg.comments.goal[0].text, '自組織へのコメント');
  assert.deepEqual(all.rPriv, { issueStage: 2, goalDone: true, comments: { goal: [{ text: '秘密のコメント', ts: 5 }] } }, 'private は元のまま');
  assert.deepEqual(all.rOtherOrg, { issueStage: 3 }, '見えない他組織の進捗も残る');
  assert.deepEqual(all.rOtherPub, { issueStage: 4 }, '他組織の public へは書けない(進捗もコメントも)');
});

test('(4)(e) roadmap: 組織メンバーだけ読める。他組織・組織なしの行は見えず、PUT でも消えない', { skip }, async () => {
  db.exec('DELETE FROM roadmaps');
  const ins = db.prepare('INSERT INTO roadmaps (id, user_id, org_id, legacy_name, goal, milestones, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1)');
  ins.run('rm1', null, ORG, '部員甲', '甲の目標', '[]');
  ins.run('rm2', null, OTHER, '部員乙', '乙の目標', '[]');
  ins.run('rm3', null, null, '部員丙', '丙の目標', '[]');
  const got = (await call(baseA, 'GET', '/api/overlays/roadmap', { ck: cookie })).json;
  assert.deepEqual(Object.keys(got), ['部員甲']);
  assert.equal((await call(baseA, 'GET', '/api/overlays/roadmap')).status, 401, '未ログイン');
  const put = await call(baseA, 'PUT', '/api/overlays/roadmap', { ck: cookie, body: { 部員甲: { goal: '甲の新目標', milestones: [] }, 部員丁: { goal: '丁', milestones: [] }, 部員乙: { goal: '上書き', milestones: [] } } });
  assert.equal(put.status, 200);
  // 行は (組織, 名前) で突き合わせる(設計書 §5.6)。他組織と同じ名前は自組織の別の行になる。
  const rs = Object.fromEntries(rows('SELECT legacy_name, goal, org_id FROM roadmaps').map((r) => [`${r.org_id}:${r.legacy_name}`, r]));
  const r = (org, nm) => rs[`${org}:${nm}`];
  assert.equal(r(ORG, '部員甲').goal, '甲の新目標');
  assert.equal(r(OTHER, '部員乙').goal, '乙の目標', '他組織は上書きされない');
  assert.equal(r(ORG, '部員乙').goal, '上書き', '同じ名前は自組織の別の行');
  assert.equal(rows('SELECT 1 FROM roadmaps').length, 5);
  assert.equal(r(null, '部員丙').goal, '丙の目標', '組織なしの行は残り、組織が付け替わらない');
  assert.equal(r(ORG, '部員丁').goal, '丁', '新しい行は MIGRATION_ORG_ID の組織');
  // 組織メンバーのユーザー(Bearer)も同じ範囲を読める。他組織のメンバーには見えない
  assert.deepEqual(Object.keys((await call(baseA, 'GET', '/api/overlays/roadmap', { auth: memberTok })).json).sort(), ['部員丁', '部員乙', '部員甲']);
  const theirs = (await call(baseA, 'GET', '/api/overlays/roadmap', { auth: outsiderTok })).json;
  assert.deepEqual(Object.keys(theirs), ['部員乙']);
  assert.equal(theirs['部員乙'].goal, '乙の目標');
});

// ---- (b) MIGRATION_ORG_ID 未設定 ----
test('(b) MIGRATION_ORG_ID 未設定: 共有ログインは何も読めない・書けない (ログイン自体はできる)', { skip }, async () => {
  const ck = await loginCookie(baseB);
  assert.deepEqual((await call(baseB, 'GET', '/api/projects', { ck })).json, []);
  assert.deepEqual((await call(baseB, 'GET', '/api/summaries', { ck })).json, []);
  assert.equal((await call(baseB, 'GET', `/api/projects/${pid(D4)}`, { ck })).status, 404);
  assert.equal((await call(baseB, 'GET', `/api/projects/${pid(D3)}`, { ck })).status, 404, '他組織の public も読めない');
  assert.deepEqual((await call(baseB, 'GET', '/api/overlays/progress', { ck })).json, {});
  assert.deepEqual((await call(baseB, 'GET', '/api/overlays/roadmap', { ck })).json, {});
  assert.equal((await call(baseB, 'GET', '/api/uploads/imp_x/raw.csv', { ck })).status, 403);
  for (const [m, p, b] of [
    ['PUT', `/api/projects/${pid(D4)}`, proj()], ['POST', '/api/projects', { name: 'sailviz-20260120-0900.sailviz.json', project: proj() }],
    ['DELETE', `/api/projects/${pid(D4)}`], ['PUT', '/api/overlays/progress', {}], ['PUT', '/api/overlays/roadmap', {}],
    ['POST', '/api/sensor-imports', { person: 'x', csv: 'x' }], ['POST', '/api/minutes-imports/commit', { practiceDate: 1, rows: [] }],
  ]) {
    assert.equal((await call(baseB, m, p, { ck, body: b })).status, 403, `${m} ${p}`);
    assert.equal((await call(baseB, m, p, { auth: TOKEN, body: b })).status, 403, `${m} ${p} (トークン)`);
  }
  assert.equal(rows("SELECT 1 FROM practice_days WHERE legacy_name = 'sailviz-20260120-0900.sailviz.json'").length, 0);
  assert.equal((await call(baseB, 'GET', '/api/projects')).status, 401, '未ログインは 401 のまま');
  // アカウントのユーザーは MIGRATION_ORG_ID に関係なく読める
  assert.ok((await call(baseB, 'GET', '/api/projects', { auth: ownerTok })).json.length >= 1);
});

// ---- 取込み系 ----
test('取込み: minutes-imports commit は自組織の器に書き、他組織の器は使わない', { skip }, async () => {
  const day = Date.UTC(2026, 0, 3, 3, 0, 0); // D3 と同じ JST 日(2026-01-03)。D3 は他組織なので使われない
  const { memberList } = await import('../src/members.js');
  const rowsBody = [{ fullName: memberList()[0].fullName, goal: '議事録の目標' }]; // 名簿は同梱のものを使う(実名をテストに書かない)
  const r = await call(baseA, 'POST', '/api/minutes-imports/commit', { ck: cookie, body: { practiceDate: day, rows: rowsBody } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.notEqual(r.json.id, pid(D3), '他組織の器には書かない');
  assert.equal(r.json.created, true);
  assert.equal(rows('SELECT org_id FROM practice_days WHERE id = ?', r.json.id)[0].org_id, ORG);
  // 自組織の器があれば、そこへ追記される
  const r2 = await call(baseA, 'POST', '/api/minutes-imports/commit', { ck: cookie, body: { practiceDate: day, rows: rowsBody } });
  assert.equal(r2.json.id, r.json.id);
  assert.equal(r2.json.created, false);
});

test('P1: 閲覧 Cookie とアカウントの sailviz_session Cookie が両方あっても旧共有ログイン(書込可)として扱う。Bearer は user', { skip }, async () => {
  const both = `${cookie}; sailviz_session=${ownerTok}`;
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(D4)}`, { ck: both, body: proj({ reflections: [refl('rAll', '全部見える')] }) })).status, 200);
  // ユーザーも書けるようになった(§5.4)ので、どちらの主体かは「作成者の private が見えるか」で見分ける。
  const reflIds = async (opts) => (await call(baseA, 'GET', `/api/projects/${pid(D1)}`, opts)).json.reflections.map((r) => r.id).sort();
  assert.deepEqual(await reflIds({ ck: both }), ['rOrg'], '両方の Cookie は共有ログイン(private は見えない)');
  // セッション Cookie だけなら user(作成者なので private も見える)
  assert.deepEqual(await reflIds({ ck: `sailviz_session=${ownerTok}` }), ['rOrg', 'rPriv']);
  // Bearer は閲覧 Cookie があっても user
  assert.deepEqual(await reflIds({ ck: cookie, auth: ownerTok }), ['rOrg', 'rPriv']);
  // 新 API の /api/me は Cookie のアカウントのまま
  const me = await call(baseA, 'GET', '/api/me', { ck: both });
  assert.equal(me.status, 200);
  const mine = await call(baseA, 'GET', '/api/me', { auth: ownerTok });
  assert.ok(mine.json.user.id);
  assert.equal(me.json.user.id, mine.json.user.id);
  assert.equal((await call(baseA, 'GET', '/api/me', { ck: cookie })).status, 401, '閲覧 Cookie だけでは /api/me は使えない');
});

test('P3-3: sensor-imports commit の colorIndex は見えない軌跡も数える (色が重ならない)', { skip }, async () => {
  const DAY = 'sailviz-20260301-0900.sailviz.json';
  repo.createProject(proj({ practiceDate: Date.UTC(2026, 2, 1, 3, 0, 0), tracks: [trk('p1', 1000), trk('p2', 2000)] }), { name: DAY, orgId: ORG });
  db.prepare("UPDATE rec_sessions SET visibility = 'private', owner_user_id = 'u_x' WHERE practice_day_id = (SELECT id FROM practice_days WHERE legacy_name = ?) AND position = 0").run(DAY);
  const csv = ['time,latitude,longitude,speed,bearing,horizontalAccuracy', ...Array.from({ length: 5 }, (_, i) => `${(Date.UTC(2026, 2, 1, 3, 0, i)) * 1e6},10.0,100.0,2,90,4`)].join('\n') + '\n';
  const up = await call(baseA, 'POST', '/api/sensor-imports', { ck: cookie, body: { person: 'テスト部員A', csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const c = await call(baseA, 'POST', `/api/sensor-imports/${encodeURIComponent(up.json.importId)}/commit`, { ck: cookie, body: { id: pid(DAY), boatNumber: '1234' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const colors = rows('SELECT view FROM tracks t JOIN rec_sessions s ON s.id = t.session_id JOIN practice_days p ON p.id = s.practice_day_id WHERE p.legacy_name = ?', DAY).map((r) => JSON.parse(r.view).color);
  assert.equal(colors.length, 3);
  // 新しい軌跡の色は 3 番目のパレット色(全軌跡数 2 → index 2)。既存の 2 本(trk の固定色)とは別の色。
  const { buildTrack } = await import('../server/sensorimport.js');
  const expected = buildTrack({ id: 'x', name: 'x', points: [], bounds: null, colorIndex: 2 }).color;
  assert.equal(colors.filter((x) => x === expected).length, 1);
});

test('P3-5: sensor-imports は同じ日・同じ人の反省が複数の器にあっても、見える器を matched にする', { skip }, async () => {
  const day = Date.UTC(2026, 2, 31, 15, 0, 0); // JST 0 時(取込みの practiceDate と完全一致する)
  const mine = 'sailviz-20260401-0900.sailviz.json', theirs = 'sailviz-20260401-1000.sailviz.json';
  const person = 'テスト部員B';
  repo.createProject(proj({ practiceDate: day, reflections: [{ ...refl('rB2', '他'), people: [person] }] }), { name: theirs, orgId: OTHER });
  repo.createProject(proj({ practiceDate: day, reflections: [{ ...refl('rB1', '自'), people: [person] }] }), { name: mine, orgId: ORG });
  const csv = ['time,latitude,longitude,speed,bearing,horizontalAccuracy', ...Array.from({ length: 5 }, (_, i) => `${(Date.UTC(2026, 3, 1, 3, 0, i)) * 1e6},10.0,100.0,2,90,4`)].join('\n') + '\n';
  const up = await call(baseA, 'POST', '/api/sensor-imports', { ck: cookie, body: { person, csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.matched?.id, pid(mine));
});

test('P2-1: minutes-imports commit は id の無い見えない反省を組織に見える行として複製しない', { skip }, async () => {
  const DAY = 'sailviz-20260201-0900.sailviz.json';
  const base = Date.UTC(2026, 1, 1, 3, 0, 0);
  repo.createProject(proj({ practiceDate: base, reflections: [{ people: ['テスト部員A'], createdAt: 1, notes: { goal: '無id秘密' } }] }), { name: DAY, orgId: ORG });
  db.prepare("UPDATE reflections SET visibility = 'private', author_user_id = 'u_x' WHERE practice_day_id = (SELECT id FROM practice_days WHERE legacy_name = ?)").run(DAY);
  const { memberList } = await import('../src/members.js');
  const r = await call(baseA, 'POST', '/api/minutes-imports/commit', { ck: cookie, body: { practiceDate: base, rows: [{ fullName: memberList()[0].fullName, goal: '議事録2' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.id, pid(DAY));
  const secret = rows("SELECT visibility, author_user_id FROM reflections WHERE body LIKE '%無id秘密%'");
  assert.equal(secret.length, 1, '見えない反省が複製されない');
  assert.deepEqual({ ...secret[0] }, { visibility: 'private', author_user_id: 'u_x' });
  const visible = (await call(baseA, 'GET', `/api/projects/${pid(DAY)}`, { ck: cookie })).json.reflections;
  assert.equal(visible.some((x) => JSON.stringify(x).includes('無id秘密')), false);
});

test('P2-3: minutes-imports commit は日付の合う器を全部たどり、書ける器を使う(先頭が他組織でも)', { skip }, async () => {
  const mine = 'sailviz-20260205-0900.sailviz.json', theirs = 'sailviz-20260205-1000.sailviz.json'; // 降順の先頭は他組織
  const day = Date.UTC(2026, 1, 5, 3, 0, 0);
  repo.createProject(proj({ practiceDate: day, reflections: [refl('rM', '自組織')] }), { name: mine, orgId: ORG });
  repo.createProject(proj({ practiceDate: day, reflections: [refl('rT', '他組織')] }), { name: theirs, orgId: OTHER });
  const { memberList } = await import('../src/members.js');
  const r = await call(baseA, 'POST', '/api/minutes-imports/commit', { ck: cookie, body: { practiceDate: day, rows: [{ fullName: memberList()[0].fullName, goal: '議事録3' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.id, pid(mine));
  assert.equal(r.json.created, false);
});

test('P2-2: readProjectWithAccess は JSON と access を同じ並びで返す', { skip }, async () => {
  const { project, access } = repo.readProjectWithAccess(pid(D1));
  assert.equal(project.reflections.length, access.reflections.length);
  assert.deepEqual(project.reflections.map((r) => r.id), access.reflections.map((r) => r.id));
  assert.equal(project.tracks.length, access.tracks.length);
  assert.throws(() => repo.readProjectWithAccess('nothing.sailviz.json'));
});

test('取込み: sensor-imports commit は他組織の器を 404 にする', { skip }, async () => {
  const up = await call(baseA, 'POST', '/api/sensor-imports', {
    ck: cookie,
    body: { person: 'テスト部員A', csv: ['time,latitude,longitude,speed,bearing,horizontalAccuracy', ...Array.from({ length: 5 }, (_, i) => `${(Date.UTC(2026, 0, 3, 3, 0, i)) * 1e6},10.0,100.0,2,90,4`)].join('\n') + '\n' },
  });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const c = await call(baseA, 'POST', `/api/sensor-imports/${encodeURIComponent(up.json.importId)}/commit`, { ck: cookie, body: { id: pid(D3), boatNumber: '9999' } });
  assert.equal(c.status, 404);
});

test('S2.5-P4: sensor-imports の matched は PUT できる器を選ぶ (他組織の public な器が見えても使わず、commit が 404 にならない)', { skip }, async () => {
  const day = Date.UTC(2026, 3, 1, 15, 0, 0); // JST 2026-04-02 0 時
  const mine = 'sailviz-20260402-0900.sailviz.json', theirs = 'sailviz-20260402-1000.sailviz.json'; // 降順の先頭は他組織
  const person = 'テスト部員C';
  repo.createProject(proj({ practiceDate: day, reflections: [{ ...refl('rC1', '自'), people: [person] }] }), { name: mine, orgId: ORG });
  repo.createProject(proj({ practiceDate: day, reflections: [{ ...refl('rC2', '他'), people: [person] }] }), { name: theirs, orgId: OTHER });
  db.prepare("UPDATE reflections SET visibility = 'public' WHERE practice_day_id = (SELECT id FROM practice_days WHERE legacy_name = ?)").run(theirs);
  // 前提: 他組織の器は共有ログインに見える(が PUT はできない)
  assert.equal((await call(baseA, 'GET', `/api/projects/${pid(theirs)}`, { ck: cookie })).status, 200);
  assert.equal((await call(baseA, 'PUT', `/api/projects/${pid(theirs)}`, { ck: cookie, body: proj() })).status, 403);
  const csv = ['time,latitude,longitude,speed,bearing,horizontalAccuracy', ...Array.from({ length: 5 }, (_, i) => `${(Date.UTC(2026, 3, 2, 3, 0, i)) * 1e6},10.0,100.0,2,90,4`)].join('\n') + '\n';
  const up = await call(baseA, 'POST', '/api/sensor-imports', { ck: cookie, body: { person, csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.matched?.id, pid(mine));
  const c = await call(baseA, 'POST', `/api/sensor-imports/${encodeURIComponent(up.json.importId)}/commit`, { ck: cookie, body: { id: up.json.matched.id, boatNumber: '1234' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
});

// ---- GET /api/session: アカウントのセッションだけでもログイン済み(ホームに入れる)----
const sessionOf = async (base, opts) => {
  const r = await call(base, 'GET', '/api/session', opts);
  assert.equal(r.status, 200);
  return r.json.loggedIn;
};
// このテスト用のアカウント(合成メール)。トークンは呼ぶたびに新しく発行する。
let sessSeq = 0;
const mkSessionUser = (orgs = [ORG]) => {
  const u = accounts.createUser({ email: `session${++sessSeq}@example.com`, name: 'テスト', affiliationText: 'テスト部', passwordHash: 'x', agreedAt: 1 });
  for (const o of orgs) accounts.linkMember({ orgId: o, userId: u.id });
  return u.id;
};

test('S1: /api/session はアカウントの Cookie(sailviz_session)・Bearer で loggedIn true、未ログインは false', { skip }, async () => {
  for (const base of [baseA, baseB]) {
    assert.equal(await sessionOf(base, { ck: `sailviz_session=${memberTok}` }), true, `${base} Cookie`);
    assert.equal(await sessionOf(base, { auth: memberTok }), true, `${base} Bearer`);
    assert.equal(await sessionOf(base, {}), false, `${base} 未ログイン`);
  }
});

test('S2: 期限切れのアカウントトークンでは /api/session は loggedIn false', { skip }, async () => {
  const { AUTH_TOKEN_TTL_MS } = await import('../server/domain/tokens.js');
  const uid = mkSessionUser();
  const expired = issueAuthToken(accounts, uid, Date.now() - AUTH_TOKEN_TTL_MS - 1000).token;
  assert.equal(await sessionOf(baseA, { ck: `sailviz_session=${expired}` }), false);
  assert.equal(await sessionOf(baseA, { auth: expired }), false);
});

test('S3: POST /api/auth/logout の後は同じ Cookie の /api/session が loggedIn false', { skip }, async () => {
  const uid = mkSessionUser();
  const ck = `sailviz_session=${issueAuthToken(accounts, uid).token}`;
  assert.equal(await sessionOf(baseA, { ck }), true);
  assert.equal((await call(baseA, 'POST', '/api/auth/logout', { ck })).status, 200);
  assert.equal(await sessionOf(baseA, { ck }), false);
});

test('S4: 所属外の X-Sailviz-Org でも /api/session は 200・loggedIn true(旧 API の読みは 403 org_forbidden)', { skip }, async () => {
  const headers = { cookie: `sailviz_session=${memberTok}`, 'x-sailviz-org': OTHER };
  const s = await fetch(`${baseA}/api/session`, { headers });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).loggedIn, true);
  const p = await fetch(`${baseA}/api/projects`, { headers });
  assert.equal(p.status, 403);
  assert.equal((await p.json()).error, 'org_forbidden');
});

test('S5: 共有ログインの Cookie は MIGRATION_ORG_ID の有無によらず loggedIn true、誤った Bearer は false', { skip }, async () => {
  assert.equal(await sessionOf(baseA, { ck: cookie }), true);
  assert.equal(await sessionOf(baseB, { ck: await loginCookie(baseB) }), true);
  assert.equal(await sessionOf(baseA, { auth: 'wrong' }), false);
  assert.equal(await sessionOf(baseB, { auth: 'wrong' }), false);
});

test('S6: 削除済みユーザーのトークンでは /api/session は loggedIn false', { skip }, async () => {
  const uid = mkSessionUser();
  const tok = issueAuthToken(accounts, uid).token;
  assert.equal(await sessionOf(baseA, { auth: tok }), true);
  accounts.markUserDeleted(uid);
  assert.equal(await sessionOf(baseA, { ck: `sailviz_session=${tok}` }), false);
  assert.equal(await sessionOf(baseA, { auth: tok }), false);
});

test('S7: /api/session の noOrg は組織に所属していないアカウントだけ true(共有ログイン・所属ありは false)', { skip }, async () => {
  const noOrgOf = async (opts) => (await call(baseA, 'GET', '/api/session', opts)).json.noOrg;
  const lone = issueAuthToken(accounts, mkSessionUser([])).token;
  assert.equal(await noOrgOf({ ck: `sailviz_session=${lone}` }), true);
  assert.equal(await noOrgOf({ auth: lone }), true);
  assert.equal(await noOrgOf({ auth: memberTok }), false);
  assert.equal(await noOrgOf({ ck: cookie }), false);
  assert.equal(await noOrgOf({}), false);
});

// ===== メンバー候補(GET /api/members): 読み書きの主体と同じ判定で名簿を決める =====
test('GET /api/members: 組織に所属していないアカウントは空(従来の名簿の部員名を返さない)。進捗も空', { skip }, async () => {
  const lone = issueAuthToken(accounts, mkSessionUser([])).token;
  for (const opts of [{ auth: lone }, { ck: `sailviz_session=${lone}` }]) {
    const r = await call(baseA, 'GET', '/api/members', opts);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
    const p = await call(baseA, 'GET', '/api/overlays/progress', opts);
    assert.equal(p.status, 200);
    assert.deepEqual(p.json, {});
  }
});

test('GET /api/members: 共有ログイン(閲覧ゲートの Cookie)・書込トークンは従来の名簿、アカウントは表示中の組織のメンバー', { skip }, async () => {
  const { legacyMemberList } = await import('../src/members.js');
  const legacy = legacyMemberList().map((m) => m.fullName);
  const viaCookie = await call(baseA, 'GET', '/api/members', { ck: cookie });
  assert.equal(viaCookie.status, 200);
  assert.deepEqual(viaCookie.json.map((m) => m.fullName), legacy);
  assert.deepEqual((await call(baseA, 'GET', '/api/members', { auth: TOKEN })).json.map((m) => m.fullName), legacy);
  const viaUser = await call(baseA, 'GET', '/api/members', { auth: outsiderTok });
  assert.equal(viaUser.status, 200);
  assert.deepEqual(viaUser.json.map((m) => [m.fullName, m.displayName]), [['テスト', 'テスト']]); // OTHER の唯一のメンバー
  assert.equal((await call(baseA, 'GET', '/api/members')).status, 401);
});

test('GET /api/members: 閲覧ゲートの Cookie とアカウントのセッション Cookie の両方がある Web は、データと同じく共有ログイン扱い(従来の名簿)', { skip }, async () => {
  const { legacyMemberList } = await import('../src/members.js');
  // 対照: セッション Cookie だけならアカウント(OTHER のメンバー)
  const onlySession = await call(baseA, 'GET', '/api/members', { ck: `sailviz_session=${outsiderTok}` });
  assert.deepEqual(onlySession.json.map((m) => m.fullName), ['テスト']);
  const both = `${cookie}; sailviz_session=${outsiderTok}`;
  const r = await call(baseA, 'GET', '/api/members', { ck: both });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((m) => m.fullName), legacyMemberList().map((m) => m.fullName));
  // 議事録の取込の検証も同じ名簿: 従来の名簿の名前が通る
  const day = Date.UTC(2026, 6, 1, 15, 0, 0);
  const ok = await call(baseA, 'POST', '/api/minutes-imports/commit', { ck: both, body: { practiceDate: day, rows: [{ fullName: legacyMemberList()[0].fullName, goal: '両方の Cookie' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});
