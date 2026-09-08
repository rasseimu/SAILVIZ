// data/ 配下のファイル CRUD。baseDir 注入でテスト可能。名前検証でパストラバーサルを防ぐ。
import { readFile, writeFile, readdir, unlink, mkdir, rename } from 'node:fs/promises';
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

const IMPORT_ID_RE = /^imp_[A-Za-z0-9_]+$/;
const UPLOAD_FILE_RE = /^[A-Za-z0-9._-]+\.csv$/;

export function isValidImportId(id) {
  return typeof id === 'string' && !id.includes('..') && IMPORT_ID_RE.test(id);
}
export function isValidUploadFile(name) {
  return typeof name === 'string' && !name.includes('..') && UPLOAD_FILE_RE.test(name);
}

function uploadsDir(dataDir) { return join(dataDir, 'uploads'); }
export function uploadPath(dataDir, importId, filename) {
  if (!isValidImportId(importId)) throw new Error('invalid importId');
  if (!isValidUploadFile(filename)) throw new Error('invalid upload file');
  return join(uploadsDir(dataDir), importId, filename);
}

export async function saveUpload(dataDir, importId, filename, text) {
  const p = uploadPath(dataDir, importId, filename);
  await ensureDir(join(uploadsDir(dataDir), importId));
  await writeFile(p, text, 'utf8');
  return p;
}
export async function readUpload(dataDir, importId, filename) {
  return readFile(uploadPath(dataDir, importId, filename), 'utf8');
}
export async function renameUpload(dataDir, importId, from, to) {
  const dest = uploadPath(dataDir, importId, to);
  await rename(uploadPath(dataDir, importId, from), dest);
  return dest;
}

// person(=people[0]) と practiceDate(JST 0 時 ms) が一致する Reflection プロジェクトを探す。
export async function findReflectionByDate(dataDir, person, practiceDate) {
  const list = await listProjects(dataDir);
  for (const { name, label } of list) {
    let proj;
    try { proj = await readProject(dataDir, name); } catch { continue; }
    if (Number(proj.practiceDate) !== Number(practiceDate)) continue;
    const refls = Array.isArray(proj.reflections) ? proj.reflections : [];
    if (refls.some((r) => Array.isArray(r.people) && r.people[0] === person)) {
      return { name, label };
    }
  }
  return null;
}
