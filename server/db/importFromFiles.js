// server/db/importFromFiles.js
// 既存ファイル(data/projects/*.json, progress.json, roadmap.json)→ DB の取込。
// --dry-run で件数と警告(対応する反省が無い progress キー)を出し、書き込まない。
// 冪等: 同じ legacy_name の器は子ごと消してから入れ直すので、2回流しても結果は同じ。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decomposeProject } from '../domain/projectRows.js';
import { decomposeProgress, decomposeRoadmap } from '../domain/overlayRows.js';
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

export function importFromFiles({ db, dataDir, dryRun = false, now = Date.now(), orgId = null }) {
  const projDir = join(dataDir, 'projects');
  const report = { projects: 0, sessions: 0, tracks: 0, reflections: 0, progress: 0, comments: 0, roadmap: 0, warnings: [] };
  const files = existsSync(projDir) ? readdirSync(projDir).filter((f) => /\.sailviz\.json$/.test(f)).sort() : [];
  const reflIds = new Set();

  if (!dryRun) db.exec('BEGIN');
  try {
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
      const { roadmaps } = decomposeRoadmap(JSON.parse(readFileSync(roadFile, 'utf8')), { now });
      report.roadmap = roadmaps.length;
      if (!dryRun) {
        db.exec('DELETE FROM roadmaps;');
        for (const r of roadmaps) insertRow(db, 'roadmaps', r);
      }
    }

    if (!dryRun) db.exec('COMMIT');
  } catch (e) {
    if (!dryRun) db.exec('ROLLBACK');
    throw e;
  }
  return report;
}

// CLI: node server/db/importFromFiles.js <dataDir> [--dry-run]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dataDir = args.find((a) => !a.startsWith('--')) || './data';
  const db = openDb(join(dataDir, 'sailviz.db'));
  const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  migrate(db, loadMigrations(MIG_DIR));
  const report = importFromFiles({ db, dataDir, dryRun, orgId: process.env.MIGRATION_ORG_ID || null });
  db.close();
  console.log(`${dryRun ? '[dry-run] ' : ''}import: ${JSON.stringify({ ...report, warnings: report.warnings.length })}`);
  for (const w of report.warnings) console.log('  warn:', w);
}
