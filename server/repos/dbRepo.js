// server/repos/dbRepo.js
// 保存の窓口の DB 実装。fileRepo と同じインターフェースで node:sqlite を裏に持つ。
// 練習・反省・オーバーレイは DB、uploads(取込 CSV の一時置き)はファイルのまま委譲する
// (Phase 3 でセッション/チャンクに作り直す。Phase 1 では挙動を変えない)。
//
// 互換 PUT の削除ルール(設計書 §10.8 / §5 重要事項):
//  ② 互換 PUT では既存トラックを消さない(クライアントが知らない=後から届いた軌跡を守る)。
//  ③ 既存トラックの点列は書き換えず、表示設定(view: name/color/visible/windAxisOverrides)だけ反映。
//  新規トラック(incoming にあり DB に無い)は点列込みで追加。
//  反省は incoming で置き換える(Web の編集を尊重。_rev による追加保護は Web が _rev を送る Phase 6 で有効化)。
import { randomBytes } from 'node:crypto';
import { decomposeProject, assembleProject } from '../domain/projectRows.js';
import {
  decomposeProgress, assembleProgress, decomposeRoadmap, assembleRoadmap,
} from '../domain/overlayRows.js';
import { projectLabel } from '../../src/projectfs.js';
import { jstMidnightMs } from '../sensorimport.js';
import {
  saveUpload, readUpload, renameUpload,
} from '../storage.js';

function insertRow(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
}

const genId = (prefix) => `${prefix}_${randomBytes(5).toString('hex')}`;

