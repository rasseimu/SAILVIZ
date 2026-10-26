// server/repos/appRepo.js
// アプリ向け API(Phase 4。設計書 §4・§6・§7)の DB 窓口。反省(reflections)と、その進捗・コメント、練習日の器。
// 1 行 = 反省 1 件。行の id は合成 ID、利用者が知る反省 ID(refl…)は body(JSON)の id にある。
// body には反省オブジェクトをそのまま入れる(互換 API が body を Web へ返すので、Web とアプリで同じ内容に見える)。
import { randomBytes } from 'node:crypto';
import { dayFor } from './practiceDayFor.js';
import { canRead } from '../domain/policy.js';

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

  // ---- 進捗とコメント(設計書 §6)。reflection_progress / reflection_comments の reflection_id は反省 ID(body.id)。----
  // 同じ反省 ID の行のうち、主体が読める最初の行とその認可対象。読めなければ null。
  function readableReflection(subject, reflId) {
    for (const row of findReflectionRows(reflId)) {
      const target = reflectionTarget(row);
      if (canRead(subject, target)) return { row, target };
    }
    return null;
  }

  const progressJson = (row) => {
    let text = null;
    if (row?.text != null) { try { text = JSON.parse(row.text); } catch { /* 壊れた JSON は null */ } }
    return { issueStage: row?.issue_stage ?? null, goalDone: !!row?.goal_done, text };
  };
  const getProgress = (reflId) => progressJson(db.prepare('SELECT * FROM reflection_progress WHERE reflection_id = ?').get(reflId));

  // 渡したキーだけ更新する(extra=互換の未マップキーは保つ)。行が無ければ作る。
  function putProgress(reflId, patch, now) {
    return tx(() => {
      const row = db.prepare('SELECT * FROM reflection_progress WHERE reflection_id = ?').get(reflId);
      const next = {
        issue_stage: 'issueStage' in patch ? patch.issueStage : (row?.issue_stage ?? null),
        goal_done: 'goalDone' in patch ? (patch.goalDone ? 1 : 0) : (row?.goal_done ?? null),
        text: 'text' in patch ? JSON.stringify(patch.text) : (row?.text ?? null),
      };
      if (row) {
        db.prepare('UPDATE reflection_progress SET issue_stage = ?, goal_done = ?, text = ?, updated_at = ? WHERE reflection_id = ?')
          .run(next.issue_stage, next.goal_done, next.text, now, reflId);
      } else {
        db.prepare('INSERT INTO reflection_progress (reflection_id, issue_stage, goal_done, text, extra, updated_at) VALUES (?, ?, ?, ?, NULL, ?)')
          .run(reflId, next.issue_stage, next.goal_done, next.text, now);
      }
      return getProgress(reflId);
    });
  }

  const commentJson = (r) => ({ id: r.id, field: r.field, text: r.text, ts: r.ts, authorUserId: r.author_user_id ?? null });
  const listComments = (reflId) => db.prepare('SELECT * FROM reflection_comments WHERE reflection_id = ? ORDER BY ts, id')
    .all(reflId).map(commentJson);

  // id は互換 API と同じ <反省ID>#<field>#<n>(n はその field の既存件数。互換の保存は 0 から振り直す)。
  // extra に authorUserId を入れて、互換の readOverlay / writeOverlay(decomposeProgress)と往復させる。
  // 互換の進捗は進捗行のある反省のコメントしか返さないので、進捗行が無ければ空の行も作る。
  // extra の authorUserId・author(名前)・via は、互換の進捗(assembleProgress)でコメントのキーに戻る。
  // via: 'api' は「新 API で足した」目印(compatAccess.keepNewApiComments)。
  function addComment({ reflId, field, text, authorUserId, author = null, ts }) {
    return tx(() => {
      let n = db.prepare('SELECT COUNT(*) AS c FROM reflection_comments WHERE reflection_id = ? AND field = ?').get(reflId, field).c;
      const taken = db.prepare('SELECT 1 FROM reflection_comments WHERE id = ?');
      while (taken.get(`${reflId}#${field}#${n}`)) n += 1; // 番号が飛んだ旧データでも id を重ねない
      const id = `${reflId}#${field}#${n}`;
      const extra = JSON.stringify({ ...(authorUserId != null ? { authorUserId } : {}), ...(author ? { author } : {}), via: 'api' });
      db.prepare('INSERT INTO reflection_comments (id, reflection_id, field, text, ts, author_user_id, extra) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, reflId, field, text, ts, authorUserId ?? null, extra);
      db.prepare('INSERT OR IGNORE INTO reflection_progress (reflection_id, issue_stage, goal_done, text, extra, updated_at) VALUES (?, NULL, NULL, NULL, NULL, ?)')
        .run(reflId, ts);
      return { id, field, text, ts, authorUserId: authorUserId ?? null };
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

  // ---- 練習日(設計書 §7)。見える中身の絞り込みは route(policy.js)で行う。ここは候補だけ返す。----
  // mine:   自分のセッション・自分が乗員のセッション・自分の反省のどれかがある器と、owner_user_id = 自分の器
  // org:    org_id = orgId の器
  // public: public のセッションか反省がある器
  // 並びは date の新しい順(同じ日は作成の新しい順)。不明な scope は空。
  function listDays({ scope, userId = null, orgId = null }) {
    const order = 'ORDER BY date DESC, created_at DESC, id';
    if (scope === 'mine') {
      return db.prepare(`SELECT * FROM practice_days
        WHERE owner_user_id = ?1
           OR id IN (SELECT practice_day_id FROM rec_sessions WHERE owner_user_id = ?1)
           OR id IN (SELECT rs.practice_day_id FROM rec_sessions rs JOIN session_crew c ON c.session_id = rs.id WHERE c.user_id = ?1)
           OR id IN (SELECT practice_day_id FROM reflections WHERE author_user_id = ?1)
        ${order}`).all(userId);
    }
    if (scope === 'org') return db.prepare(`SELECT * FROM practice_days WHERE org_id = ? ${order}`).all(orgId);
    if (scope === 'public') {
      return db.prepare(`SELECT * FROM practice_days
        WHERE id IN (SELECT practice_day_id FROM rec_sessions WHERE visibility = 'public')
           OR id IN (SELECT practice_day_id FROM reflections WHERE visibility = 'public')
        ${order}`).all();
    }
    return [];
  }

  // 器 1 つと、その中のセッション・反省の行(位置順)。器が無ければ null。
  function dayParts(pdId) {
    const day = db.prepare('SELECT * FROM practice_days WHERE id = ?').get(pdId);
    if (!day) return null;
    return {
      day,
      sessions: db.prepare('SELECT * FROM rec_sessions WHERE practice_day_id = ? ORDER BY position, id').all(pdId),
      reflections: db.prepare('SELECT * FROM reflections WHERE practice_day_id = ? ORDER BY position, id').all(pdId),
    };
  }

  // web_state に送られたキーだけを上書きし(上の階層の浅いマージ)、rev を上げる。送らないキー
  // (version・savedAt・practiceDate など。互換 API の練習日検索や assembleProject が使う)は残す。
  // tracks・reflections は別の表が正本なので web_state に入れない(decomposeProject と同じ。送られても無視)。
  // saved_at 列は dbRepo.writeProject と同じく web_state.savedAt に揃える。器が無ければ null。
  function patchDayWebState(pdId, webState, now) {
    return tx(() => {
      const row = db.prepare('SELECT web_state FROM practice_days WHERE id = ?').get(pdId);
      if (!row) return null;
      let cur = {};
      try { const v = JSON.parse(row.web_state); if (v && typeof v === 'object' && !Array.isArray(v)) cur = v; } catch { /* 壊れた JSON は空から */ }
      const ws = { ...cur, ...webState };
      delete ws.tracks;
      delete ws.reflections;
      db.prepare('UPDATE practice_days SET web_state = ?, saved_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(ws), ws.savedAt ?? null, now, pdId);
      return db.prepare('SELECT * FROM practice_days WHERE id = ?').get(pdId);
    });
  }

  // レース記録の一覧(race_date の新しい順)。ownerUserId を渡せばその人のだけ。sessionCount はひも付くセッション数。
  function listRaceRecords({ ownerUserId } = {}) {
    const rows = db.prepare(`SELECT r.id, r.owner_user_id, r.race_date, r.title, r.venue,
        (SELECT COUNT(*) FROM rec_sessions s WHERE s.race_record_id = r.id) AS n
      FROM race_records r ${ownerUserId ? 'WHERE r.owner_user_id = ?' : ''}
      ORDER BY r.race_date DESC, r.id`).all(...(ownerUserId ? [ownerUserId] : []));
    return rows.map((r) => ({ id: r.id, ownerUserId: r.owner_user_id ?? null, raceDate: r.race_date, title: r.title ?? null, venue: r.venue ?? null, sessionCount: r.n }));
  }

  // レース記録 1 件とそのセッション行(開始の古い順)。無ければ null。
  function raceRecordWithSessions(id) {
    const rr = db.prepare('SELECT * FROM race_records WHERE id = ?').get(id);
    if (!rr) return null;
    return { raceRecord: rr, sessions: db.prepare('SELECT * FROM rec_sessions WHERE race_record_id = ? ORDER BY started_ms, id').all(id) };
  }

  return { listRaceRecords, raceRecordWithSessions, listDays, dayParts, patchDayWebState, getMyRoadmap, putMyRoadmap, findReflectionRows, upsertMyReflection, listMyReflections, deleteMyReflection, reflectionTarget, reflectionJson,
    readableReflection, getProgress, putProgress, listComments, addComment };
}
