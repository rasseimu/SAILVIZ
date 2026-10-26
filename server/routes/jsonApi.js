// server/routes/jsonApi.js
// JSON API ルート共通の小物(エラー応答と JSON 本文の読み込み)。
import { send } from './http.js';

export const err = (res, status, code, message) => send(res, status, { error: { code, message } });

// 本文を JSON として読む。空本文は {}、上限超過は e.code='too_large'、壊れた JSON は e.code='bad_json'。
export async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('too large'); e.code = 'too_large'; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const e = new Error('bad json'); e.code = 'bad_json'; throw e;
  }
}
