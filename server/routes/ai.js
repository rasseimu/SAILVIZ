// server/routes/ai.js
// AIコメント生成のプロキシ。キーはサーバ環境変数に隠す(クライアントに出さない)。
// 課金が発生するため編集モード(認証)必須にし、無認証の乱用を防ぐ。
import { send, readBody } from './http.js';
import { geminiGenerate } from '../gemini.js';

export async function aiRoute(req, res, ctx) {
  if (!(ctx.path === '/api/ai-comment' && ctx.method === 'POST')) return false;
  if (ctx.requireWrite()) return true;
  if (!ctx.geminiKey) { send(res, 503, { error: 'AI未設定(GEMINI_API_KEY 未設定)' }); return true; }
  const body = await readBody(req) || {};
  try {
    const text = await geminiGenerate({
      apiKey: ctx.geminiKey,
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
