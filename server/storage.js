// data/ 配下のファイル CRUD。baseDir 注入でテスト可能。名前検証でパストラバーサルを防ぐ。
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectLabel } from '../src/projectfs.js';

const PROJECT_RE = /^[A-Za-z0-9._-]+\.sailviz\.json$/;
export const OVERLAY_NAMES = ['progress', 'roadmap'];

export function isValidProjectName(name) {
  return typeof name === 'string' && !name.includes('..') && PROJECT_RE.test(name);
}

function projectsDir(dataDir) { return join(dataDir, 'projects'); }

async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

export async function listProjects(dataDir) {
  const dir = projectsDir(dataDir);
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  names = names.filter(isValidProjectName).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return names.map((name) => ({ name, label: projectLabel(name) }));
}

export async function readProject(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  const text = await readFile(join(projectsDir(dataDir), name), 'utf8');
  return JSON.parse(text);
}

export async function writeProject(dataDir, name, obj) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await ensureDir(projectsDir(dataDir));
  await writeFile(join(projectsDir(dataDir), name), JSON.stringify(obj), 'utf8');
}

export async function deleteProject(dataDir, name) {
  if (!isValidProjectName(name)) throw new Error('invalid name');
  await unlink(join(projectsDir(dataDir), name));
}

function overlayPath(dataDir, name) {
  if (!OVERLAY_NAMES.includes(name)) throw new Error('invalid overlay');
  return join(dataDir, `${name}.json`);
}

export async function readOverlay(dataDir, name) {
  try {
    const obj = JSON.parse(await readFile(overlayPath(dataDir, name), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

export async function writeOverlay(dataDir, name, obj) {
  await ensureDir(dataDir);
  await writeFile(overlayPath(dataDir, name), JSON.stringify(obj), 'utf8');
}
