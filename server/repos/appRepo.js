// server/repos/appRepo.js
// アプリ向け API(Phase 4。設計書 §4)の DB 窓口。まずは反省(reflections)。
// 1 行 = 反省 1 件。行の id は合成 ID、利用者が知る反省 ID(refl…)は body(JSON)の id にある。
// body には反省オブジェクトをそのまま入れる(互換 API が body を Web へ返すので、Web とアプリで同じ内容に見える)。
import { randomBytes } from 'node:crypto';
import { dayFor } from './practiceDayFor.js';

export function createAppRepo({ db }) {
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const bumpDay = (pdId, now) => {
    if (pdId) db.prepare('UPDATE practice_days SET rev = rev + 1, updated_at = ? WHERE id = ?').run(now, pdId);
  };
  const parse = (row) => {
    try { return JSON.parse(row.body) ?? {}; } catch { return {}; }
  };

  const findReflectionRows = (reflId) => db.prepare("SELECT * FROM reflections WHERE json_extract(body, '$.id') = ?").all(reflId);

  // 反省 1 行の認可対象(policy.js 用)。
  const reflectionTarget = (row) => ({
    kind: 'reflection',
    visibility: row.visibility,
    ownerId: row.author_user_id ?? null,
    orgId: db.prepare('SELECT org_id FROM practice_days WHERE id = ?').get(row.practice_day_id)?.org_id ?? null,
  });

  const reflectionJson = (row) => ({ ...parse(row), visibility: row.visibility, practiceDayId: row.practice_day_id });

  function upsertMyReflection({ reflId, userId, orgId, body, visibility, legacyAuthorName, firstPointMs, now }) {
    return tx(() => {
      const rows = findReflectionRows(reflId);
      const mine = rows.find((r) => r.author_user_id === userId);
      if (rows.length && !mine) return { ok: false, code: 'conflict' };
      const day = dayFor(db, { orgId, ownerUserId: userId, firstPointMs, now });
      const json = JSON.stringify(body);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
      if (mine) {
        if (mine.practice_day_id === day.id) {
          db.prepare('UPDATE reflections SET body = ?, visibility = ?, session_id = ?, legacy_author_name = ?, updated_at = ? WHERE id = ?')
            .run(json, visibility, sessionId, legacyAuthorName, now, mine.id);
        } else {
          const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM reflections WHERE practice_day_id = ?').get(day.id).p;
          db.prepare('UPDATE reflections SET practice_day_id = ?, position = ?, body = ?, visibility = ?, session_id = ?, legacy_author_name = ?, updated_at = ? WHERE id = ?')
            .run(day.id, pos, json, visibility, sessionId, legacyAuthorName, now, mine.id);
          bumpDay(mine.practice_day_id, now);
        }
      } else {
        const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM reflections WHERE practice_day_id = ?').get(day.id).p;
        db.prepare(`INSERT INTO reflections (id, practice_day_id, position, author_user_id, legacy_author_name, session_id, voice_id, visibility, body, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
          .run(`${day.id}_r_${randomBytes(4).toString('hex')}`, day.id, pos, userId, legacyAuthorName, sessionId, visibility, json, now, now);
      }
      bumpDay(day.id, now);
      return { ok: true, practiceDayId: day.id };
    });
  }

  function listMyReflections(userId, limit) {
    return db.prepare("SELECT * FROM reflections WHERE author_user_id = ? ORDER BY COALESCE(json_extract(body, '$.createdAt'), created_at) DESC, id LIMIT ?")
      .all(userId, limit).map(reflectionJson);
  }

  function deleteMyReflection(reflId, userId, now) {
    return tx(() => {
      const rows = findReflectionRows(reflId);
      const mine = rows.filter((r) => r.author_user_id === userId);
      if (!mine.length) return false;
      for (const r of mine) {
        db.prepare('DELETE FROM reflections WHERE id = ?').run(r.id);
        bumpDay(r.practice_day_id, now);
      }
      // 同じ反省 ID の別の行(旧データの重複)が残るなら、進捗・コメントは消さない。
      if (rows.length === mine.length) {
        db.prepare('DELETE FROM reflection_progress WHERE reflection_id = ?').run(reflId);
        db.prepare('DELETE FROM reflection_comments WHERE reflection_id = ?').run(reflId);
      }
      return true;
    });
  }

  // 自分のロードマップ(roadmaps は user_id UNIQUE。無ければ空)。
  function getMyRoadmap(userId) {
    const row = db.prepare('SELECT goal, milestones FROM roadmaps WHERE user_id = ?').get(userId);
    if (!row) return { goal: '', milestones: [] };
    let milestones = [];
    try { const v = JSON.parse(row.milestones); if (Array.isArray(v)) milestones = v; } catch { /* 壊れた JSON は空 */ }
    return { goal: row.goal ?? '', milestones };
  }

  // 行があれば goal・milestones・updated_at だけ更新(legacy_name・org_id・extra は付け替え済みの値を保つ)。
  function putMyRoadmap({ userId, orgId, legacyName, goal, milestones, now }) {
    return tx(() => {
      const json = JSON.stringify(milestones);
      const row = db.prepare('SELECT id FROM roadmaps WHERE user_id = ?').get(userId);
      if (row) {
        db.prepare('UPDATE roadmaps SET goal = ?, milestones = ?, updated_at = ? WHERE id = ?').run(goal, json, now, row.id);
      } else {
        db.prepare('INSERT INTO roadmaps (id, user_id, org_id, legacy_name, goal, milestones, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
          .run(`rm_${randomBytes(6).toString('hex')}`, userId, orgId ?? null, legacyName, goal, json, now);
      }
      return { goal, milestones };
    });
  }

  return { getMyRoadmap, putMyRoadmap, findReflectionRows, upsertMyReflection, listMyReflections, deleteMyReflection, reflectionTarget, reflectionJson };
}
