// server/static.js
// 静的ファイル配信。text 系は charset=utf-8 を明示(serve.py と同じ理由)。
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';

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
  '.pdf': 'application/pdf',
};

export function contentType(pathname) {
  return TYPES[extname(pathname).toLowerCase()] || 'application/octet-stream';
}

// アカウント画面(S2.7)。確認・再設定メールのリンク先 /verify-email・/reset-password と /account を同じ HTML で配信する。
// 招待の参加ページ /join/:code(S2.10)も同じ HTML。
const ACCOUNT_PAGES = new Set(['/account', '/verify-email', '/reset-password']);
export function pagePathFor(pathname) {
  const p = String(pathname).replace(/\/+$/, '');
  if (/^\/join\/[^/]+$/.test(p)) return '/account.html';
  return ACCOUNT_PAGES.has(p) ? '/account.html' : null;
}

export async function serveStatic(req, res, rootDir) {
  const url = new URL(req.url, 'http://localhost');
  // 招待 API が返す url は `/?invite=<code>`(S2.9)。参加ページの正規の形は `/join/<code>` なので、
  // `/` に invite 付きで来たらここへ寄せる(コードは Referer に漏らさない)。
  const invite = url.pathname === '/' ? url.searchParams.get('invite') : null;
  if (invite) {
    res.writeHead(302, { location: `/join/${encodeURIComponent(invite)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  const page = pagePathFor(rel);
  if (page) rel = page;
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = normalize(rootDir);
  const full = normalize(join(rootDir, rel));
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const s = await stat(full);
    if (s.isDirectory()) { res.writeHead(403).end('forbidden'); return; }
    const buf = await readFile(full);
    const headers = { 'content-type': contentType(full), 'cache-control': 'no-store' };
    // リンクのトークンを Referer で外へ漏らさない
    if (page) headers['referrer-policy'] = 'no-referrer';
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}
