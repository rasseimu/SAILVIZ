// server/repos/dbRepo.js
// 保存の窓口の DB 実装。fileRepo と同じインターフェースで node:sqlite を裏に持つ。
// 練習・反省・オーバーレイは DB、uploads(取込 CSV の一時置き)はファイルのまま委譲する
// (Phase 3 でセッション/チャンクに作り直す。Phase 1 では挙動を変えない)。
//
// 互換 PUT の削除ルール(設計書 §10.8 / §5 重要事項):
//  ② 互換 PUT では既存トラックを消さない(クライアントが知らない=後から届いた軌跡を守る)。
//  ③ 既存トラックの点列は書き換えず、表示設定(view: name/color/visible/windAxisOverrides)だけ反映。
//  新規トラック(incoming にあり DB に無い)は点列込みで追加。
//  反省は incoming で置き換える(Web の編集を尊重)。ただし incoming._rev が今の rev と一致しないとき
//  (Web が古い画面のまま保存したとき)は、incoming に無い「アプリ/音声から送った反省」
//  (author_user_id があり body.origin が app/voice)を消さない。Web で作った反省(作者なし)は今までどおり消せる。
//  また、この日の行と突き合わない incoming のうち本文に authorUserId がある反省は新しい行にしない
//  (Web の createReflection は authorUserId を付けないので、それはアプリの反省を Web が読み返しただけ。
//  アプリが消したか別の日へ移した反省を、作者なし・組織公開で戻さない。互換経路で作者を偽らせない)。
import { randomBytes } from 'node:crypto';
import { decomposeProject, assembleProject, orderParts } from '../domain/projectRows.js';
import {
  decomposeProgress, assembleProgress, decomposeRoadmap, assembleRoadmap,
} from '../domain/overlayRows.js';
import { syncRoadmaps } from '../db/roadmapSync.js';
import { projectLabel } from '../../src/projectfs.js';
import { jstMidnightMs } from '../sensorimport.js';
import { appendVideos } from '../../src/videolink.js';
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

// 反省行の本文(旧 JSON)から反省 ID を取り出す。無ければ null。
function bodyId(row) {
  try {
    const id = JSON.parse(row.body)?.id;
    return id == null ? null : String(id);
  } catch { return null; }
}

// 反省行の本文に作者(authorUserId)があるか。アプリ/音声から送った反省の本文にだけ付く。
function bodyHasAuthor(row) {
  try { return JSON.parse(row.body)?.authorUserId != null; } catch { return false; }
}

// 点列の指紋。別艇の GPS 軌跡は点数と端点が異なるので同定に十分。
// 互換 PUT で incoming トラックを既存 DB トラックに対応づけるのに使う(id が一意でないため)。
function trackFingerprint(points) {
  const a = Array.isArray(points) ? points : [];
  if (!a.length) return 'empty';
  const f = a[0]; const l = a[a.length - 1];
  return `${a.length}|${f.t},${f.lat},${f.lon}|${l.t},${l.lat},${l.lon}`;
}

