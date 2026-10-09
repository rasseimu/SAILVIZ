// server/db/migrate.js
// schema_migrations による順番適用。未適用のマイグレーションだけをバージョン順に当て、
// 各適用はトランザクションで包む(失敗はロールバックし記録しない)。冪等。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// migrations: [{version:number, sql:string}]。返り値は適用した件数。
export function migrate(db, migrations, now = Date.now()) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  let count = 0;
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      insert.run(m.version, now);
      db.exec('COMMIT');
      count += 1;
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} failed: ${e.message}`);
    }
  }
  return count;
}

// server/db/migrations/ の *.sql を {version, sql} に読む。ファイル名先頭の数字が version。
export function loadMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .map((f) => ({ version: Number(f.match(/^(\d+)/)[1]), sql: readFileSync(join(dir, f), 'utf8'), file: f }))
    .sort((a, b) => a.version - b.version);
}
