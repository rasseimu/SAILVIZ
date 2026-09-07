// server/static.js
// 静的ファイル配信。text 系は charset=utf-8 を明示(serve.py と同じ理由)。
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

export function contentType(pathname) {
  return TYPES[extname(pathname).toLowerCase()] || 'application/octet-stream';
}

export async function serveStatic(req, res, rootDir) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(rootDir, rel));
  if (!full.startsWith(normalize(rootDir))) { res.writeHead(403).end('forbidden'); return; }
  try {
    const s = await stat(full);
    if (s.isDirectory()) { res.writeHead(403).end('forbidden'); return; }
    const buf = await readFile(full);
    res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}
