// server/index.js
// 静的フロント配信 + /api ルーターを兼ねる依存ゼロ HTTP サーバー。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from './api.js';
import { serveStatic } from './static.js';
import { resolveViewGate } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const TOKEN = process.env.SAILVIZ_WRITE_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// 閲覧ログインの資格情報は env から解決する(既定値の埋め込みは廃止)。
// 本番で未設定なら resolveViewGate が throw し、起動を止める。
const { viewUser: VIEW_USER, viewPassword: VIEW_PASSWORD } = resolveViewGate(process.env);

const api = createApi({
  dataDir: DATA_DIR, token: TOKEN, geminiKey: GEMINI_KEY,
  viewUser: VIEW_USER, viewPassword: VIEW_PASSWORD,
});

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    await serveStatic(req, res, ROOT);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`SailViz on http://localhost:${PORT}  data=${DATA_DIR}  write=${TOKEN ? 'on' : 'OFF'}  ai=${GEMINI_KEY ? 'on' : 'OFF'}  view-gate=${VIEW_USER && VIEW_PASSWORD ? 'on' : 'OFF'}`);
});
