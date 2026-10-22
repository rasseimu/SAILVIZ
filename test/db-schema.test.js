// test/db-schema.test.js
// migrations/ を読み込んで 001_data.sql を適用し、Phase 1 のデータ表が揃うことを確認。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// node:sqlite ガード: Node <22.5 では skip する
const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');

let openDb, migrate, loadMigrations;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
}

test('001_data で Phase 1 の全データ表が作られる', { skip: skipMsg }, () => {
  const db = openDb(':memory:');
  // 001 だけを適用する(002 以降の表は各マイグレーションのテストで確認する)
  const n = migrate(db, loadMigrations(MIG_DIR).filter((m) => m.version === 1), 1000);
  assert.equal(n, 1);
  const expected = [
    'practice_days', 'rec_sessions', 'session_crew', 'chunks', 'tracks',
    'reflections', 'reflection_progress', 'reflection_comments', 'roadmaps', 'race_records',
  ].sort();
  const got = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name",
  ).all().map((r) => r.name);
  assert.deepEqual(got, expected);
  db.close();
});

test('005: practice_days.legacy_name は重複できる・既存行と列は保たれる', { skip: skipMsg }, () => {
  const db = openDb(':memory:');
  const all = loadMigrations(MIG_DIR);
  migrate(db, all.filter((m) => m.version <= 4), 1000);
  db.prepare(
    `INSERT INTO practice_days (id, org_id, owner_user_id, date, legacy_name, web_state, saved_at, rev, created_at, updated_at)
     VALUES ('pd_1', 'org_1', NULL, '2026-09-03', 'a.sailviz.json', '{"mode":"x"}', '2026-09-03T10:00:00Z', 3, 111, 222)`,
  ).run();
  const before = db.prepare('SELECT * FROM practice_days WHERE id = ?').get('pd_1');
  migrate(db, all.filter((m) => m.version === 5), 2000);
  // 同じ legacy_name の 2 行目を入れられる
  db.prepare("INSERT INTO practice_days (id, date, legacy_name, rev) VALUES ('pd_2', '2026-09-03', 'a.sailviz.json', 0)").run();
  // 既存行は全列そのまま
  assert.deepEqual(db.prepare('SELECT * FROM practice_days WHERE id = ?').get('pd_1'), before);
  // 一意でない索引が付く
  const idx = db.prepare('PRAGMA index_list(practice_days)').all().find((i) => i.name === 'idx_practice_days_legacy_name');
  assert.ok(idx);
  assert.equal(idx.unique, 0);
  db.close();
});
