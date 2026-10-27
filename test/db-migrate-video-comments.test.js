// test/db-migrate-video-comments.test.js — 009: 動画の瞬間コメントの表(video_comments)と CHECK・索引。
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

const COLS = 'id, org_id, scope, practice_day_id, video_key, video_name, position_ms, text, author_user_id, created_at, updated_at';
const row = (over = {}) => ({
  id: 'vc_1', org_id: 'o_a', scope: 'practice', practice_day_id: 'pd_0000000001', video_key: '["a.mp4",1]', video_name: 'a.mp4',
  position_ms: 0, text: 'x', author_user_id: 'u1', created_at: 1, updated_at: 1, ...over,
});

test('009 は video_comments を作り、008 までの表と行はそのまま', { skip: skipMsg }, () => {
  const db = openDb(':memory:');
  const all = loadMigrations(MIG_DIR);
  assert.ok(all.find((m) => m.version === 9), '009 がある');
  migrate(db, all.filter((m) => m.version < 9), 1);
  db.prepare("INSERT INTO practice_days (id, org_id, date, rev) VALUES ('pd_0000000001', 'o_a', '2026-10-26', 0)").run();
  assert.equal(migrate(db, all, 2), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM practice_days').get().c, 1);
  const cols = db.prepare('PRAGMA table_info(video_comments)').all().map((c) => c.name);
  assert.deepEqual(cols, COLS.split(', '));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='video_comments' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx, ['idx_video_comments_day', 'idx_video_comments_org']);
  // 冪等
  assert.equal(migrate(db, all, 3), 0);
  db.close();
});

test('009 の CHECK: scope・位置・practice の練習ID の有無', { skip: skipMsg }, () => {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1);
  const ins = (r) => db.prepare(`INSERT INTO video_comments (${COLS}) VALUES (${COLS.split(', ').map(() => '?').join(', ')})`)
    .run(...COLS.split(', ').map((k) => r[k]));
  ins(row());
  ins(row({ id: 'vc_2', scope: 'study', practice_day_id: null, video_key: '["b.mp4",123]' }));
  for (const bad of [
    row({ id: 'vc_3', scope: 'other' }),
    row({ id: 'vc_4', position_ms: -1 }),
    row({ id: 'vc_5', practice_day_id: null }), // practice なのに練習ID が無い
    row({ id: 'vc_6', scope: 'study' }), // study なのに練習ID がある
    row({ id: 'vc_7', org_id: null }),
    row({ id: 'vc_8', text: null }),
    row({ id: 'vc_1' }), // 主キーの重複
  ]) {
    assert.throws(() => ins(bad), /constraint|CHECK|NOT NULL|UNIQUE/i, JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM video_comments').get().c, 2);
  db.close();
});
