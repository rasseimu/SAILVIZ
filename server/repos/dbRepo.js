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

// INSERT ... ON CONFLICT(pk) DO UPDATE。既存行を作り直さない(rowid を保つ)。
function upsertRow(db, table, row, pk) {
  const keys = Object.keys(row);
  const sets = keys.filter((k) => k !== pk).map((k) => `${k} = excluded.${k}`).join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    + ` ON CONFLICT(${pk}) DO UPDATE SET ${sets}`;
  db.prepare(sql).run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
}

const genId = (prefix) => `${prefix}_${randomBytes(5).toString('hex')}`;

// 点列の指紋。別艇の GPS 軌跡は点数と端点が異なるので同定に十分。
// 互換 PUT で incoming トラックを既存 DB トラックに対応づけるのに使う(id が一意でないため)。
function trackFingerprint(points) {
  const a = Array.isArray(points) ? points : [];
  if (!a.length) return 'empty';
  const f = a[0]; const l = a[a.length - 1];
  return `${a.length}|${f.t},${f.lat},${f.lon}|${l.t},${l.lat},${l.lon}`;
}

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
          // トラック(②③): 旧データは track.id が一意でない(全艇 'Location.csv')ため、
          // index でも id でも同定できない。点列の指紋(fingerprint)で incoming↔既存 を対応づける。
          // これで並べ替え・中抜き削除でも「表示設定だけ反映・点列は不変」を正しく保てる。
          const existingTracks = db.prepare(
            `SELECT rs.id AS sid, t.points AS points FROM rec_sessions rs
               JOIN tracks t ON t.session_id = rs.id WHERE rs.practice_day_id = ?`,
          ).all(pdId);
          const fpQueue = new Map(); // fingerprint -> [sessionId,...](同指紋は順に消費)
          for (const et of existingTracks) {
            const key = trackFingerprint(JSON.parse(et.points || 'null'));
            if (!fpQueue.has(key)) fpQueue.set(key, []);
            fpQueue.get(key).push(et.sid);
          }
          const incomingTracks = Array.isArray(incoming.tracks) ? incoming.tracks : [];
          incomingTracks.forEach((t, i) => {
            const key = trackFingerprint(t.points);
            const q = fpQueue.get(key);
            const matchId = q && q.length ? q.shift() : null;
            if (matchId) {
              // ③ 点列は書き換えず view(表示設定)だけ反映。position は配列順。
              db.prepare('UPDATE tracks SET view = ? WHERE session_id = ?').run(decomp.tracks[i].view, matchId);
              db.prepare('UPDATE rec_sessions SET position = ? WHERE id = ?').run(i, matchId);
            } else {
              // 新規トラック: 既存 ID と衝突しない一意 ID で点列込み挿入。
              const newId = `${pdId}_t_${randomBytes(4).toString('hex')}`;
              insertRow(db, 'rec_sessions', { ...decomp.sessions[i], id: newId });
              insertRow(db, 'tracks', { ...decomp.tracks[i], session_id: newId });
            }
          });
          // ② incoming に無い既存トラックは残す(何もしない)
          // 反省: incoming で置き換え
          const incomingReflIds = new Set(decomp.reflections.map((r) => r.id));
          for (const ex of db.prepare('SELECT id FROM reflections WHERE practice_day_id = ?').all(pdId)) {
            if (!incomingReflIds.has(ex.id)) db.prepare('DELETE FROM reflections WHERE id = ?').run(ex.id);
          }
          for (const r of decomp.reflections) {
            upsertRow(db, 'reflections', r, 'id');
          }
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
