// server/db/importFromFiles.js
// 既存ファイル(data/projects/*.json, progress.json, roadmap.json)→ DB の取込。
// --dry-run で件数と警告(対応する反省が無い progress キー)を出し、書き込まない。
// 同じ legacy_name の器は子ごと消してから入れ直す。ただし成功すると meta に「取込み済み」の印を書き、
// 印があれば再実行を拒否する(S2.6-P8)。やり直しは forceReimport(CLI は --force-reimport)だけ。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decomposeProject } from '../domain/projectRows.js';
import { decomposeProgress, decomposeRoadmap } from '../domain/overlayRows.js';
import { syncRoadmaps } from './roadmapSync.js';
import { openDb } from './connection.js';
import { migrate, loadMigrations } from './migrate.js';

function insertRow(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
}

function deletePd(db, pdId) {
  const sids = db.prepare('SELECT id FROM rec_sessions WHERE practice_day_id = ?').all(pdId).map((r) => r.id);
  for (const sid of sids) db.prepare('DELETE FROM tracks WHERE session_id = ?').run(sid);
  db.prepare('DELETE FROM rec_sessions WHERE practice_day_id = ?').run(pdId);
  db.prepare('DELETE FROM reflections WHERE practice_day_id = ?').run(pdId);
  db.prepare('DELETE FROM practice_days WHERE id = ?').run(pdId);
}

const MARKER_KEY = 'import_completed';

// 取込み済みの印(meta.import_completed)。無ければ null。
export function readImportMarker(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(MARKER_KEY);
  return row ? JSON.parse(row.value) : null;
}

function writeImportMarker(db, { at, orgId, updatedAt = at }) {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MARKER_KEY, JSON.stringify({ at, orgId: orgId ?? null }), updatedAt);
}

// 取込みの再実行(importFromFiles)で実際に消える・上書きされる既存データの件数。
// 削除・上書きと同じ条件で数える: 練習日は legacy_name が今回の入力(projects/*.sailviz.json のファイル名)と一致する行と、
// その下で deletePd が一緒に消す rec_sessions・tracks・reflections。progress/comments は progress.json があるときだけ全消し。
// roadmaps は roadmap.json があるとき、legacy_name 一致の行が上書き、user_id NULL かつ入力に無い行が削除(syncRoadmaps と同じ)。
export function countReimportLoss(db, { dataDir }) {
  const projDir = join(dataDir, 'projects');
  const names = existsSync(projDir) ? readdirSync(projDir).filter((f) => /\.sailviz\.json$/.test(f)) : [];
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;
  const loss = { practiceDays: 0, recSessions: 0, tracks: 0, reflections: 0, progress: 0, comments: 0, roadmapsOverwritten: 0, roadmapsDeleted: 0 };
  for (const f of names) {
    const pd = db.prepare('SELECT id FROM practice_days WHERE legacy_name = ?').get(f);
    if (!pd) continue;
    loss.practiceDays += 1;
    loss.recSessions += one('SELECT count(*) c FROM rec_sessions WHERE practice_day_id = ?', pd.id);
    loss.tracks += one('SELECT count(*) c FROM tracks WHERE session_id IN (SELECT id FROM rec_sessions WHERE practice_day_id = ?)', pd.id);
    loss.reflections += one('SELECT count(*) c FROM reflections WHERE practice_day_id = ?', pd.id);
  }
  if (existsSync(join(dataDir, 'progress.json'))) {
    loss.progress = one('SELECT count(*) c FROM reflection_progress');
    loss.comments = one('SELECT count(*) c FROM reflection_comments');
  }
  const roadFile = join(dataDir, 'roadmap.json');
  if (existsSync(roadFile)) {
    const { roadmaps } = decomposeRoadmap(JSON.parse(readFileSync(roadFile, 'utf8')), { now: 0, orgId: null });
    const inNames = new Set(roadmaps.map((r) => r.legacy_name));
    for (const ex of db.prepare('SELECT legacy_name, user_id FROM roadmaps').all()) {
      if (ex.user_id === null && !inNames.has(ex.legacy_name)) loss.roadmapsDeleted += 1;
    }
    for (const n of inNames) {
      if (db.prepare('SELECT 1 FROM roadmaps WHERE legacy_name = ?').get(n)) loss.roadmapsOverwritten += 1;
    }
  }
  return loss;
}

