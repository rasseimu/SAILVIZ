// test/db-schema.test.js
// migrations/ を読み込んで 001_data.sql を適用し、Phase 1 のデータ表が揃うことを確認。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../server/db/connection.js';
import { migrate, loadMigrations } from '../server/db/migrate.js';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');

test('001_data で Phase 1 の全データ表が作られる', () => {
  const db = openDb(':memory:');
  const n = migrate(db, loadMigrations(MIG_DIR), 1000);
  assert.ok(n >= 1);
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

test('practice_days.legacy_name は UNIQUE', () => {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1000);
  const ins = db.prepare('INSERT INTO practice_days (id, date, legacy_name, rev) VALUES (?, ?, ?, 0)');
  ins.run('pd_1', '2026-09-03', 'a.sailviz.json');
  assert.throws(() => ins.run('pd_2', '2026-09-03', 'a.sailviz.json'), /UNIQUE/);
  db.close();
});
