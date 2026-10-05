// test/db-migrate.test.js
// DB 接続(WAL・外部キー)とマイグレーション実行(schema_migrations で順番適用・冪等)。
// node:sqlite が要る(Node >=22.5 / 24)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';

test('接続は外部キーが有効', () => {
  const db = openDb(':memory:');
  const fk = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(fk.foreign_keys, 1);
  db.close();
});

test('migrate は未適用を順に当て、schema_migrations に記録する', () => {
  const db = openDb(':memory:');
  const migrations = [
    { version: 2, sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);' },
    { version: 1, sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);' },
  ];
  const n = migrate(db, migrations, 1000);
  assert.equal(n, 2);
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, [1, 2]);
  // 両テーブルが存在する
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b') ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['a', 'b']);
  db.close();
});

test('migrate は冪等(2回目は0件適用)', () => {
  const db = openDb(':memory:');
  const migrations = [{ version: 1, sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);' }];
  assert.equal(migrate(db, migrations, 1000), 1);
  assert.equal(migrate(db, migrations, 2000), 0);
  db.close();
});

test('失敗したマイグレーションはロールバックし記録しない', () => {
  const db = openDb(':memory:');
  const migrations = [{ version: 1, sql: 'CREATE TABLE a (id TEXT PRIMARY KEY); THIS IS NOT SQL;' }];
  assert.throws(() => migrate(db, migrations, 1000));
  const rows = db.prepare('SELECT count(*) c FROM schema_migrations').get();
  assert.equal(rows.c, 0);
  db.close();
});
