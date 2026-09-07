// server/index.js
// 静的フロント配信 + /api ルーターを兼ねる依存ゼロ HTTP サーバー。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from './api.js';
import { serveStatic } from './static.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const TOKEN = process.env.SAILVIZ_WRITE_TOKEN || '';

const api = createApi({ dataDir: DATA_DIR, token: TOKEN });

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    await serveStatic(req, res, ROOT);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`SailViz on http://localhost:${PORT}  data=${DATA_DIR}  write=${TOKEN ? 'on' : 'OFF'}`);
});
