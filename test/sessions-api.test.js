// test/sessions-api.test.js — 記録セッション API(設計書 v2 §7・§10.4)。合成データのみ。node:sqlite が要る(Node 24)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApi } from '../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let server, base, db, accounts, repo, issueAuthToken, seq = 0;
const clock = 1_000_000;

const mkUser = () => {
  seq += 1;
  const u = accounts.createUser({ email: `s${seq}@example.test`, name: `乗員${seq}`, passwordHash: 'x', now: clock });
  accounts.markEmailVerified(u.id, clock);
  return { user: u, tok: issueAuthToken(accounts, u.id, clock).token };
};
const mkOrg = (...members) => {
  const org = accounts.createOrg({ name: 'テスト組織', adminUserIds: [members[0].user.id], now: clock });
  for (const m of members) accounts.linkMember({ orgId: org.id, userId: m.user.id, rosterId: null, now: clock });
  return org;
};
const call = (method, path, tok, body, headers = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    ...(typeof body === 'string' ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }),
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    ...headers,
  },
  ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// 2026-10-26 09:00 JST から 1 秒ごと。
const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);
const chunkCsv = (from, n) => {
  const rows = ['time,latitude,longitude,speed,horizontalaccuracy'];
  for (let i = from; i < from + n; i++) rows.push(`${T0 + i * 1000},${(35.3 + i * 0.0001).toFixed(6)},${(139.48 + i * 0.0001).toFixed(6)},2.5,4.8`);
  return rows.join('\n') + '\n';
};
const putChunk = (id, s, csv, tok) => call('PUT', `/api/sessions/${id}/chunks/${s}`, tok, csv, { 'x-chunk-sha256': sha(csv) });
const newSession = (me, extra = {}) => ({
  id: randomUUID(), kind: 'practice', boatNo: '4321',
  crew: [{ role: 'helm', userId: me.user.id, name: me.user.name }],
  startedMs: T0, device: { platform: 'ios', osVersion: '27.0', app: '1.0.0' }, ...extra,
});
// 登録 → 2 チャンク → finalize まで。
async function recordFull(me, extra = {}, headers = {}) {
  const s = newSession(me, extra);
  assert.equal((await call('POST', '/api/sessions', me.tok, s, headers)).status, 200);
  assert.equal((await putChunk(s.id, 0, chunkCsv(0, 3), me.tok)).status, 200);
  assert.equal((await putChunk(s.id, 1, chunkCsv(3, 2), me.tok)).status, 200);
  const fin = await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: T0 + 5000, chunkCount: 2, pointCount: 5 }, headers);
  assert.equal(fin.status, 200);
  return { s, fin: await fin.json() };
}

before(async () => {
  if (skip) return;
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  const { createDbRepo } = await import('../server/repos/dbRepo.js');
  const { createSessionsRepo } = await import('../server/repos/sessionsRepo.js');
  ({ issueAuthToken } = await import('../server/accountAuth.js'));
  db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  accounts = createAccountsRepo({ db });
  repo = createDbRepo({ db, dataDir: '/nonexistent' });
  const sessions = createSessionsRepo({ db });
  const api = createApi({ repo, token: 'shared-secret', accounts, sessions, authOptions: { now: () => clock } });
  server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  db.close();
});

// ---------- 登録 ----------
test('POST: 未ログインは 401', { skip }, async () => {
  const me = mkUser();
  assert.equal((await call('POST', '/api/sessions', null, newSession(me))).status, 401);
});

test('POST: 登録して session を返し、同じ id の再送は同じ結果', { skip }, async () => {
  const me = mkUser();
  const s = newSession(me);
  const a = await call('POST', '/api/sessions', me.tok, s);
  assert.equal(a.status, 200);
  const ja = await a.json();
  assert.equal(ja.session.id, s.id);
  assert.equal(ja.session.ownerUserId, me.user.id);
  assert.equal(ja.session.status, 'receiving');
  assert.equal(ja.session.visibility, 'private'); // 本人の既定(未設定は private)
  assert.deepEqual(ja.session.crew, [{ role: 'helm', userId: me.user.id, name: me.user.name }]);
  const b = await call('POST', '/api/sessions', me.tok, s);
  assert.equal(b.status, 200);
  assert.deepEqual(await b.json(), ja);
});

test('POST: 他人の同じ id は 409', { skip }, async () => {
  const me = mkUser(); const other = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  assert.equal((await call('POST', '/api/sessions', other.tok, newSession(other, { id: s.id }))).status, 409);
});

