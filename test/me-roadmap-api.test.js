// test/me-roadmap-api.test.js — ロードマップ API(/api/me/roadmap。設計書 Phase 4 §5)。合成データのみ。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip } from './helpers/apiHarness.js';

let h;
before(async () => { if (!skip) h = await startApi(); });
after(async () => { if (h) await h.close(); });

const ms = (over = {}) => ({ id: 'm1', title: '風下マークを速く回る', done: false, doneAt: null, ...over });

test('GET: ロードマップの無い人は {goal:"", milestones:[]}、未ログインは 401', { skip }, async () => {
  const u = h.mkUser();
  const r = await h.call('GET', '/api/me/roadmap', u.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { goal: '', milestones: [] });
  assert.equal((await h.call('GET', '/api/me/roadmap', null)).status, 401);
  assert.equal((await h.call('PUT', '/api/me/roadmap', null, { goal: '', milestones: [] })).status, 401);
});

test('PUT → GET: 置き換えた内容が返る', { skip }, async () => {
  const u = h.mkUser();
  const body = { goal: '全日本で入賞', milestones: [ms(), ms({ id: 'm2', done: true, doneAt: 1791015000000 })] };
  const p = await h.call('PUT', '/api/me/roadmap', u.tok, body);
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), body);
  assert.deepEqual(await (await h.call('GET', '/api/me/roadmap', u.tok)).json(), body);
  const p2 = await h.call('PUT', '/api/me/roadmap', u.tok, { goal: '変更', milestones: [] });
  assert.deepEqual(await p2.json(), { goal: '変更', milestones: [] });
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM roadmaps WHERE user_id = ?').get(u.user.id).c, 1);
});

test('PUT: 作った行は表示中の組織(X-Sailviz-Org で選んだ組織)の互換 overlay に表示名で出る', { skip }, async () => {
  const u = h.mkUser();
  h.mkOrg(u); h.mkOrg(u);
  // ヘッダーなしなら所属の先頭になるので、先頭でない方をヘッダーで選ぶ
  const [first, org] = h.accounts.listMembershipsOfUser(u.user.id).map((m) => ({ id: m.org_id }));
  const body = { goal: '目標A', milestones: [ms()] };
  assert.equal((await h.call('PUT', '/api/me/roadmap', u.tok, body, { 'x-sailviz-org': org.id })).status, 200);
  const ov = h.repo.readOverlay('roadmap', { orgId: org.id });
  assert.deepEqual(ov[u.user.name], body);
  assert.equal(h.repo.readOverlay('roadmap', { orgId: first.id })[u.user.name], undefined);
});

test('PUT: 旧データを付け替え済みの行は legacy_name・org_id を保って goal だけ変わる', { skip }, async () => {
  const u = h.mkUser();
  const org = h.mkOrg(u);
  h.db.prepare('INSERT INTO roadmaps (id, user_id, org_id, legacy_name, goal, milestones, extra, updated_at) VALUES (?,?,?,?,?,?,NULL,1)')
    .run('rm_old', u.user.id, org.id, '旧氏名', '旧目標', '[]');
  const r = await h.call('PUT', '/api/me/roadmap', u.tok, { goal: '新目標', milestones: [ms()] });
  assert.equal(r.status, 200);
  const row = h.db.prepare('SELECT * FROM roadmaps WHERE user_id = ?').get(u.user.id);
  assert.equal(row.id, 'rm_old');
  assert.equal(row.legacy_name, '旧氏名');
  assert.equal(row.org_id, org.id);
  assert.equal(row.goal, '新目標');
  assert.equal(h.repo.readOverlay('roadmap', { orgId: org.id })['旧氏名'].goal, '新目標');
});

test('PUT: 形が違えば 422', { skip }, async () => {
  const u = h.mkUser();
  const bad = [
    { goal: 1, milestones: [] },
    { goal: 'x'.repeat(2001), milestones: [] },
    { goal: '', milestones: 'x' },
    { goal: '', milestones: Array.from({ length: 201 }, (_, i) => ms({ id: `m${i}` })) },
    { goal: '', milestones: [ms({ id: '' })] },
    { goal: '', milestones: [ms({ title: 5 })] },
    { goal: '', milestones: [ms({ done: 'yes' })] },
    { goal: '', milestones: [ms({ doneAt: '1' })] },
    { goal: '', milestones: [null] },
    [],
  ];
  for (const b of bad) {
    const r = await h.call('PUT', '/api/me/roadmap', u.tok, b);
    assert.equal(r.status, 422, JSON.stringify(b).slice(0, 60));
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM roadmaps WHERE user_id = ?').get(u.user.id).c, 0);
});
