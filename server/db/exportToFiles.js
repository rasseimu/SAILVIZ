// server/db/exportToFiles.js
// DB → ファイル の書き戻し(移行の戻し道)。practice_days を旧 JSON に組み立てて
// outDir/projects/<legacy_name> に、progress/roadmap を outDir に書く。
// 出力は旧 storage と同じく JSON.stringify(無整形)。_rev は付けない。
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './connection.js';
import { createDbRepo } from '../repos/dbRepo.js';

export function exportToFiles({ db, outDir }) {
  const repo = createDbRepo({ db, dataDir: outDir });
  mkdirSync(join(outDir, 'projects'), { recursive: true });
  const report = { projects: 0, progress: 0, roadmap: 0 };

  for (const { name } of repo.listProjects()) {
    const { _rev, ...pure } = repo.readProject(name);
    void _rev;
    writeFileSync(join(outDir, 'projects', name), JSON.stringify(pure), 'utf8');
    report.projects += 1;
  }

  const progress = repo.readOverlay('progress');
  if (Object.keys(progress).length) {
    writeFileSync(join(outDir, 'progress.json'), JSON.stringify(progress), 'utf8');
    report.progress = Object.keys(progress).length;
  }
  const roadmap = repo.readOverlay('roadmap');
  if (Object.keys(roadmap).length) {
    writeFileSync(join(outDir, 'roadmap.json'), JSON.stringify(roadmap), 'utf8');
    report.roadmap = Object.keys(roadmap).length;
  }
  return report;
}

// CLI: node server/db/exportToFiles.js <dbPath> <outDir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dbPath, outDir] = process.argv.slice(2);
  if (!dbPath || !outDir) { console.error('usage: node server/db/exportToFiles.js <dbPath> <outDir>'); process.exit(1); }
  void dirname; void fileURLToPath;
  const db = openDb(dbPath);
  const report = exportToFiles({ db, outDir });
  db.close();
  console.log(`export: ${JSON.stringify(report)}`);
}
