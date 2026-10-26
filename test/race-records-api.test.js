// test/race-records-api.test.js — レース記録 API(/api/race-records。設計書 Phase 4 §8)。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, T0 } from './helpers/apiHarness.js';

let h;
before(async () => { if (!skip) h = await startApi(); });
after(async () => { if (h) await h.close(); });

const DAY = 86_400_000;
const list = (tok, q = '') => h.call('GET', `/api/race-records${q}`, tok);
const race = (u, t0) => h.recordFull(u, { kind: 'race' }, {}, t0);

test('一覧 mine: 自分のレースだけ、未ログインは 401', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser();
  await race(a, T0 + 100 * DAY);
  await race(b, T0 + 101 * DAY);
  await h.recordFull(a, { kind: 'practice' }, {}, T0 + 102 * DAY);
  assert.equal((await list(null, '?scope=mine')).status, 401);
  const r = await list(a.tok, '?scope=mine');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].ownerUserId, a.user.id);
  assert.equal(body[0].sessionCount, 1);
  assert.equal((await list(a.tok)).status, 200); // 既定は public
});

test('一覧 public: 未ログインでも全員のレースが新しい順に出る', { skip }, async () => {
  const a = h.mkUser(); const b = h.mkUser();
  await race(a, T0 + 200 * DAY);
  await race(b, T0 + 210 * DAY);
  const r = await list(null, '?scope=public');
  assert.equal(r.status, 200);
  const body = await r.json();
  const mine = body.filter((x) => [a.user.id, b.user.id].includes(x.ownerUserId));
  assert.equal(mine.length, 2);
  assert.equal(mine[0].ownerUserId, b.user.id);
  const dates = body.map((x) => x.raceDate);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal((await list(null, '?scope=org')).status, 422);
});

test('1件: レース記録とセッションが返り、無い ID は 404', { skip }, async () => {
  const a = h.mkUser();
  const { s } = await race(a, T0 + 300 * DAY);
  const id = (await (await list(a.tok, '?scope=mine')).json())[0].id;
  const r = await h.call('GET', `/api/race-records/${encodeURIComponent(id)}`, null);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.raceRecord.id, id);
  assert.equal(body.raceRecord.ownerUserId, a.user.id);
  assert.deepEqual(body.sessions.map((x) => x.id), [s.id]);
  assert.equal((await h.call('GET', '/api/race-records/nope', null)).status, 404);
});