export function createDbRepo({ db, dataDir }) {
  // 練習は ID(practice_days.id)で引く。名前(legacy_name)は表示用で重複してよい(設計書 §5.5.1)。
  const getPd = db.prepare('SELECT * FROM practice_days WHERE id = ?');
  const item = (r) => ({ id: r.id, name: r.name, label: projectLabel(r.name) });

  // points: false なら軌跡の点列(tracks.points。練習の大半の容量)を読まない(一覧の要約用)。
  function loadParts(pd, { points = true } = {}) {
    const sessions = db.prepare('SELECT * FROM rec_sessions WHERE practice_day_id = ?').all(pd.id);
    const ids = sessions.map((s) => s.id);
    const cols = points ? '*' : 'session_id, bounds, t_range, point_count, csv_name, view';
    const tracks = ids.length
      ? db.prepare(`SELECT ${cols} FROM tracks WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    const reflections = db.prepare('SELECT * FROM reflections WHERE practice_day_id = ?').all(pd.id);
    return { practiceDay: pd, sessions, tracks, reflections };
  }

  // loadParts の結果から認可用 access を作る。並びは assembleProject と同じ(同じ入力・同じ整列)。
  function accessOf(pd, { sessions, tracks, reflections }) {
    const ordered = orderParts({ sessions, tracks, reflections });
    const sessById = ordered.sessById;
    const crewOf = db.prepare('SELECT user_id FROM session_crew WHERE session_id = ? AND user_id IS NOT NULL');
    return {
      orgId: pd.org_id ?? null,
      tracks: ordered.tracks.map((tr) => {
        const s = sessById.get(tr.session_id) || {};
        return {
          kind: s.kind, visibility: s.visibility, ownerId: s.owner_user_id ?? null,
          crewIds: crewOf.all(tr.session_id).map((c) => c.user_id),
        };
      }),
      reflections: ordered.reflections.map((r) => ({
        id: bodyId(r), visibility: r.visibility, ownerId: r.author_user_id ?? null,
      })),
    };
  }

  function insertAll(rows) {
    insertRow(db, 'practice_days', rows.practiceDay);
    for (const s of rows.sessions) insertRow(db, 'rec_sessions', s);
    for (const t of rows.tracks) insertRow(db, 'tracks', t);
    for (const r of rows.reflections) insertRow(db, 'reflections', r);
  }

  function isAppRow(r) {
    if (r.author_user_id == null) return false;
    let origin;
    try { origin = JSON.parse(r.body)?.origin; } catch { return false; }
    return origin === 'app' || origin === 'voice';
  }

  // managed な反省行だけを incoming と旧 JSON の反省 id で突き合わせる(トランザクション内で呼ぶ)。
  //  - 一致した行: 位置・本文・作者名表示などを更新(公開範囲 visibility・作者 author_user_id は変えない)
  //  - 一致しない incoming: 新しい行(公開範囲 org・作者なし)。ただし見えない既存行と同じ id は無視する。
  //    本文に authorUserId がある incoming も無視する(アプリが消した/別の日へ移した反省を Web が読み返しただけ)
  //  - incoming に無い managed 行: 削除。managed でない行(見えない・書けない)は触らない
  //    ただし keepAppRows のとき、作者がいて origin が app/voice の行は消さない(Web の古い画面からの保存対策)
  function syncManagedReflections(pdId, incomingRows, isManaged, { keepAppRows = false } = {}) {
    const rows = db.prepare('SELECT * FROM reflections WHERE practice_day_id = ?').all(pdId);
    const managed = rows.filter((r) => isManaged({ id: bodyId(r), visibility: r.visibility, ownerId: r.author_user_id ?? null }));
    const managedSet = new Set(managed);
    const hiddenIds = new Set(rows.filter((r) => !managedSet.has(r)).map((r) => bodyId(r)).filter((x) => x != null));
    const queue = new Map(); // 旧 id -> [行,…](同 id は順に消費)。id の無い行は '' に集める
    for (const r of managed) {
      const k = bodyId(r) ?? '';
      if (!queue.has(k)) queue.set(k, []);
      queue.get(k).push(r);
    }
    const matched = new Set();
    for (const r of incomingRows) {
      const bid = bodyId(r) ?? '';
      const q = queue.get(bid);
      const m = q && q.length ? q.shift() : null;
      if (m) {
        matched.add(m.id);
        db.prepare(
          `UPDATE reflections SET position = ?, legacy_author_name = ?, session_id = ?, body = ?,
                  created_at = ?, updated_at = ? WHERE id = ?`,
        ).run(r.position, r.legacy_author_name ?? null, r.session_id ?? null, r.body, r.created_at ?? null, r.updated_at, m.id);
      } else if (bid !== '' && hiddenIds.has(bid)) {
        // 見えない既存の反省と同じ id: 上書きしない
      } else if (bodyHasAuthor(r)) {
        // 作者付きの本文(アプリの反省)で、この日に行が無い: 消された/移されたものなので戻さない
      } else {
        insertRow(db, 'reflections', { ...r, id: `${pdId}_r_${randomBytes(4).toString('hex')}` });
      }
    }
    for (const m of managed) {
      if (matched.has(m.id)) continue;
      if (keepAppRows && isAppRow(m)) continue;
      db.prepare('DELETE FROM reflections WHERE id = ?').run(m.id);
    }
  }

  // roadmaps を読む。orgId が undefined なら全行、それ以外は org_id IS orgId の行だけ(null は組織なし)。
  function selectRoadmaps(cols, orgId) {
    if (orgId === undefined) return db.prepare(`SELECT ${cols} FROM roadmaps`).all();
    return db.prepare(`SELECT ${cols} FROM roadmaps WHERE org_id IS ?`).all(orgId);
  }

  return {
    // 名前の降順。同名なら id 順。
    listProjects() {
      return db.prepare('SELECT id, legacy_name AS name FROM practice_days WHERE legacy_name IS NOT NULL ORDER BY legacy_name DESC, id')
        .all()
        .map(item);
    },

    readProject(id) {
      const pd = getPd.get(id);
      if (!pd) throw new Error('not found');
      const assembled = assembleProject(loadParts(pd));
      return { ...assembled, _rev: pd.rev };
    },

    // 互換 PUT が認可(policy)に使う情報。練習日の器の組織と、旧 JSON の tracks / reflections と
    // 同じ順の項目ごとの公開範囲・所有者。器が無ければ null。(S2.5-P2)
    // access に要るのは軌跡の session_id だけなので、点列(points)は読まない(一覧・保存・削除の認可で毎回呼ぶ)。
    getProjectAccess(id) {
      const pd = getPd.get(id);
      if (!pd) return null;
      return accessOf(pd, loadParts(pd, { points: false }));
    },

    // 旧 JSON と access を「1回の読込み」で返す(同じ行から両方を作るので、tracks / reflections の
    // 並びと access の添字が必ず対応する)。器が無ければ投げる。
    readProjectWithAccess(id) {
      const pd = getPd.get(id);
      if (!pd) throw new Error('not found');
      const parts = loadParts(pd);
      return { project: { ...assembleProject(parts), _rev: pd.rev }, access: accessOf(pd, parts) };
    },

    // readProjectWithAccess と同じ形で、軌跡の点列(points)だけ省いたもの(ホームのカードの要約用)。器が無ければ投げる。
    readSummaryWithAccess(id) {
      const pd = getPd.get(id);
      if (!pd) throw new Error('not found');
      const parts = loadParts(pd, { points: false });
      return { project: assembleProject(parts), access: accessOf(pd, parts) };
    },

    // 反省だけと access(進捗画面の集計用)。軌跡は並びと認可に要る session_id だけ読み、点列(points)は読まない。
    // 器が無ければ投げる。
    readReflectionsWithAccess(id) {
      const pd = getPd.get(id);
      if (!pd) throw new Error('not found');
      const sessions = db.prepare('SELECT * FROM rec_sessions WHERE practice_day_id = ?').all(pd.id);
      const ids = sessions.map((s) => s.id);
      const tracks = ids.length
        ? db.prepare(`SELECT session_id FROM tracks WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : [];
      const reflections = db.prepare('SELECT * FROM reflections WHERE practice_day_id = ?').all(pd.id);
      const parts = { practiceDay: pd, sessions, tracks, reflections };
      return {
        project: { reflections: orderParts(parts).reflections.map((r) => JSON.parse(r.body)) },
        access: accessOf(pd, parts),
      };
    },

    // practiceDate と JST 日が一致する器をすべて返す(降順)。
    findProjectsByPracticeDate(practiceDate) {
      const target = jstMidnightMs(Number(practiceDate));
      return db.prepare(
        `SELECT id, legacy_name AS name, json_extract(web_state, '$.practiceDate') AS pdate
           FROM practice_days WHERE legacy_name IS NOT NULL ORDER BY legacy_name DESC, id`,
      ).all()
        .filter((r) => Number.isFinite(Number(r.pdate)) && jstMidnightMs(Number(r.pdate)) === target)
        .map(item);
    },

    // 進捗の認可用: 全反省の(旧 JSON の)ID・公開範囲・作者・器の組織。
    listReflectionAccess() {
      return db.prepare(
        `SELECT r.body AS body, r.visibility AS visibility, r.author_user_id AS author, pd.org_id AS org_id
           FROM reflections r JOIN practice_days pd ON pd.id = r.practice_day_id`,
      ).all().map((r) => ({
        id: bodyId(r), visibility: r.visibility, ownerId: r.author ?? null, orgId: r.org_id ?? null,
      })).filter((r) => r.id != null);
    },

    // ロードマップの認可用: 人名ごとの組織・所有者。orgId を渡すとその組織の行だけ。
    listRoadmapAccess({ orgId } = {}) {
      return selectRoadmaps('legacy_name, org_id, user_id', orgId)
        .map((r) => ({ legacyName: r.legacy_name, orgId: r.org_id ?? null, userId: r.user_id ?? null }));
    },

    // 新しい器を作る。name は表示用の名前(重複してよい)、orgId は器の組織。返り値の id で以後引く。
    // (managedReflection は既存行が無いので使わない。)
    createProject(obj, { name, orgId = null } = {}) {
      const incoming = { ...obj };
      delete incoming._rev; // メタは保存しない
      const pdId = genId('pd');
      db.exec('BEGIN');
      try {
        const rows = decomposeProject(incoming, { legacyName: name, pdId, now: Date.now(), orgId });
        rows.practiceDay.rev = 1;
        insertAll(rows);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return { id: pdId, name };
    },

    // 既存の器だけを更新する。無ければ code: 'not_found' を投げる(新しい器は createProject)。
    // opts.managedReflection(row): 渡すと、反省は「managed な行だけ」を incoming と突き合わせる
    //   (見えない・書けない反省には触らない)。突き合わせは旧 JSON の反省 id で行い、
    //   既存行の公開範囲・作者は変えない。渡さなければ従来どおり incoming で置き換える。
    writeProject(id, obj, opts = {}) {
      const existing = getPd.get(id);
      if (!existing) {
        const err = new Error('not found');
        err.code = 'not_found';
        throw err;
      }
      const incoming = { ...obj };
      const incomingRev = incoming._rev; // 消す前に控える(古い画面かの判定に使う)
      delete incoming._rev; // メタは保存しない
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const pdId = existing.id;
        const decomp = decomposeProject(incoming, { legacyName: existing.legacy_name, pdId, now });
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
        if (typeof opts.managedReflection === 'function') {
          // _rev が今の rev と一致しない(無い・古い)ときは、アプリから送った反省を残す
          const keepAppRows = !(Number.isInteger(incomingRev) && incomingRev === existing.rev);
          syncManagedReflections(pdId, decomp.reflections, opts.managedReflection, { keepAppRows });
        } else {
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

    // 練習の動画一覧だけ(web_state.videos)。器が無ければ code: 'not_found'。
    readVideos(id) {
      const row = db.prepare('SELECT web_state FROM practice_days WHERE id = ?').get(id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
      const videos = JSON.parse(row.web_state || '{}').videos;
      return Array.isArray(videos) ? videos : [];
    },

    // 動画だけを追記する。1トランザクションで web_state を読み、name + t が未登録のものだけ足す。
    // 足したときだけ web_state・rev・updated_at を更新する(saved_at は「保存」の時刻なので変えない)。
    // 器が無ければ code: 'not_found'。返り値 { videos, added }。
    appendVideos(id, entries) {
      db.exec('BEGIN');
      try {
        const row = db.prepare('SELECT web_state FROM practice_days WHERE id = ?').get(id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
        const ws = JSON.parse(row.web_state || '{}');
        const res = appendVideos(ws.videos, entries);
        if (res.added > 0) {
          db.prepare('UPDATE practice_days SET web_state = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
            .run(JSON.stringify({ ...ws, videos: res.videos }), Date.now(), id);
        }
        db.exec('COMMIT');
        return res;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // 削除の直前に一時保管(server/deletedData.js)へ書き出す中身。DB の行をそのまま(作者・公開範囲・点列を含む)。
    // 器が無ければ null。{ name, data: { practiceDay, sessions, tracks, reflections, sessionCrew } }
    exportForTrash(id) {
      const pd = getPd.get(id);
      if (!pd) return null;
      const sessions = db.prepare('SELECT * FROM rec_sessions WHERE practice_day_id = ?').all(pd.id);
      const ids = sessions.map((s) => s.id);
      const inIds = (sql) => (ids.length ? db.prepare(`${sql} (${ids.map(() => '?').join(',')})`).all(...ids) : []);
      const plain = (rows) => rows.map((r) => ({ ...r }));
      return {
        name: pd.legacy_name ?? null,
        data: {
          practiceDay: { ...pd },
          sessions: plain(sessions),
          tracks: plain(inIds('SELECT * FROM tracks WHERE session_id IN')),
          reflections: plain(db.prepare('SELECT * FROM reflections WHERE practice_day_id = ?').all(pd.id)),
          sessionCrew: plain(inIds('SELECT * FROM session_crew WHERE session_id IN')),
        },
      };
    },

    deleteProject(id) {
      const pd = getPd.get(id);
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

    // roadmap は opts.orgId を渡すと、その組織の行だけ(progress は絞らない)。
    readOverlay(name, opts = {}) {
      if (name === 'progress') {
        return assembleProgress({
          progress: db.prepare('SELECT * FROM reflection_progress').all(),
          comments: db.prepare('SELECT * FROM reflection_comments').all(),
        });
      }
      if (name === 'roadmap') {
        return assembleRoadmap({ roadmaps: selectRoadmaps('*', opts.orgId) });
      }
      return {};
    },

    // opts.orgId: roadmap で新しい行を作るときの組織(MIGRATION_ORG_ID・表示中の組織)。既存行の org_id は変えない。
    // opts.scopeOrgId: roadmap で渡すと、突き合わせ・削除をその組織の行に限る(他組織の行に触らない)。
    writeOverlay(name, obj, opts = {}) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        if (name === 'progress') {
          db.exec('DELETE FROM reflection_comments; DELETE FROM reflection_progress;');
          const { progress, comments } = decomposeProgress(obj, { now });
          for (const r of progress) insertRow(db, 'reflection_progress', r);
          for (const c of comments) insertRow(db, 'reflection_comments', c);
        } else if (name === 'roadmap') {
          // 全消しにしない: 名簿照合で付け替え済みの user_id・org_id を保つ(S2.6-P5)。
          const { roadmaps } = decomposeRoadmap(obj, { now });
          // 新しい行だけ opts.orgId を入れる。既存行は現在の org_id を渡して、COALESCE で組織が
          // 付け替わらないようにする(他組織・組織なしの行を取り込まない)。
          // 範囲(scopeOrgId)があれば、突き合わせは (組織, 名前) で行う。
          const orgOf = new Map(selectRoadmaps('legacy_name, org_id', opts.scopeOrgId).map((r) => [r.legacy_name, r.org_id ?? null]));
          for (const r of roadmaps) r.org_id = orgOf.has(r.legacy_name) ? orgOf.get(r.legacy_name) : (opts.orgId ?? null);
          syncRoadmaps(db, roadmaps, opts.scopeOrgId === undefined ? {} : { scopeOrgId: opts.scopeOrgId });
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
        `SELECT pd.id AS id, pd.legacy_name AS name
           FROM reflections r JOIN practice_days pd ON pd.id = r.practice_day_id
          WHERE r.legacy_author_name = ?
            AND json_extract(pd.web_state, '$.practiceDate') = ?
          LIMIT 1`,
      ).all(person, practiceDate);
      if (!rows.length) return null;
      return item(rows[0]);
    },

    // person が反省の著者で、practiceDate が完全一致する器をすべて返す(名前の降順)。
    // 呼び出し側が見える器を選ぶ(最初の1件が他組織だと取りこぼすため)。
    findReflectionsByDate(person, practiceDate) {
      return db.prepare(
        `SELECT DISTINCT pd.id AS id, pd.legacy_name AS name
           FROM reflections r JOIN practice_days pd ON pd.id = r.practice_day_id
          WHERE r.legacy_author_name = ?
            AND json_extract(pd.web_state, '$.practiceDate') = ?
          ORDER BY pd.legacy_name DESC, pd.id`,
      ).all(person, practiceDate).map(item);
    },

    // fileRepo と同じ: practiceDate を持つ器のうち JST 日が一致する最初のものを返す(降順)。
    findProjectByPracticeDate(practiceDate) {
      const target = jstMidnightMs(Number(practiceDate));
      const rows = db.prepare(
        `SELECT id, legacy_name AS name, json_extract(web_state, '$.practiceDate') AS pdate
           FROM practice_days WHERE legacy_name IS NOT NULL ORDER BY legacy_name DESC, id`,
      ).all();
      for (const r of rows) {
        const pd = Number(r.pdate);
        if (!Number.isFinite(pd)) continue;
        if (jstMidnightMs(pd) === target) return item(r);
      }
      return null;
    },
  };
}
