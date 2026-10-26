// test/practice-days-api.test.js — 練習日 API(/api/practice-days。設計書 Phase 4 §7)。合成データのみ。
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
const rid = () => `refl1791015000000_pd${++n}`;
const orgH = (org) => ({ 'x-sailviz-org': org.id });
// 反省を送り、入った器の ID を返す。
const putRefl = async (u, over = {}, headers) => {
  const id = rid();
  const r = await h.call('PUT', `/api/me/reflections/${id}`, u.tok, refl(over), headers);
  assert.equal(r.status, 200);
  return { id, pdId: (await r.json()).practiceDayId };
};
const list = (tok, scope, headers) => h.call('GET', `/api/practice-days?scope=${scope}`, tok, undefined, headers);
const getDay = (tok, id, headers) => h.call('GET', `/api/practice-days/${encodeURIComponent(id)}`, tok, undefined, headers);
const patchDay = (tok, id, body, headers) => h.call('PATCH', `/api/practice-days/${encodeURIComponent(id)}`, tok, body, headers);

test('一覧 mine: 自分の反省だけがある器、自分が乗員の器が出る', { skip }, async () => {
  const me = h.mkUser(); const other = h.mkUser(); const stranger = h.mkUser();
  // 組織に入る前に、自分だけの器へ反省を送る(組織なしの器)。
  const own = await putRefl(me, { visibility: 'private', practice: { date: '2026/10/20' } });
  const org = h.mkOrg(other, me);
  // 他人の記録に自分が乗員として入る(組織の器)。
  const { fin } = await h.recordFull(other, {
    visibility: 'private',
    crew: [{ role: 'helm', userId: other.user.id, name: other.user.name }, { role: 'crew', userId: me.user.id, name: me.user.name }],
  }, orgH(org));
  const crewDay = fin.attachedTo.id;
  // 関係の無い人の器は出ない。
  const unrelated = await putRefl(stranger, { visibility: 'public', practice: { date: '2026/10/21' } });

  assert.equal((await list(null, 'mine')).status, 401);
  const r = await list(me.tok, 'mine', orgH(org));
  assert.equal(r.status, 200);
  const rows = await r.json();
  const ids = rows.map((x) => x.id);
  assert.deepEqual(ids, [crewDay, own.pdId]); // date の新しい順
  assert.deepEqual(rows[1], { id: own.pdId, date: '2026-10-20', name: rows[1].name, orgId: null, sessionCount: 0, reflectionCount: 1 });
  assert.equal(typeof rows[1].name, 'string');
  assert.equal(rows[0].orgId, org.id);
  assert.equal(rows[0].sessionCount, 1);
  assert.ok(!ids.includes(unrelated.pdId));
});

test('一覧 org: 表示中の組織の器が出て、他人の private の反省は数に入らない', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const loner = h.mkUser();
  const org = h.mkOrg(a, b);
  const pa = await putRefl(a, { visibility: 'private' }, orgH(org));
  const pb = await putRefl(b, { visibility: 'org' }, orgH(org));
  assert.equal(pa.pdId, pb.pdId);

  const rb = await (await list(b.tok, 'org', orgH(org))).json();
  assert.deepEqual(rb.map((x) => x.id), [pa.pdId]);
  assert.equal(rb[0].reflectionCount, 1);
  assert.equal(rb[0].orgId, org.id);
  const ra = await (await list(a.tok, 'org', orgH(org))).json();
  assert.equal(ra[0].reflectionCount, 2);

  // 表示中の組織が無ければ空配列。未ログインは 401、不明な scope は 422。
  const rl = await list(loner.tok, 'org');
  assert.equal(rl.status, 200);
  assert.deepEqual(await rl.json(), []);
  assert.equal((await list(null, 'org')).status, 401);
  const bad = await list(b.tok, 'nope', orgH(org));
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, 'invalid_input');
});