test('POST: 入力の検証(種別・艇番・乗員・開始時刻)は 422', { skip }, async () => {
  const me = mkUser();
  for (const bad of [{ kind: 'x' }, { boatNo: ' ' }, { crew: [] }, { crew: [{ role: 'helm' }] }, { startedMs: 'a' }, { visibility: 'all' }, { id: 'a/b' }]) {
    const r = await call('POST', '/api/sessions', me.tok, newSession(me, bad));
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal((await r.json()).error.code, 'invalid_input');
  }
});

test('POST: 組織外のユーザーを乗員に選ぶと 422、同じ組織なら通る', { skip }, async () => {
  const me = mkUser(); const mate = mkUser(); const stranger = mkUser();
  mkOrg(me, mate);
  const ok = newSession(me, { crew: [{ role: 'helm', userId: me.user.id, name: 'a' }, { role: 'crew', userId: mate.user.id, name: 'b' }] });
  assert.equal((await call('POST', '/api/sessions', me.tok, ok)).status, 200);
  const ng = newSession(me, { crew: [{ role: 'crew', userId: stranger.user.id, name: 'c' }] });
  assert.equal((await call('POST', '/api/sessions', me.tok, ng)).status, 422);
  // 部外者は氏名だけなら通る
  assert.equal((await call('POST', '/api/sessions', me.tok, newSession(me, { crew: [{ role: 'crew', name: '部外 太郎' }] }))).status, 200);
});

test('POST: レースは公開範囲によらず public', { skip }, async () => {
  const me = mkUser();
  const r = await call('POST', '/api/sessions', me.tok, newSession(me, { kind: 'race', visibility: 'private' }));
  assert.equal((await r.json()).session.visibility, 'public');
});

test('POST: 所属外の組織を X-Sailviz-Org で指すと 403', { skip }, async () => {
  const me = mkUser(); const other = mkUser();
  const org = mkOrg(other);
  assert.equal((await call('POST', '/api/sessions', me.tok, newSession(me), { 'x-sailviz-org': org.id })).status, 403);
});

// ---------- チャンク ----------
test('PUT chunk: stored → 同じ内容の再送は duplicate → 違う内容は 409', { skip }, async () => {
  const me = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  const csv = chunkCsv(0, 3);
  const a = await putChunk(s.id, 0, csv, me.tok);
  assert.deepEqual(await a.json(), { seq: 0, status: 'stored' });
  const b = await putChunk(s.id, 0, csv, me.tok);
  assert.deepEqual(await b.json(), { seq: 0, status: 'duplicate' });
  assert.equal((await putChunk(s.id, 0, chunkCsv(1, 3), me.tok)).status, 409);
});

test('PUT chunk: ハッシュの不一致は 422、所有者以外は 404、無いセッションは 404', { skip }, async () => {
  const me = mkUser(); const other = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  const csv = chunkCsv(0, 3);
  assert.equal((await call('PUT', `/api/sessions/${s.id}/chunks/0`, me.tok, csv, { 'x-chunk-sha256': sha('x') })).status, 422);
  assert.equal((await putChunk(s.id, 0, csv, other.tok)).status, 404);
  assert.equal((await putChunk(randomUUID(), 0, csv, me.tok)).status, 404);
});

test('GET: receivedSeqs で受理済みの seq が分かる(所有者だけ)', { skip }, async () => {
  const me = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  await putChunk(s.id, 1, chunkCsv(3, 2), me.tok);
  const r = await (await call('GET', `/api/sessions/${s.id}`, me.tok)).json();
  assert.deepEqual(r.receivedSeqs, [1]);
  assert.equal(r.session.id, s.id);
});

// ---------- finalize ----------
test('finalize: 欠番は 422、そろえば軌跡になり、二度呼んでも同じ結果', { skip }, async () => {
  const me = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  await putChunk(s.id, 0, chunkCsv(0, 3), me.tok);
  const miss = await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: T0 + 5000, chunkCount: 2, pointCount: 5 });
  assert.equal(miss.status, 422);
  assert.equal((await miss.json()).error.code, 'missing_chunks');
  await putChunk(s.id, 1, chunkCsv(3, 2), me.tok);
  const a = await (await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: T0 + 5000, chunkCount: 2, pointCount: 5 })).json();
  assert.equal(a.pointCount, 5);
  assert.equal(a.csvName, '4321_20261026-0900.csv');
  assert.equal(a.attachedTo.type, 'practiceDay');
  assert.match(a.attachedTo.id, /^pd_/);
  assert.ok(a.bounds.minLat < a.bounds.maxLat);
  const b = await (await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: T0 + 5000, chunkCount: 2, pointCount: 5 })).json();
  assert.deepEqual(b, a);
  const got = await (await call('GET', `/api/sessions/${s.id}`, me.tok)).json();
  assert.equal(got.session.status, 'finalized');
  assert.equal(got.session.endedMs, T0 + 5000);
  assert.equal(got.session.pointCount, 5);
  assert.equal(got.session.chunkCount, 2);
  assert.equal(got.session.csvName, '4321_20261026-0900.csv');
});