export function createDbRepo({ db, dataDir }) {
  const getPd = db.prepare('SELECT * FROM practice_days WHERE legacy_name = ?');

  function loadParts(pd) {
    const sessions = db.prepare('SELECT * FROM rec_sessions WHERE practice_day_id = ?').all(pd.id);
    const ids = sessions.map((s) => s.id);
    const tracks = ids.length
      ? db.prepare(`SELECT * FROM tracks WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    const reflections = db.prepare('SELECT * FROM reflections WHERE practice_day_id = ?').all(pd.id);
    return { practiceDay: pd, sessions, tracks, reflections };
  }

  function insertAll(rows) {
    insertRow(db, 'practice_days', rows.practiceDay);
    for (const s of rows.sessions) insertRow(db, 'rec_sessions', s);
    for (const t of rows.tracks) insertRow(db, 'tracks', t);
    for (const r of rows.reflections) insertRow(db, 'reflections', r);
  }

  return {
    listProjects() {
      return db.prepare('SELECT legacy_name FROM practice_days WHERE legacy_name IS NOT NULL ORDER BY legacy_name DESC')
        .all()
        .map((r) => ({ name: r.legacy_name, label: projectLabel(r.legacy_name) }));
    },

    readProject(name) {
      const pd = getPd.get(name);
      if (!pd) throw new Error('not found');
      const assembled = assembleProject(loadParts(pd));
      return { ...assembled, _rev: pd.rev };
    },

    writeProject(name, obj) {
      const incoming = { ...obj };
      delete incoming._rev; // メタは保存しない
      const now = Date.now();
      const existing = getPd.get(name);
      db.exec('BEGIN');
      try {
        if (!existing) {
          const rows = decomposeProject(incoming, { legacyName: name, pdId: genId('pd'), now });
          rows.practiceDay.rev = 1;
          insertAll(rows);
        } else {
          const pdId = existing.id;
          const decomp = decomposeProject(incoming, { legacyName: name, pdId, now });
          // practice_day メタ
          db.prepare('UPDATE practice_days SET web_state = ?, saved_at = ?, date = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
            .run(decomp.practiceDay.web_state, decomp.practiceDay.saved_at, decomp.practiceDay.date, now, pdId);
          // トラック(②③)
          const existingTrackIds = new Set(
            db.prepare('SELECT id FROM rec_sessions WHERE practice_day_id = ?').all(pdId).map((r) => r.id),
          );
          const tById = new Map(decomp.tracks.map((t) => [t.session_id, t]));
          const sById = new Map(decomp.sessions.map((s) => [s.id, s]));
          decomp.sessions.forEach((s) => {
            if (existingTrackIds.has(s.id)) {
              // ③ 点列は書き換えず view(表示設定)のみ。position は配列順に追従。
              db.prepare('UPDATE tracks SET view = ? WHERE session_id = ?').run(tById.get(s.id).view, s.id);
              db.prepare('UPDATE rec_sessions SET position = ? WHERE id = ?').run(s.position, s.id);
            } else {
              insertRow(db, 'rec_sessions', s);
              insertRow(db, 'tracks', tById.get(s.id));
            }
          });
          // ② incoming に無い既存トラックは残す(何もしない)
          // 反省: incoming で置き換え
          const incomingReflIds = new Set(decomp.reflections.map((r) => r.id));
          for (const ex of db.prepare('SELECT id FROM reflections WHERE practice_day_id = ?').all(pdId)) {
            if (!incomingReflIds.has(ex.id)) db.prepare('DELETE FROM reflections WHERE id = ?').run(ex.id);
          }
          for (const r of decomp.reflections) {
            db.prepare('DELETE FROM reflections WHERE id = ?').run(r.id);
            insertRow(db, 'reflections', r);
          }
          void sById;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    deleteProject(name) {
      const pd = getPd.get(name);
      if (!pd) return;
      db.exec('BEGIN');
      try {
        const sessIds = db.prepare('SELECT id FROM rec_sessions WHERE practice_day_id = ?').all(pd.id).map((r) => r.id);
        for (const sid of sessIds) db.prepare('DELETE FROM tracks WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM rec_sessions WHERE practice_day_id = ?').run(pd.id);
        db.prepare('DELETE FROM reflections WHERE practice_day_id = ?').run(pd.id);
        db.prepare('DELETE FROM practice_days WHERE id = ?').run(pd.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    readOverlay(name) {
      if (name === 'progress') {
        return assembleProgress({
          progress: db.prepare('SELECT * FROM reflection_progress').all(),
          comments: db.prepare('SELECT * FROM reflection_comments').all(),
        });
      }
      if (name === 'roadmap') {
        return assembleRoadmap({ roadmaps: db.prepare('SELECT * FROM roadmaps').all() });
      }
      return {};
    },

    writeOverlay(name, obj) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        if (name === 'progress') {
          db.exec('DELETE FROM reflection_comments; DELETE FROM reflection_progress;');
          const { progress, comments } = decomposeProgress(obj, { now });
          for (const r of progress) insertRow(db, 'reflection_progress', r);
          for (const c of comments) insertRow(db, 'reflection_comments', c);
        } else if (name === 'roadmap') {
          db.exec('DELETE FROM roadmaps;');
          const { roadmaps } = decomposeRoadmap(obj, { now });
          for (const r of roadmaps) insertRow(db, 'roadmaps', r);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // uploads はファイルに委譲(Phase 1 では挙動不変)。
    saveUpload: (importId, filename, text) => saveUpload(dataDir, importId, filename, text),
    readUpload: (importId, filename) => readUpload(dataDir, importId, filename),
    renameUpload: (importId, from, to) => renameUpload(dataDir, importId, from, to),

    // fileRepo と同じ: person=people[0] かつ proj.practiceDate 完全一致の器を探す。
    findReflectionByDate(person, practiceDate) {
      const rows = db.prepare(
        `SELECT pd.legacy_name AS name
           FROM reflections r JOIN practice_days pd ON pd.id = r.practice_day_id
          WHERE r.legacy_author_name = ?
            AND json_extract(pd.web_state, '$.practiceDate') = ?
          LIMIT 1`,
      ).all(person, practiceDate);
      if (!rows.length) return null;
      return { name: rows[0].name, label: projectLabel(rows[0].name) };
    },

    // fileRepo と同じ: practiceDate を持つ器のうち JST 日が一致する最初のものを返す(降順)。
    findProjectByPracticeDate(practiceDate) {
      const target = jstMidnightMs(Number(practiceDate));
      const rows = db.prepare(
        `SELECT legacy_name AS name, json_extract(web_state, '$.practiceDate') AS pdate
           FROM practice_days WHERE legacy_name IS NOT NULL ORDER BY legacy_name DESC`,
      ).all();
      for (const r of rows) {
        const pd = Number(r.pdate);
        if (!Number.isFinite(pd)) continue;
        if (jstMidnightMs(pd) === target) return { name: r.name, label: projectLabel(r.name) };
      }
      return null;
    },
  };
}
