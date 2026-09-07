// ローカルの既存データを data/ に取り込む一度きりの CLI。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeProject, writeOverlay, isValidProjectName } from './storage.js';

export async function importFolder(srcDir, dataDir) {
  const names = await readdir(srcDir);
  let projects = 0;
  const overlays = [];
  for (const name of names) {
    if (isValidProjectName(name)) {
      await writeProject(dataDir, name, JSON.parse(await readFile(join(srcDir, name), 'utf8')));
      projects++;
    }
  }
  const maybe = [['sailviz-progress.json', 'progress'], ['sailviz-roadmap.json', 'roadmap']];
  for (const [file, overlay] of maybe) {
    try {
      const obj = JSON.parse(await readFile(join(srcDir, file), 'utf8'));
      await writeOverlay(dataDir, overlay, obj);
      overlays.push(overlay);
    } catch { /* 無ければスキップ */ }
  }
  return { projects, overlays };
}

// CLI 実行
if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, data = './data'] = process.argv.slice(2);
  if (!src) { console.error('usage: node server/import.js <srcDir> [dataDir]'); process.exit(1); }
  importFolder(src, data).then((r) =>
    console.log(`imported ${r.projects} projects, overlays: ${r.overlays.join(',') || 'none'}`));
}