test('一覧 public: 未ログインでも public の中身がある器だけが出る', { skip }, async () => {
  const u = h.mkUser();
  const pub = await putRefl(u, { visibility: 'public', practice: { date: '2026/9/1' } });
  const priv = await putRefl(u, { visibility: 'private', practice: { date: '2026/9/2' } });
  const r = await list(null, 'public');
  assert.equal(r.status, 200);
  const rows = await r.json();
  const ids = rows.map((x) => x.id);
  assert.ok(ids.includes(pub.pdId));
  assert.ok(!ids.includes(priv.pdId));
  assert.equal(rows.find((x) => x.id === pub.pdId).reflectionCount, 1);
  // 新しい順。
  const dates = rows.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('1件: 他人の private の反省しか無い組織外の器は 404 で、存在しない ID と同じ応答', { skip }, async () => {
  const owner = h.mkUser(); const stranger = h.mkUser();
  const d = await putRefl(owner, { visibility: 'private', practice: { date: '2026/8/1' } });
  assert.equal((await getDay(owner.tok, d.pdId)).status, 200);

  const hidden = await getDay(stranger.tok, d.pdId);
  const missing = await getDay(stranger.tok, 'pd_doesnotexist');
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await hidden.json(), await missing.json());
  assert.equal((await getDay(null, d.pdId)).status, 404);
  // PATCH でも存在を明かさない。
  const ph = await patchDay(stranger.tok, d.pdId, { webState: {} });
  const pm = await patchDay(stranger.tok, 'pd_doesnotexist', { webState: {} });
  assert.equal(ph.status, 404);
  assert.deepEqual(await ph.json(), await pm.json());
});

test('1件: 組織のメンバーには空の器も見え、見えない反省は reflections に入らない', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser();
  const org = h.mkOrg(a, b);
  const { s, fin } = await h.recordFull(a, { visibility: 'org' }, orgH(org));
  const pdId = fin.attachedTo.id;
  const ra = await putRefl(a, { visibility: 'private' }, orgH(org));
  const rbId = (await putRefl(b, { visibility: 'org' }, orgH(org))).id;
  assert.equal(ra.pdId, pdId);

  const r = await getDay(b.tok, pdId, orgH(org));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.practiceDay.id, pdId);
  assert.equal(body.practiceDay.orgId, org.id);
  assert.equal(body.practiceDay.date, '2026-10-26');
  assert.equal(typeof body.practiceDay.name, 'string');
  assert.equal(typeof body.practiceDay.webState, 'object');
  assert.equal(body.practiceDay.webState.tracks, undefined);
  assert.deepEqual(body.sessions.map((x) => x.id), [s.id]);
  assert.equal(body.sessions[0].boatNo, '4321');
  assert.ok(Array.isArray(body.sessions[0].crew));
  assert.deepEqual(body.reflections.map((x) => x.id), [rbId]);
  assert.equal(body.reflections[0].visibility, 'org');
  assert.equal(body.reflections[0].practiceDayId, pdId);

  // 中身が見えない(空の)器でも、組織のメンバーには見える。
  const c = h.mkUser(); const d = h.mkUser();
  const org2 = h.mkOrg(c, d);
  const only = await putRefl(c, { visibility: 'private', practice: { date: '2026/7/1' } }, orgH(org2));
  const rd = await getDay(d.tok, only.pdId, orgH(org2));
  assert.equal(rd.status, 200);
  const bd = await rd.json();
  assert.deepEqual(bd.sessions, []);
  assert.deepEqual(bd.reflections, []);
  // 一覧(org)にも数 0 で出る。
  const l = await (await list(d.tok, 'org', orgH(org2))).json();
  assert.deepEqual(l.map((x) => [x.id, x.sessionCount, x.reflectionCount]), [[only.pdId, 0, 0]]);
});

