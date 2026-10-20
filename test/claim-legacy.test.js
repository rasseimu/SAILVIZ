// test/claim-legacy.test.js — 旧氏名の付け替え CLI(FZ3-C)。合成データのみ。Node 24 が要る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [major] = process.versions.node.split('.').map(Number);
const skip = major >= 24 ? undefined : 'node:sqlite の isTransaction が要る(Node >=24)';
let openDb, migrate, loadMigrations, createAccountsRepo, parseCsv, planClaims, applyClaims, run;
if (!skip) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createAccountsRepo } = await import('../server/repos/accountsRepo.js'));
  ({ parseCsv, planClaims, applyClaims } = await import('../server/claimLegacy.js'));
  ({ run } = await import('../scripts/claim-legacy.mjs'));
}
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

function seed(db) {
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const org = accounts.createOrg({ name: 'テスト部', now: 1 });
  const user = (email, member = true) => {
    const u = accounts.createUser({ email, name: email, passwordHash: 'x', now: 1 });
    if (member) accounts.linkMember({ orgId: org.id, userId: u.id, rosterId: null, now: 1 });
    return u;
  };
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pd1', org.id, '2026-10-01');
  db.prepare("INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES ('r1','pd1','旧A','org')").run();
  db.prepare("INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES ('r2','pd1','旧A','org')").run();
  db.prepare("INSERT INTO rec_sessions (id, legacy_owner_name, kind, practice_day_id, visibility) VALUES ('s1','旧A','practice','pd1','org')").run();
  db.prepare("INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES ('r3','pd1','旧B','org')").run();
  db.prepare("INSERT INTO roadmaps (id, org_id, legacy_name) VALUES ('rm1', ?, '旧A')").run(org.id);
  return { accounts, org, user };
}
const snapshot = (db) => JSON.stringify([
  db.prepare('SELECT id, author_user_id FROM reflections ORDER BY id').all(),
  db.prepare('SELECT id, owner_user_id FROM rec_sessions ORDER BY id').all(),
  db.prepare('SELECT id, user_id FROM roadmaps ORDER BY id').all(),
]);

test('parseCsv: 見出し・BOM・引用・メール小文字化', { skip }, () => {
  const rows = parseCsv('﻿旧氏名,メール\r\n"旧,A",A@Example.test\n\n旧B,b@example.test\n');
  assert.deepEqual(rows, [
    { legacyName: '旧,A', email: 'a@example.test' }, { legacyName: '旧B', email: 'b@example.test' },
  ]);
});

test('dry-run(plan)は件数を出し、何も書かない', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  user('a@example.test');
  const before = snapshot(db);
  const plan = planClaims({ db, accounts }, org.id, [{ legacyName: '旧A', email: 'a@example.test' }]);
  assert.equal(plan[0].status, 'ok');
  assert.deepEqual(plan[0].counts, { reflections: 2, sessions: 1, roadmaps: 1, roadmapBlocked: false });
  assert.equal(snapshot(db), before);
});

test('apply で付け替わり、2回目は 0 件で結果不変', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  const u = user('a@example.test');
  const rows = [{ legacyName: '旧A', email: 'a@example.test' }];
  const r1 = applyClaims({ db, accounts }, org.id, rows);
  assert.deepEqual(r1.total, { reflections: 2, sessions: 1, roadmaps: 1 });
  assert.equal(db.prepare("SELECT author_user_id AS a FROM reflections WHERE id='r1'").get().a, u.id);
  assert.equal(db.prepare("SELECT author_user_id AS a FROM reflections WHERE id='r3'").get().a, null);
  const after = snapshot(db);
  const r2 = applyClaims({ db, accounts }, org.id, rows);
  assert.deepEqual(r2.total, { reflections: 0, sessions: 0, roadmaps: 0 });
  assert.equal(r2.plan[0].status, 'ok');
  assert.deepEqual(r2.plan[0].counts, { reflections: 0, sessions: 0, roadmaps: 0, roadmapBlocked: false });
  assert.equal(snapshot(db), after);
});

test('メンバー外は拒否・見つからない旧氏名／メール・重複は付け替えない', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  user('out@example.test', false);
  user('b@example.test');
  const before = snapshot(db);
  const rows = [
    { legacyName: '旧A', email: 'out@example.test' },
    { legacyName: '旧Z', email: 'c@example.test' },
    { legacyName: '旧B', email: 'nobody@example.test' },
    { legacyName: '旧B', email: 'b@example.test' },
    { legacyName: '旧B', email: 'b2@example.test' },
    { legacyName: '', email: 'b@example.test' },
  ];
  const { plan, total } = applyClaims({ db, accounts }, org.id, rows);
  assert.deepEqual(plan.map((p) => p.status),
    ['not_member', 'legacy_not_found', 'duplicate', 'duplicate', 'duplicate', 'invalid']);
  assert.deepEqual(total, { reflections: 0, sessions: 0, roadmaps: 0 });
  assert.equal(snapshot(db), before);
});

