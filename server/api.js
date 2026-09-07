// server/api.js
// http (req,res) を受け /api/* を処理。処理したら true を返す。
import {
  listProjects, readProject, writeProject, deleteProject,
  readOverlay, writeOverlay, OVERLAY_NAMES, isValidProjectName,
} from './storage.js';
import { isAuthorized } from './auth.js';
import { practiceSummary } from '../src/summary.js';
import { geminiGenerate } from './gemini.js';

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApi({ dataDir, token, geminiKey }) {
  return async function api(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    const method = req.method;
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    try {
      if (path === '/api/health') { send(res, 200, { ok: true }); return true; }

      // AIコメント生成のプロキシ。キーはサーバ環境変数に隠す(クライアントに出さない)。
      // 課金が発生するため編集モード(認証)必須にし、無認証の乱用を防ぐ。
      if (path === '/api/ai-comment' && method === 'POST') {
        if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
        if (!geminiKey) { send(res, 503, { error: 'AI未設定(GEMINI_API_KEY 未設定)' }); return true; }
        const body = await readBody(req) || {};
        try {
          const text = await geminiGenerate({
            apiKey: geminiKey,
            model: body.model, system: body.system, parts: body.parts,
            temperature: body.temperature, maxOutputTokens: body.maxOutputTokens,
            responseMimeType: body.responseMimeType,
          });
          send(res, 200, { text });
        } catch (e) {
          send(res, 502, { error: String((e && e.message) || e) });
        }
        return true;
      }

      if (path === '/api/auth') { send(res, 200, { unlocked: isAuthorized(req, token) }); return true; }

      if (path === '/api/unlock' && method === 'POST') {
        if (!token) { send(res, 503, { error: 'write disabled' }); return true; }
        const body = await readBody(req);
        if (body?.password === token) {
          send(res, 200, { unlocked: true }, {
            'set-cookie': `sailviz_token=${token}; HttpOnly; SameSite=Lax; Path=/${secureCookie}`,
          });
        } else send(res, 401, { error: 'invalid password' });
        return true;
      }

      if (path === '/api/lock' && method === 'POST') {
        send(res, 200, { unlocked: false }, {
          'set-cookie': `sailviz_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
        });
        return true;
      }

      if (path === '/api/projects' && method === 'GET') {
        send(res, 200, await listProjects(dataDir)); return true;
      }

      if (path === '/api/summaries' && method === 'GET') {
        const list = await listProjects(dataDir);
        const rows = [];
        for (const { name } of list) {
          try { rows.push({ name, ...practiceSummary(await readProject(dataDir, name), { name }) }); }
          catch { /* 壊れたファイルは飛ばす */ }
        }
        send(res, 200, rows); return true;
      }

      const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const name = decodeURIComponent(projMatch[1]);
        if (!isValidProjectName(name)) { send(res, 400, { error: 'bad name' }); return true; }
        if (method === 'GET') {
          try { send(res, 200, await readProject(dataDir, name)); }
          catch { send(res, 404, { error: 'not found' }); }
          return true;
        }
        if (method === 'PUT') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          await writeProject(dataDir, name, await readBody(req));
          send(res, 200, { ok: true }); return true;
        }
        if (method === 'DELETE') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          try { await deleteProject(dataDir, name); } catch { /* 既に無ければ黙認 */ }
          send(res, 200, { ok: true }); return true;
        }
      }

      const ovMatch = path.match(/^\/api\/overlays\/([^/]+)$/);
      if (ovMatch) {
        const name = ovMatch[1];
        if (!OVERLAY_NAMES.includes(name)) { send(res, 400, { error: 'bad overlay' }); return true; }
        if (method === 'GET') { send(res, 200, await readOverlay(dataDir, name)); return true; }
        if (method === 'PUT') {
          if (!isAuthorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
          await writeOverlay(dataDir, name, await readBody(req));
          send(res, 200, { ok: true }); return true;
        }
      }

      send(res, 404, { error: 'no route' });
      return true;
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
      return true;
    }
  };
}