test('PATCH: 組織のメンバーは webState を変えられ(送ったキーだけ)rev が上がり、tracks を送っても軌跡は変わらない', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser();
  const org = h.mkOrg(a, b);
  const { s, fin } = await h.recordFull(a, { visibility: 'private' }, orgH(org), Date.UTC(2026, 5, 1, 0, 0, 0));
  const pdId = fin.attachedTo.id;
  const rev0 = h.db.prepare('SELECT rev FROM practice_days WHERE id = ?').get(pdId).rev;
  const ws0 = JSON.parse(h.db.prepare('SELECT web_state FROM practice_days WHERE id = ?').get(pdId).web_state);
  assert.ok(Number.isFinite(ws0.practiceDate));
  const track0 = h.db.prepare('SELECT * FROM tracks WHERE session_id = ?').get(s.id);
  const reflCount = () => h.db.prepare('SELECT COUNT(*) c FROM reflections WHERE practice_day_id = ?').get(pdId).c;

  // 送ったキーだけ変わり、送らないキー(practiceDate・version・savedAt など)は残る(上の階層の浅いマージ)。
  const ws = { mode: 'race', marks: [{ id: 'm1', lat: 35.3, lng: 139.48 }], tracks: [{ id: 'bogus', points: [] }], reflections: [{ id: 'x' }] };
  const r = await patchDay(b.tok, pdId, { webState: ws }, orgH(org));
  assert.equal(r.status, 200);
  const body = await r.json();
  const merged = { ...ws0, mode: 'race', marks: ws.marks };
  delete merged.tracks; delete merged.reflections;
  assert.deepEqual(body.practiceDay.webState, merged);
  assert.equal(body.practiceDay.webState.practiceDate, ws0.practiceDate);
  assert.equal(body.practiceDay.webState.version, ws0.version);

  assert.equal(h.db.prepare('SELECT rev FROM practice_days WHERE id = ?').get(pdId).rev, rev0 + 1);
  assert.deepEqual(h.db.prepare('SELECT * FROM tracks WHERE session_id = ?').get(s.id), track0);
  assert.equal(reflCount(), 0);
  const g = await (await getDay(b.tok, pdId, orgH(org))).json();
  assert.deepEqual(g.practiceDay.webState, merged);
  // 互換の練習日検索(practiceDate)でも見つかり続ける。
  assert.ok(h.repo.findProjectsByPracticeDate(ws0.practiceDate).some((x) => x.id === pdId));

  // savedAt を送れば saved_at 列も揃う。
  const savedAt = '2026-06-01T12:00:00.000Z';
  assert.equal((await patchDay(b.tok, pdId, { webState: { savedAt } }, orgH(org))).status, 200);
  assert.equal(h.db.prepare('SELECT saved_at FROM practice_days WHERE id = ?').get(pdId).saved_at, savedAt);

  // 組織なしの器は持ち主本人が変えられる。webState がオブジェクトでなければ 422、未ログインは 401。
  const solo = h.mkUser();
  const sd = await putRefl(solo, { visibility: 'private', practice: { date: '2026/6/2' } });
  assert.equal((await patchDay(solo.tok, sd.pdId, { webState: { mode: 'practice' } })).status, 200);
  const bad = await patchDay(solo.tok, sd.pdId, { webState: [] });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, 'invalid_input');
  assert.equal((await patchDay(null, sd.pdId, { webState: {} })).status, 401);
});

test('PATCH: 読めるが組織外の人は 403', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser(); const outsider = h.mkUser();
  const org = h.mkOrg(a, b);
  const d = await putRefl(a, { visibility: 'public', practice: { date: '2026/5/1' } }, orgH(org));
  assert.equal((await getDay(outsider.tok, d.pdId)).status, 200);
  const r = await patchDay(outsider.tok, d.pdId, { webState: { mode: 'x' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'forbidden');

  // 組織なしの器も、持ち主以外は読めても 403。
  const solo = h.mkUser();
  const sd = await putRefl(solo, { visibility: 'public', practice: { date: '2026/5/2' } });
  assert.equal((await patchDay(outsider.tok, sd.pdId, { webState: {} })).status, 403);
});
