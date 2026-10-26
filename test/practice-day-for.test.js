// test/practice-day-for.test.js — 練習日の器を決める共用処理。合成データのみ。node:sqlite が要る(Node 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
const { practiceDateToMs, dayFor, jstDate } = await import('../server/repos/practiceDayFor.js');

test('practiceDateToMs: date は JST 0:00 の ms(区切り / と -、ゼロ埋めなしも可)', () => {
  assert.equal(practiceDateToMs({ date: '2026/10/03' }), Date.UTC(2026, 9, 2, 15));
  assert.equal(practiceDateToMs({ date: '2026-10-03' }), Date.UTC(2026, 9, 2, 15));
  assert.equal(practiceDateToMs({ date: '2026/1/3' }), Date.UTC(2026, 0, 2, 15));
});

test('practiceDateToMs: startMs が有限数なら優先', () => {
  assert.equal(practiceDateToMs({ startMs: 123, date: '2026/10/03' }), 123);
});

test('practiceDateToMs: 読めないものは null', () => {
  assert.equal(practiceDateToMs({}), null);
  assert.equal(practiceDateToMs(undefined), null);
  assert.equal(practiceDateToMs({ date: '10/03' }), null);
  assert.equal(practiceDateToMs({ date: '2026/13/40' }), null);
});

test('jstDate: JST の日付', () => {
  assert.equal(jstDate(Date.UTC(2026, 9, 2, 15)), '2026-10-03');
});

test('dayFor: 同じ組織・同じ日は同じ器、組織なしは本人の器', { skip }, async () => {
  const { openDb } = await import('../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../server/db/migrate.js');
  const { createAccountsRepo } = await import('../server/repos/accountsRepo.js');
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const u = accounts.createUser({ email: 'd@example.test', name: '乗員', passwordHash: 'x', now: 1 });
  const org = accounts.createOrg({ name: 'テスト組織', adminUserIds: [u.id], now: 1 });
  const t = Date.UTC(2026, 9, 26, 0, 0, 0);
  const a = dayFor(db, { orgId: org.id, ownerUserId: u.id, firstPointMs: t, now: 10 });
  const b = dayFor(db, { orgId: org.id, ownerUserId: u.id, firstPointMs: t + 1000, now: 20 });
  assert.equal(a.id, b.id);
  assert.equal(a.owner_user_id, null);
  const c = dayFor(db, { orgId: null, ownerUserId: u.id, firstPointMs: t, now: 30 });
  assert.notEqual(c.id, a.id);
  assert.equal(c.owner_user_id, u.id);
  assert.equal(dayFor(db, { orgId: null, ownerUserId: u.id, firstPointMs: t, now: 40 }).id, c.id);
  db.close();
});
