// server/db/exportToFiles.js
// DB → ファイル の書き戻し(移行の戻し道)。practice_days を旧 JSON に組み立てて
// outDir/projects/<legacy_name>(同名は <名前>-<id>.sailviz.json)に、progress/roadmap を outDir に書く。
// 出力は旧 storage と同じく JSON.stringify(無整形)。_rev は付けない。
// 旧ファイルは 1 組織分しか持てないので、組織ごとに書き出す(orgId)。データのある組織が
// 2 つ以上あるのに orgId が無ければ、混ぜずに投げる(何も書かない)。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './connection.js';
import { createDbRepo } from '../repos/dbRepo.js';

// データ(練習・ロードマップ)のある組織。組織なし(NULL)も 1 つと数える。
function orgsWithData(db) {
  return db.prepare('SELECT org_id FROM practice_days UNION SELECT org_id FROM roadmaps').all().map((r) => r.org_id ?? null);
}

export function exportToFiles({ db, outDir, orgId }) {
  const repo = createDbRepo({ db, dataDir: outDir });
  const orgs = orgsWithData(db);
  // scope: undefined = 全部(組織が 1 つ以下で混ざらない)、それ以外 = その組織だけ。
  const scope = orgId || undefined;
  if (scope === undefined && orgs.length > 1) {
    throw new Error(`データのある組織が ${orgs.length} つあります。orgId(CLI は MIGRATION_ORG_ID か第 3 引数)で書き出す組織を指定してください`);
  }
  mkdirSync(join(outDir, 'projects'), { recursive: true });
  const report = { projects: 0, progress: 0, roadmap: 0 };

  // 名前は重複してよい(設計書 §5.5.1)。同名の 2 つ目以降は上書きせず <名前>-<id>.sailviz.json に書く。
  const projects = scope === undefined
    ? repo.listProjects()
    : db.prepare('SELECT id, legacy_name AS name FROM practice_days WHERE legacy_name IS NOT NULL AND org_id IS ? ORDER BY legacy_name DESC, id').all(scope);
  const written = new Set();
  for (const { id, name } of projects) {
    const { _rev, ...pure } = repo.readProject(id);
    void _rev;
    const file = written.has(name) ? `${name.replace(/\.sailviz\.json$/, '')}-${id}.sailviz.json` : name;
    written.add(name);
    writeFileSync(join(outDir, 'projects', file), JSON.stringify(pure), 'utf8');
    report.projects += 1;
  }

  const progress = scope === undefined ? repo.readOverlay('progress') : progressOfOrg(repo, scope, orgs);
  if (Object.keys(progress).length) {
    writeFileSync(join(outDir, 'progress.json'), JSON.stringify(progress), 'utf8');
    report.progress = Object.keys(progress).length;
  }
  const roadmap = repo.readOverlay('roadmap', scope === undefined ? {} : { orgId: scope });
  if (Object.keys(roadmap).length) {
    writeFileSync(join(outDir, 'roadmap.json'), JSON.stringify(roadmap), 'utf8');
    report.roadmap = Object.keys(roadmap).length;
  }
  return report;
}

// その組織の反省の進捗だけ。同じ反省 ID が複数の器にある旧データは、全部がその組織のときだけ入れる
// (compatAccess と同じ規則)。反省の無い(孤立した)進捗は、データのある組織がその組織だけのときだけ残す。
function progressOfOrg(repo, orgId, orgs) {
  const orgsOfRefl = new Map();
  for (const r of repo.listReflectionAccess()) {
    if (!orgsOfRefl.has(r.id)) orgsOfRefl.set(r.id, []);
    orgsOfRefl.get(r.id).push(r.orgId);
  }
  const onlyThisOrg = orgs.every((o) => o === orgId);
  const out = {};
  for (const [id, entry] of Object.entries(repo.readOverlay('progress'))) {
    const os = orgsOfRefl.get(id);
    if (os ? os.every((o) => o === orgId) : onlyThisOrg) out[id] = entry;
  }
  return out;
}

// CLI: node server/db/exportToFiles.js <dbPath> <outDir> [orgId]
// orgId を省くと MIGRATION_ORG_ID。どちらも無く、データのある組織が 2 つ以上なら止める(exit 1)。
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dbPath, outDir, orgArg] = process.argv.slice(2);
  if (!dbPath || !outDir) { console.error('usage: node server/db/exportToFiles.js <dbPath> <outDir> [orgId]'); process.exit(1); }
  const db = openDb(dbPath);
  try {
    const report = exportToFiles({ db, outDir, orgId: orgArg || process.env.MIGRATION_ORG_ID || undefined });
    console.log(`export: ${JSON.stringify(report)}`);
  } catch (e) {
    console.error(`export: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