test('finalize: GPS として読めない CSV は 422', { skip }, async () => {
  const me = mkUser();
  const s = newSession(me);
  await call('POST', '/api/sessions', me.tok, s);
  await putChunk(s.id, 0, 'a,b\n1,2\n', me.tok);
  const r = await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: T0, chunkCount: 1, pointCount: 1 });
  assert.equal(r.status, 422);
});

test('finalize: 組織の練習は「組織×日付」の器に入り、Web の練習一覧に艇として出る', { skip }, async () => {
  const me = mkUser(); const mate = mkUser();
  const org = mkOrg(me, mate);
  const { s: s1, fin: f1 } = await recordFull(me, { visibility: 'org' });
  const { fin: f2 } = await recordFull(mate, { boatNo: '5555', visibility: 'org', crew: [{ role: 'helm', userId: mate.user.id, name: 'm' }] });
  assert.equal(f1.attachedTo.id, f2.attachedTo.id); // 同じ組織・同じ日は同じ器
  const pd = db.prepare('SELECT * FROM practice_days WHERE id = ?').get(f1.attachedTo.id);
  assert.equal(pd.org_id, org.id);
  assert.equal(pd.date, '2026-10-26');
  assert.ok(pd.legacy_name);
  assert.ok(pd.rev >= 2);
  const proj = repo.readProject(pd.id);
  assert.equal(proj.practiceDate, Date.UTC(2026, 9, 25, 15)); // JST 0:00
  const t = proj.tracks.find((x) => x.id === s1.id);
  assert.equal(t.name, '4321');
  assert.equal(t.points.length, 5);
  assert.equal(t.source.filename, '4321_20261026-0900.csv');
  assert.equal(t.source.boatNumber, '4321');
  assert.equal(proj.tracks.length, 2);
  assert.notEqual(proj.tracks[0].color, proj.tracks[1].color);
});

test('finalize: 組織外のユーザーの練習は「本人×日付」の器、レースはレース記録', { skip }, async () => {
  const me = mkUser();
  const { fin } = await recordFull(me);
  const pd = db.prepare('SELECT * FROM practice_days WHERE id = ?').get(fin.attachedTo.id);
  assert.equal(pd.org_id, null);
  assert.equal(pd.owner_user_id, me.user.id);
  const { fin: race } = await recordFull(me, { kind: 'race' });
  assert.equal(race.attachedTo.type, 'raceRecord');
  const rr = db.prepare('SELECT * FROM race_records WHERE id = ?').get(race.attachedTo.id);
  assert.equal(rr.owner_user_id, me.user.id);
  assert.equal(rr.race_date, '2026-10-26');
});

test('finalize: X-Sailviz-Org で記録した時の組織の器に入る', { skip }, async () => {
  const me = mkUser();
  mkOrg(me);
  const org2 = mkOrg(me);
  const { fin } = await recordFull(me, {}, { 'x-sailviz-org': org2.id });
  assert.equal(db.prepare('SELECT org_id FROM practice_days WHERE id = ?').get(fin.attachedTo.id).org_id, org2.id);
});

test('finalize 後に Web から古い内容を保存しても、届いた軌跡は消えない', { skip }, async () => {
  const me = mkUser();
  mkOrg(me);
  const { s, fin } = await recordFull(me, { visibility: 'org' });
  const proj = repo.readProject(fin.attachedTo.id);
  repo.writeProject(fin.attachedTo.id, { ...proj, tracks: [] });
  assert.ok(repo.readProject(fin.attachedTo.id).tracks.some((t) => t.id === s.id));
});

// ---------- 閲覧 ----------
test('GET: private は本人と乗員だけ、org は組織メンバー、public は誰でも', { skip }, async () => {
  const me = mkUser(); const mate = mkUser(); const crewU = mkUser(); const stranger = mkUser();
  mkOrg(me, mate, crewU);
  const crew = [{ role: 'helm', userId: me.user.id, name: 'a' }, { role: 'crew', userId: crewU.user.id, name: 'c' }];
  const { s: p } = await recordFull(me, { crew });
  assert.equal((await call('GET', `/api/sessions/${p.id}`, me.tok)).status, 200);
  assert.equal((await call('GET', `/api/sessions/${p.id}`, crewU.tok)).status, 200);
  assert.equal((await call('GET', `/api/sessions/${p.id}`, mate.tok)).status, 404);
  const { s: o } = await recordFull(me, { visibility: 'org' });
  assert.equal((await call('GET', `/api/sessions/${o.id}`, mate.tok)).status, 200);
  assert.equal((await call('GET', `/api/sessions/${o.id}`, stranger.tok)).status, 404);
  const { s: pub } = await recordFull(me, { visibility: 'public' });
  const r = await (await call('GET', `/api/sessions/${pub.id}`, null)).json();
  assert.equal(r.session.id, pub.id);
  assert.equal(r.receivedSeqs, undefined); // 所有者以外には出さない
});