test('存在しない組織は投げる', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts } = seed(db);
  assert.throws(() => planClaims({ db, accounts }, 'o_none', []), /組織が見つかりません/);
});

test('CLI: 既定 dry-run は書かず、--apply で付け替える', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-legacy-'));
  try {
    const dbPath = join(dir, 'sailviz.db');
    const db = openDb(dbPath);
    const { org, user } = seed(db);
    user('a@example.test');
    db.close();
    const csv = join(dir, 'map.csv');
    writeFileSync(csv, '旧氏名,メール\n旧A,a@example.test\n旧B,out@example.test\n');
    const lines = [];
    const out = (s) => lines.push(s);
    assert.equal(run(['node', 'x', csv, '--org', org.id, '--db', dbPath], {}, out), 0);
    assert.match(lines.join('\n'), /dry-run/);
    assert.match(lines.join('\n'), /反省 2 \/ ロードマップ 1 \/ 軌跡 1 件を付け替える予定/);
    assert.match(lines.join('\n'), /ユーザーがいない/);
    const check = () => { const d = openDb(dbPath); const n = Number(d.prepare('SELECT COUNT(*) AS n FROM reflections WHERE author_user_id IS NOT NULL').get().n); d.close(); return n; };
    assert.equal(check(), 0);
    lines.length = 0;
    assert.equal(run(['node', 'x', csv, '--org', org.id, '--db', dbPath, '--apply'], {}, out), 0);
    assert.match(lines.join('\n'), /付け替え合計: 反省 2 \/ ロードマップ 1 \/ 軌跡 1/);
    assert.equal(check(), 2);
    assert.equal(run(['node', 'x'], {}, out), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply の途中で例外が出たら全部戻る', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  user('a@example.test'); user('b@example.test');
  const before = snapshot(db);
  const orig = accounts.reattachLegacy.bind(accounts);
  let calls = 0;
  accounts.reattachLegacy = (a) => { calls += 1; if (calls === 2) throw new Error('boom'); return orig(a); };
  assert.throws(() => applyClaims({ db, accounts }, org.id, [
    { legacyName: '旧A', email: 'a@example.test' }, { legacyName: '旧B', email: 'b@example.test' },
  ]), /boom/);
  assert.equal(calls, 2);
  assert.equal(snapshot(db), before);
});

test('他の組織にある同じ旧氏名には触れない', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  const other = accounts.createOrg({ name: '他部', now: 1 });
  db.prepare('INSERT INTO practice_days (id, org_id, date, rev) VALUES (?, ?, ?, 0)').run('pdO', other.id, '2026-10-01');
  db.prepare("INSERT INTO reflections (id, practice_day_id, legacy_author_name, visibility) VALUES ('rO','pdO','旧A','org')").run();
  db.prepare("INSERT INTO roadmaps (id, org_id, legacy_name) VALUES ('rmO', ?, '旧A')").run(other.id);
  user('a@example.test');
  applyClaims({ db, accounts }, org.id, [{ legacyName: '旧A', email: 'a@example.test' }]);
  assert.equal(db.prepare("SELECT author_user_id AS a FROM reflections WHERE id='rO'").get().a, null);
  assert.equal(db.prepare("SELECT user_id AS a FROM roadmaps WHERE id='rmO'").get().a, null);
});

test('退会済みユーザーは user_not_found', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  const u = user('a@example.test');
  accounts.markUserDeleted(u.id, 5);
  const plan = planClaims({ db, accounts }, org.id, [{ legacyName: '旧A', email: 'a@example.test' }]);
  assert.equal(plan[0].status, 'user_not_found');
});

test('本人が既にロードマップを持つと移さず、理由を表示する', { skip }, () => {
  const db = openDb(':memory:');
  const { accounts, org, user } = seed(db);
  const u = user('a@example.test');
  db.prepare("INSERT INTO roadmaps (id, org_id, user_id) VALUES ('rmMine', ?, ?)").run(org.id, u.id);
  const plan = planClaims({ db, accounts }, org.id, [{ legacyName: '旧A', email: 'a@example.test' }]);
  assert.equal(plan[0].counts.roadmaps, 0);
  assert.equal(plan[0].counts.roadmapBlocked, true);
  assert.equal(plan[0].counts.reflections, 2);
});

test('CLI: DB が無ければファイルを作らず止まる／未適用マイグレーションでは止まる', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-legacy-'));
  try {
    const csv = join(dir, 'map.csv');
    writeFileSync(csv, '旧A,a@example.test\n');
    const missing = join(dir, 'nope.db');
    assert.throws(() => run(['node', 'x', csv, '--org', 'o_x', '--db', missing], {}, () => {}), /DB ファイルがありません/);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(`${missing}-wal`), false);
    const empty = join(dir, 'empty.db');
    const d = openDb(empty); d.close();
    for (const extra of [[], ['--apply']]) {
      assert.throws(() => run(['node', 'x', csv, '--org', 'o_x', '--db', empty, ...extra], {}, () => {}), /未適用のマイグレーション/);
    }
    const d2 = openDb(empty);
    assert.equal(Number(d2.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get().n), 0);
    d2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
