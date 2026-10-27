// test/db-migrate-tracks-points-last.test.js — 008: tracks の点列(points)を最後の列へ移す(表の作り直し)。
// 点列の後ろにある列(t_range・view など)を読むと、キャッシュが空のとき点列のぶんまでディスクから読むため。
// node:sqlite が要る(Node >=22.5 / 24)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let openDb, migrate, loadMigrations;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
}

test('008 は tracks の点列を最後の列にし、既存の行をそのまま残す', { skip: skipMsg }, () => {
  const db = openDb(':memory:');
  const all = loadMigrations(MIG_DIR);
  const m8 = all.find((m) => m.version === 8);
  assert.ok(m8, '008 がある');
  migrate(db, all.filter((m) => m.version < 8), 1);
  const rows = [
    { session_id: 's1', points: JSON.stringify([{ t: 1, lat: 35, lon: 139 }]), bounds: '{"minLat":35}', t_range: '{"start":1,"end":2}', point_count: 1, csv_name: 'a.csv', view: '{"name":"A"}' },
    { session_id: 's2', points: null, bounds: null, t_range: null, point_count: null, csv_name: null, view: null },
  ];
  const ins = db.prepare('INSERT INTO tracks (session_id, points, bounds, t_range, point_count, csv_name, view) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.session_id, r.points, r.bounds, r.t_range, r.point_count, r.csv_name, r.view);

  assert.equal(migrate(db, all.filter((m) => m.version <= 8), 2), 1); // 008 だけ当てる(009 以降は別のテスト)

  const cols = db.prepare('PRAGMA table_info(tracks)').all();
  assert.deepEqual(cols.map((c) => c.name), ['session_id', 'bounds', 't_range', 'point_count', 'csv_name', 'view', 'points']);
  assert.equal(cols.find((c) => c.name === 'session_id').pk, 1, 'session_id は主キーのまま');
  const got = db.prepare('SELECT session_id, points, bounds, t_range, point_count, csv_name, view FROM tracks ORDER BY session_id').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(got, rows);
  assert.throws(() => ins.run('s1', null, null, null, null, null, null), /UNIQUE|constraint/i, '主キーの重複は断る');
  db.close();
});
