// server/repos/videoCommentsRepo.js
// 動画の瞬間コメント(video_comments。009)の DB 窓口。②練習動画(scope 'practice')と③勉強動画(scope 'study')で共用。
// 認可は呼び出し側(routes/videoComments.js + domain/videoComments.js)。ここは読み書きだけ。
// 返す形は { id, orgId, scope, practiceDayId, videoKey, videoName, positionMs, text, authorUserId, createdAt, updatedAt }。
import { randomBytes } from 'node:crypto';

const genId = () => `vc_${randomBytes(12).toString('hex')}`;

const rowOf = (r) => (r ? {
  id: r.id,
  orgId: r.org_id,
  scope: r.scope,
  practiceDayId: r.practice_day_id ?? null,
  videoKey: r.video_key,
  videoName: r.video_name,
  positionMs: Number(r.position_ms),
  text: r.text,
  authorUserId: r.author_user_id,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
} : null);

export function createVideoCommentsRepo({ db }) {
  const q = {
    byDay: db.prepare(`SELECT * FROM video_comments WHERE practice_day_id = ? AND scope = 'practice'
      ORDER BY position_ms, created_at, id`),
    studyByOrg: db.prepare(`SELECT * FROM video_comments WHERE org_id = ? AND scope = 'study'
      ORDER BY video_key, position_ms, created_at, id LIMIT ?`),
    get: db.prepare('SELECT * FROM video_comments WHERE id = ?'),
    insert: db.prepare(`INSERT INTO video_comments
      (id, org_id, scope, practice_day_id, video_key, video_name, position_ms, text, author_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateText: db.prepare('UPDATE video_comments SET text = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM video_comments WHERE id = ?'),
  };

  return {
    // 練習のコメント全件(全動画ぶん)。位置 → 作成時刻 → id の順。
    listByPracticeDay(practiceDayId) {
      return q.byDay.all(practiceDayId).map(rowOf);
    },
    // 組織の勉強動画(scope 'study')のコメント全件(最大 limit 件)。動画キー → 位置 → 作成時刻 → id の順。
    listStudy(orgId, limit = 5000) {
      return q.studyByOrg.all(orgId, limit).map(rowOf);
    },
    get(id) {
      return rowOf(q.get.get(id));
    },
    // 新しいコメントを入れて、入れた行を返す。scope 'practice' は practiceDayId が要る、'study' は null(表の CHECK)。
    insert({ orgId, scope, practiceDayId = null, videoKey, videoName, positionMs, text, authorUserId, now }) {
      const id = genId();
      q.insert.run(id, orgId, scope, practiceDayId, videoKey, videoName, positionMs, text, authorUserId, now, now);
      return this.get(id);
    },
    // 本文だけ書き換えて、更新後の行を返す。無ければ null。
    updateText(id, text, now) {
      const r = q.updateText.run(text, now, id);
      return Number(r.changes) ? this.get(id) : null;
    },
    // 消せたら true。
    remove(id) {
      return Number(q.remove.run(id).changes) > 0;
    },
  };
}
