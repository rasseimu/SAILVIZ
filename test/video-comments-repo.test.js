// test/video-comments-repo.test.js — 動画の瞬間コメントの DB 窓口(videoCommentsRepo)。node:sqlite が要る。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';
const MIG_DIR = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));

let openDb, migrate, loadMigrations, createVideoCommentsRepo;
if (hasSqlite) {
  ({ openDb } = await import('../server/db/connection.js'));
  ({ migrate, loadMigrations } = await import('../server/db/migrate.js'));
  ({ createVideoCommentsRepo } = await import('../server/repos/videoCommentsRepo.js'));
}

const fresh = () => {
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR), 1);
  return { db, repo: createVideoCommentsRepo({ db }) };
};
const base = { orgId: 'o_a', scope: 'practice', practiceDayId: 'pd_0000000001', videoKey: '["a.mp4",1]', videoName: 'a.mp4', authorUserId: 'u1' };

test('insert → get / listByPracticeDay(位置 → 作成時刻 → id 順)', { skip: skipMsg }, () => {
  const { db, repo } = fresh();
  const c1 = repo.insert({ ...base, positionMs: 5000, text: 'b', now: 10 });
  const c2 = repo.insert({ ...base, positionMs: 1000, text: 'a', now: 20 });
  const c3 = repo.insert({ ...base, positionMs: 5000, text: 'c', now: 5 });
  repo.insert({ ...base, practiceDayId: 'pd_0000000002', positionMs: 0, text: '別の練習', now: 1 });
  repo.insert({ ...base, scope: 'study', practiceDayId: null, positionMs: 0, text: '勉強', now: 1 });
  assert.match(c1.id, /^vc_[0-9a-f]{24}$/);
  assert.deepEqual(c1, {
    id: c1.id, orgId: 'o_a', scope: 'practice', practiceDayId: 'pd_0000000001', videoKey: '["a.mp4",1]', videoName: 'a.mp4',
    positionMs: 5000, text: 'b', authorUserId: 'u1', createdAt: 10, updatedAt: 10,
  });
  assert.deepEqual(repo.listByPracticeDay('pd_0000000001').map((c) => c.id), [c2.id, c3.id, c1.id]);
  assert.equal(repo.get('vc_none'), null);
  db.close();
});

test('updateText は本文と updated_at だけ変える。remove は消せたら true', { skip: skipMsg }, () => {
  const { db, repo } = fresh();
  const c = repo.insert({ ...base, positionMs: 0, text: 'a', now: 10 });
  const u = repo.updateText(c.id, '直した', 30);
  assert.deepEqual(u, { ...c, text: '直した', updatedAt: 30 });
  assert.equal(repo.updateText('vc_none', 'x', 1), null);
  assert.equal(repo.remove(c.id), true);
  assert.equal(repo.remove(c.id), false);
  assert.equal(repo.get(c.id), null);
  db.close();
});

test('listStudy: 組織の study だけを動画キー → 位置 → 作成時刻 → id の順に、上限件数まで', { skip: skipMsg }, () => {
  const { db, repo } = fresh();
  const study = { ...base, scope: 'study', practiceDayId: null };
  const b2 = repo.insert({ ...study, videoKey: '["clip02.mp4",20]', videoName: 'clip02.mp4', positionMs: 0, text: 'b2', now: 1 });
  const a5 = repo.insert({ ...study, videoKey: '["clip01.mp4",10]', videoName: 'clip01.mp4', positionMs: 5000, text: 'a5', now: 1 });
  const a1 = repo.insert({ ...study, videoKey: '["clip01.mp4",10]', videoName: 'clip01.mp4', positionMs: 1000, text: 'a1', now: 9 });
  repo.insert({ ...study, orgId: 'o_b', videoKey: '["clip01.mp4",10]', videoName: 'clip01.mp4', positionMs: 0, text: '他組織', now: 1 });
  repo.insert({ ...base, positionMs: 0, text: '練習', now: 1 }); // 同じ組織の練習のコメントは混ざらない
  assert.deepEqual(repo.listStudy('o_a').map((c) => c.id), [a1.id, a5.id, b2.id]);
  assert.deepEqual(repo.listStudy('o_a', 2).map((c) => c.id), [a1.id, a5.id]);
  assert.equal(repo.listStudy('o_a')[0].practiceDayId, null);
  assert.deepEqual(repo.listStudy('o_none'), []);
  db.close();
});
