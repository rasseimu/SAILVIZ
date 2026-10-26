// server/repos/sessionsRepo.js
// 記録セッション(Phase 3。設計書 v2 §5.3・§7・§10.4)の DB 窓口。
// アプリが送ったチャンクを受け、finalize で 1 本の CSV にして軌跡にし、練習日の器(組織×日付／本人×日付)
// またはレース記録に紐付ける。軌跡は Web の CSV 取込(routes/compat.js の commit)と同じ形で作るので、
// 互換 API(/api/projects)からは従来の艇として見える。
import { randomBytes } from 'node:crypto';
import { parseSensorCsv, buildTrack, jstStamp } from '../sensorimport.js';
import { dayFor, jstDate } from './practiceDayFor.js';

const genId = (prefix) => `${prefix}_${randomBytes(5).toString('hex')}`;

// 練習日の器の決め方は practiceDayFor.js(アプリ向け API と共用)。jstDate は既存の import のため再 export する。
export { jstDate };

// チャンク(各々ヘッダ付きの完結した CSV。§7.4)を seq 順に 1 本へ連結する。ヘッダは先頭の 1 行だけ残す。
export function joinChunks(csvs) {
  let header = null;
  const out = [];
  for (const csv of csvs) {
    const lines = String(csv).split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) continue;
    if (header === null) {
      header = lines[0];
      out.push(...lines);
    } else {
      out.push(...(lines[0] === header ? lines.slice(1) : lines));
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

// 練習日の器に表示される軌跡(艇名・source)。艇番を直したときも同じ形に揃える。
const trackSource = (boatNo, csvName, sessionId, uploadedAt) => ({ sessionId, filename: csvName, boatNumber: boatNo, uploadedAt });

export function createSessionsRepo({ db }) {
  const q = {
    get: db.prepare('SELECT * FROM rec_sessions WHERE id = ?'),
    crew: db.prepare('SELECT role, user_id, name FROM session_crew WHERE session_id = ? ORDER BY position'),
    seqs: db.prepare('SELECT seq FROM chunks WHERE session_id = ? ORDER BY seq'),
    chunk: db.prepare('SELECT sha256 FROM chunks WHERE session_id = ? AND seq = ?'),
    chunkCsvs: db.prepare('SELECT csv FROM chunks WHERE session_id = ? ORDER BY seq'),
    track: db.prepare('SELECT * FROM tracks WHERE session_id = ?'),
    pd: db.prepare('SELECT * FROM practice_days WHERE id = ?'),
  };

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

  function replaceCrew(sessionId, crew) {
    db.prepare('DELETE FROM session_crew WHERE session_id = ?').run(sessionId);
    const ins = db.prepare('INSERT INTO session_crew (session_id, position, role, user_id, name) VALUES (?, ?, ?, ?, ?)');
    crew.forEach((c, i) => ins.run(sessionId, i, c.role ?? null, c.userId ?? null, c.name));
  }

  // レース記録(1 ユーザー 1 日 1 件。§5.4)。
  function raceRecordFor({ ownerUserId, firstPointMs, now }) {
    const date = jstDate(firstPointMs);
    const found = db.prepare('SELECT id FROM race_records WHERE owner_user_id = ? AND race_date = ?').get(ownerUserId, date);
    if (found) return found.id;
    const id = genId('rr');
    db.prepare('INSERT INTO race_records (id, owner_user_id, race_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerUserId, date, now, now);
    return id;
  }

  // 種別に応じて紐付け先を決め直す(finalize と種別の変更で使う。トランザクション内で呼ぶ)。
  function attach(s, now) {
    const tr = q.track.get(s.id);
    const firstPointMs = tr?.t_range ? JSON.parse(tr.t_range).start : s.started_ms;
    bumpDay(s.practice_day_id, now);
    if (s.kind === 'race') {
      const rr = raceRecordFor({ ownerUserId: s.owner_user_id, firstPointMs, now });
      db.prepare('UPDATE rec_sessions SET practice_day_id = NULL, race_record_id = ?, position = NULL WHERE id = ?').run(rr, s.id);
      return;
    }
    const pd = dayFor(db, { orgId: s.org_id, ownerUserId: s.owner_user_id, firstPointMs, now });
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rec_sessions WHERE practice_day_id = ?').get(pd.id).p;
    db.prepare('UPDATE rec_sessions SET practice_day_id = ?, race_record_id = NULL, position = ? WHERE id = ?').run(pd.id, pos, s.id);
    bumpDay(pd.id, now);
  }

  const attachedTo = (s) => {
    if (s.practice_day_id) return { type: 'practiceDay', id: s.practice_day_id };
    if (s.race_record_id) return { type: 'raceRecord', id: s.race_record_id };
    return null;
  };

  return {
    get: (id) => q.get.get(id) || null,
    crewOf: (id) => q.crew.all(id).map((c) => ({ role: c.role, userId: c.user_id ?? null, name: c.name })),
    receivedSeqs: (id) => q.seqs.all(id).map((r) => r.seq),
    chunkHash: (id, seq) => q.chunk.get(id, seq)?.sha256 ?? null,
    csvNameOf: (id) => q.track.get(id)?.csv_name ?? null,
    attachedTo,

    create({ id, ownerUserId, orgId, kind, boatNo, crew, visibility, startedMs, device, now }) {
      tx(() => {
        db.prepare(`INSERT INTO rec_sessions (id, owner_user_id, org_id, kind, boat_no, started_ms, status, visibility, device, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'receiving', ?, ?, ?)`)
          .run(id, ownerUserId, orgId ?? null, kind, boatNo, startedMs, visibility, device == null ? null : JSON.stringify(device), now);
        replaceCrew(id, crew);
      });
      return q.get.get(id);
    },

    // → 'stored' | 'duplicate' | 'conflict'
    putChunk({ sessionId, seq, csv, sha256, pointCount, now }) {
      const ex = q.chunk.get(sessionId, seq);
      if (ex) return ex.sha256 === sha256 ? 'duplicate' : 'conflict';
      db.prepare('INSERT INTO chunks (session_id, seq, sha256, point_count, csv, received_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, seq, sha256, pointCount, csv, now);
      return 'stored';
    },

    // 結合した CSV。チャンクが無ければ ''。
    joinedCsv: (id) => joinChunks(q.chunkCsvs.all(id).map((r) => r.csv)),

    // → { ok: true, result } | { ok: false, code, message }。二度目以降は保存済みの結果を返す。
    finalize({ id, endedMs, chunkCount, now }) {
      const s = q.get.get(id);
      if (s.status === 'finalized') return { ok: true, result: this.finalizedResult(s) };
      const seqs = q.seqs.all(id).map((r) => r.seq);
      const want = Array.from({ length: chunkCount }, (_, i) => i);
      if (chunkCount < 1 || seqs.length !== chunkCount || want.some((n, i) => seqs[i] !== n)) {
        const missing = want.filter((n) => !seqs.includes(n));
        return { ok: false, code: 'missing_chunks', message: `チャンクがそろっていません(欠番 ${missing.join(',') || 'なし'}・受信 ${seqs.length} 件)` };
      }
      let parsed;
      try { parsed = parseSensorCsv(this.joinedCsv(id)); } catch (e) {
        return { ok: false, code: 'invalid_csv', message: `GPS の CSV として読めません: ${e.message}` };
      }
      const csvName = `${s.boat_no}_${jstStamp(parsed.points[0].t)}.csv`;
      tx(() => {
        const source = trackSource(s.boat_no, csvName, id, now);
        const track = buildTrack({
          id, name: s.boat_no, points: parsed.points, bounds: parsed.bounds, colorIndex: 0,
          source, excludedIntervals: parsed.excludedIntervals,
        });
        db.prepare(`UPDATE rec_sessions SET status = 'finalized', ended_ms = ?, chunk_count = ?, point_count = ?,
                    source = ?, finalized_at = ? WHERE id = ?`)
          .run(endedMs, chunkCount, parsed.points.length, JSON.stringify(source), now, id);
        attach(q.get.get(id), now);
        // 色は器の中の軌跡の数で決める(Web の取込と同じく、既存の艇と重ならないように)。
        const pdId = q.get.get(id).practice_day_id;
        if (pdId) {
          const n = db.prepare('SELECT COUNT(*) AS n FROM tracks t JOIN rec_sessions rs ON rs.id = t.session_id WHERE rs.practice_day_id = ?').get(pdId).n;
          track.color = buildTrack({ id, name: '', points: [], bounds: null, colorIndex: n }).color;
        }
        const view = { ...track };
        delete view.points; delete view.bounds; delete view.tRange; delete view.source;
        db.prepare(`INSERT INTO tracks (session_id, points, bounds, t_range, point_count, csv_name, view)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, JSON.stringify(track.points), JSON.stringify(track.bounds), JSON.stringify(track.tRange),
            track.points.length, csvName, JSON.stringify(view));
      });
      return { ok: true, result: this.finalizedResult(q.get.get(id)) };
    },

    finalizedResult(s) {
      const tr = q.track.get(s.id);
      return {
        pointCount: s.point_count,
        bounds: tr?.bounds ? JSON.parse(tr.bounds) : null,
        csvName: tr?.csv_name ?? null,
        attachedTo: attachedTo(s),
      };
    },

    track(id) {
      const tr = q.track.get(id);
      if (!tr) return null;
      return {
        ...JSON.parse(tr.view || '{}'),
        points: JSON.parse(tr.points || '[]'),
        bounds: JSON.parse(tr.bounds || 'null'),
        tRange: JSON.parse(tr.t_range || 'null'),
      };
    },

    listByOwner: (userId) => db.prepare('SELECT * FROM rec_sessions WHERE owner_user_id = ? ORDER BY started_ms DESC, id').all(userId),
    listByCrew: (userId) => db.prepare(
      `SELECT DISTINCT rs.* FROM rec_sessions rs JOIN session_crew c ON c.session_id = rs.id
        WHERE c.user_id = ? AND (rs.owner_user_id IS NULL OR rs.owner_user_id <> ?) ORDER BY rs.started_ms DESC, rs.id`,
    ).all(userId, userId),

    // patch: { boatNo?, crew?, kind?, visibility? }(検証済み)。
    update(id, patch, now) {
      tx(() => {
        const s = q.get.get(id);
        if (patch.boatNo !== undefined && patch.boatNo !== s.boat_no) {
          db.prepare('UPDATE rec_sessions SET boat_no = ? WHERE id = ?').run(patch.boatNo, id);
          const tr = q.track.get(id);
          if (tr) {
            const view = JSON.parse(tr.view || '{}');
            if (view.name === s.boat_no) view.name = patch.boatNo;
            db.prepare('UPDATE tracks SET view = ? WHERE session_id = ?').run(JSON.stringify(view), id);
            const src = JSON.parse(s.source || 'null');
            if (src) db.prepare('UPDATE rec_sessions SET source = ? WHERE id = ?').run(JSON.stringify({ ...src, boatNumber: patch.boatNo }), id);
          }
        }
        if (patch.crew !== undefined) replaceCrew(id, patch.crew);
        if (patch.visibility !== undefined) db.prepare('UPDATE rec_sessions SET visibility = ? WHERE id = ?').run(patch.visibility, id);
        if (patch.kind !== undefined && patch.kind !== s.kind) {
          db.prepare('UPDATE rec_sessions SET kind = ? WHERE id = ?').run(patch.kind, id);
          if (patch.kind === 'race') db.prepare("UPDATE rec_sessions SET visibility = 'public' WHERE id = ?").run(id);
          if (s.status === 'finalized') attach(q.get.get(id), now);
        }
        bumpDay(q.get.get(id).practice_day_id, now);
      });
      return q.get.get(id);
    },

    remove(id, now) {
      tx(() => {
        const s = q.get.get(id);
        db.prepare('DELETE FROM chunks WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM tracks WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM session_crew WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM rec_sessions WHERE id = ?').run(id);
        bumpDay(s?.practice_day_id, now);
      });
    },
  };
}