test('GET csv / track: 連結した CSV を csv_name で返し、軌跡を返す', { skip }, async () => {
  const me = mkUser();
  const { s } = await recordFull(me);
  const r = await call('GET', `/api/sessions/${s.id}/csv`, me.tok);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /4321_20261026-0900\.csv/);
  const text = await r.text();
  assert.equal(text.trim().split('\n').length, 6); // ヘッダ 1 行 + 5 点
  const tr = await (await call('GET', `/api/sessions/${s.id}/track`, me.tok)).json();
  assert.equal(tr.points.length, 5);
  assert.ok(tr.tRange.start < tr.tRange.end);
  assert.equal((await call('GET', `/api/sessions/${s.id}/csv`, mkUser().tok)).status, 404);
});

test('GET /api/sessions?scope=mine|crew: 自分の記録と、乗員として乗った記録(新しい順)', { skip }, async () => {
  const me = mkUser(); const crewU = mkUser();
  mkOrg(me, crewU);
  const { s: a } = await recordFull(me, { startedMs: T0 });
  const { s: b } = await recordFull(me, { startedMs: T0 + 60_000, crew: [{ role: 'helm', userId: me.user.id, name: 'a' }, { role: 'crew', userId: crewU.user.id, name: 'c' }] });
  const mine = await (await call('GET', '/api/sessions?scope=mine', me.tok)).json();
  assert.deepEqual(mine.map((x) => x.id), [b.id, a.id]);
  const crew = await (await call('GET', '/api/sessions?scope=crew', crewU.tok)).json();
  assert.deepEqual(crew.map((x) => x.id), [b.id]);
  assert.equal((await call('GET', '/api/sessions?scope=x', me.tok)).status, 422);
});

// ---------- 修正・削除 ----------
test('PATCH: 所有者は艇番・乗員・公開範囲を直せ、軌跡の名前も変わる', { skip }, async () => {
  const me = mkUser(); const other = mkUser();
  const { s, fin } = await recordFull(me);
  assert.equal((await call('PATCH', `/api/sessions/${s.id}`, other.tok, { boatNo: '1' })).status, 404);
  const r = await call('PATCH', `/api/sessions/${s.id}`, me.tok, { boatNo: '9999', visibility: 'public', crew: [{ role: 'helm', name: '新しい 名前' }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.session.boatNo, '9999');
  assert.equal(j.session.visibility, 'public');
  assert.equal(j.session.crew[0].name, '新しい 名前');
  const t = repo.readProject(fin.attachedTo.id).tracks.find((x) => x.id === s.id);
  assert.equal(t.name, '9999');
  assert.equal(t.source.boatNumber, '9999');
});

test('PATCH: 練習をレースにすると練習日の器から外れてレース記録に付き、public になる', { skip }, async () => {
  const me = mkUser();
  const { s, fin } = await recordFull(me);
  const j = await (await call('PATCH', `/api/sessions/${s.id}`, me.tok, { kind: 'race' })).json();
  assert.equal(j.session.kind, 'race');
  assert.equal(j.session.visibility, 'public');
  assert.equal(j.session.attachedTo.type, 'raceRecord');
  assert.ok(!repo.readProject(fin.attachedTo.id).tracks.some((t) => t.id === s.id));
  const back = await (await call('PATCH', `/api/sessions/${s.id}`, me.tok, { kind: 'practice' })).json();
  assert.equal(back.session.attachedTo.type, 'practiceDay');
  assert.ok(repo.readProject(back.session.attachedTo.id).tracks.some((t) => t.id === s.id));
});

test('DELETE: 所有者だけがセッションと軌跡を消せる', { skip }, async () => {
  const me = mkUser(); const other = mkUser();
  const { s, fin } = await recordFull(me);
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`, other.tok)).status, 404);
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`, me.tok)).status, 204);
  assert.equal((await call('GET', `/api/sessions/${s.id}`, me.tok)).status, 404);
  assert.ok(!repo.readProject(fin.attachedTo.id).tracks.some((t) => t.id === s.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?').get(s.id).n, 0);
});

test('PUT chunk: 確定後は同じ内容の再送だけ受け、新しい seq は 409', { skip }, async () => {
  const me = mkUser();
  const { s } = await recordFull(me);
  assert.equal((await (await putChunk(s.id, 0, chunkCsv(0, 3), me.tok)).json()).status, 'duplicate');
  assert.equal((await putChunk(s.id, 2, chunkCsv(5, 1), me.tok)).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?').get(s.id).n, 2);
});