// 組織 ID を後から直す専用手順(再実行はしない)。
// org_id IS NULL かつ legacy_name のある行だけを orgId にする。他組織の行・legacy_name の無い行は触らない。
// practice_days は org_id / owner_user_id の排他(001)を守るため owner_user_id が空の行だけ。
// 印の orgId は null か今回と一致のときだけ直す。別組織の印は書き換えず warnings に出す。
// dryRun は同じ WHERE の件数だけ返して書かない。now は印の更新時刻(meta.updated_at)に使う。
export function fixLegacyOrgId({ db, orgId, now = Date.now(), dryRun = false }) {
  if (!orgId) throw new Error('組織 ID が必要です(MIGRATION_ORG_ID)');
  if (!db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) {
    throw new Error(`MIGRATION_ORG_ID の組織が存在しません: ${orgId}`);
  }
  const PD_WHERE = 'org_id IS NULL AND owner_user_id IS NULL AND legacy_name IS NOT NULL';
  const RM_WHERE = 'org_id IS NULL AND legacy_name IS NOT NULL';
  const warnings = [];
  if (dryRun) {
    const pd = db.prepare(`SELECT count(*) c FROM practice_days WHERE ${PD_WHERE}`).get().c;
    const rm = db.prepare(`SELECT count(*) c FROM roadmaps WHERE ${RM_WHERE}`).get().c;
    const marker = readImportMarker(db);
    if (marker && marker.orgId != null && marker.orgId !== orgId) {
      warnings.push(`印の組織(${marker.orgId})は今回(${orgId})と違うため、印は書き換えません`);
    }
    return { practiceDays: Number(pd), roadmaps: Number(rm), warnings };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const pd = db.prepare(`UPDATE practice_days SET org_id = ? WHERE ${PD_WHERE}`).run(orgId).changes;
    const rm = db.prepare(`UPDATE roadmaps SET org_id = ? WHERE ${RM_WHERE}`).run(orgId).changes;
    const marker = readImportMarker(db);
    if (marker) {
      if (marker.orgId == null || marker.orgId === orgId) {
        writeImportMarker(db, { at: marker.at, orgId, updatedAt: now });
      } else {
        warnings.push(`印の組織(${marker.orgId})は今回(${orgId})と違うため、印は書き換えません`);
      }
    }
    db.exec('COMMIT');
    return { practiceDays: Number(pd), roadmaps: Number(rm), warnings };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function importFromFiles({ db, dataDir, dryRun = false, now = Date.now(), orgId = null, forceReimport = false }) {
  const projDir = join(dataDir, 'projects');
  const report = { projects: 0, sessions: 0, tracks: 0, reflections: 0, progress: 0, comments: 0, roadmap: 0, warnings: [] };
  // 実在しない組織 ID で取り込むと、孤児の org_id が入って名簿照合も効かない。何も書かずに止める。
  if (orgId != null && !db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) {
    throw new Error(`MIGRATION_ORG_ID の組織が存在しません: ${orgId}`);
  }
  const files = existsSync(projDir) ? readdirSync(projDir).filter((f) => /\.sailviz\.json$/.test(f)).sort() : [];
  const reflIds = new Set();

  if (!dryRun) db.exec('BEGIN IMMEDIATE');
  try {
    // 取込み済みの印があれば、DB 運用開始後の再実行は消える(進捗・コメント等)ので拒否する。dry-run は書かないので通す。
    // 印の確認は書き込みロックを取った後に行う(確認と書き込みの間に別の取込みが入らない)。
    if (!dryRun && !forceReimport) {
      const marker = readImportMarker(db);
      if (marker) {
        const err = new Error(`取込み済みです(${new Date(marker.at).toISOString()}、組織 ${marker.orgId ?? '未設定'})。再実行は DB の進捗・コメント・ロードマップ・練習日を置き換えます。必要なら --force-reimport`);
        err.code = 'IMPORT_ALREADY_DONE';
        throw err;
      }
    }
    for (const f of files) {
      const proj = JSON.parse(readFileSync(join(projDir, f), 'utf8'));
      const rows = decomposeProject(proj, { legacyName: f, pdId: `pd_${randomBytes(5).toString('hex')}`, now, orgId });
      report.projects += 1;
      report.sessions += rows.sessions.length;
      report.tracks += rows.tracks.length;
      report.reflections += rows.reflections.length;
      // orphan 判定は progress.json と同じ「元の反省 ID」で行う(行の id は合成なので使わない)。
      (Array.isArray(proj.reflections) ? proj.reflections : []).forEach((r) => reflIds.add(r.id));
      if (!dryRun) {
        const ex = db.prepare('SELECT id FROM practice_days WHERE legacy_name = ?').get(f);
        if (ex) deletePd(db, ex.id);
        insertRow(db, 'practice_days', rows.practiceDay);
        for (const s of rows.sessions) insertRow(db, 'rec_sessions', s);
        for (const t of rows.tracks) insertRow(db, 'tracks', t);
        for (const r of rows.reflections) insertRow(db, 'reflections', r);
      }
    }

    const progFile = join(dataDir, 'progress.json');
    if (existsSync(progFile)) {
      const { progress, comments } = decomposeProgress(JSON.parse(readFileSync(progFile, 'utf8')), { now });
      report.progress = progress.length;
      report.comments = comments.length;
      for (const row of progress) {
        if (!reflIds.has(row.reflection_id)) report.warnings.push(`orphan progress (no reflection): ${row.reflection_id}`);
      }
      if (!dryRun) {
        db.exec('DELETE FROM reflection_comments; DELETE FROM reflection_progress;');
        for (const r of progress) insertRow(db, 'reflection_progress', r);
        for (const c of comments) insertRow(db, 'reflection_comments', c);
      }
    }

    const roadFile = join(dataDir, 'roadmap.json');
    if (existsSync(roadFile)) {
      const { roadmaps } = decomposeRoadmap(JSON.parse(readFileSync(roadFile, 'utf8')), { now, orgId });
      report.roadmap = roadmaps.length;
      if (!dryRun) {
        // 全消しにしない: 付け替え済みの user_id・org_id を保つ(S2.6-P5)。
        syncRoadmaps(db, roadmaps, { orgId });
      }
    }

    if (!dryRun) {
      writeImportMarker(db, { at: now, orgId });
      db.exec('COMMIT');
    }
  } catch (e) {
    if (!dryRun) db.exec('ROLLBACK');
    throw e;
  }
  return report;
}

// CLI: node server/db/importFromFiles.js <dataDir> [--dry-run] [--force-reimport]
//      MIGRATION_ORG_ID=<組織ID> node server/db/importFromFiles.js <dataDir> --fix-org-id [--dry-run]
//      (--fix-org-id と --force-reimport の同時指定は終了コード 1)
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force-reimport');
  const dataDir = args.find((a) => !a.startsWith('--')) || './data';
  const db = openDb(join(dataDir, 'sailviz.db'));
  const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  migrate(db, loadMigrations(MIG_DIR));
  const orgId = process.env.MIGRATION_ORG_ID || null;
  if (args.includes('--fix-org-id')) {
    if (force) {
      console.error('--fix-org-id と --force-reimport は同時に指定できません');
      db.close();
      process.exit(1);
    }
    try {
      const { warnings, ...r } = fixLegacyOrgId({ db, orgId, dryRun });
      console.log(`${dryRun ? '[dry-run] ' : ''}fix-org-id: ${JSON.stringify(r)}(org_id=${orgId})${dryRun ? ' 書き込みはしていません' : ''}`);
      for (const w of warnings) console.warn('  warn:', w);
      db.close();
      process.exit(0);
    } catch (e) {
      console.error(`fix-org-id 失敗: ${e.message}`);
      db.close();
      process.exit(1);
    }
  }
  if (force && !dryRun && readImportMarker(db)) {
    // 先に dry-run と消える件数を出してから進む。
    try {
      const pre = importFromFiles({ db, dataDir, dryRun: true, orgId });
      console.log(`[force-reimport] 取込み予定: ${JSON.stringify({ ...pre, warnings: pre.warnings.length })}`);
      console.log(`[force-reimport] 消える件数(置き換わる既存データ): ${JSON.stringify(countReimportLoss(db, { dataDir }))}`);
    } catch (e) {
      console.error(`import 失敗: ${e.message}`);
      db.close();
      process.exit(1);
    }
  }
  if (!orgId) console.warn('  warn: MIGRATION_ORG_ID 未設定 — org_id が NULL で入り、名簿照合による legacy_* の付け替えが効きません');
  let report;
  try {
    report = importFromFiles({ db, dataDir, dryRun, orgId, forceReimport: force });
  } catch (e) {
    console.error(`import 失敗: ${e.message}`);
    db.close();
    process.exit(1);
  }
  db.close();
  console.log(`${dryRun ? '[dry-run] ' : ''}import: ${JSON.stringify({ ...report, warnings: report.warnings.length })}`);
  for (const w of report.warnings) console.log('  warn:', w);
}
