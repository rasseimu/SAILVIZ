// サーバ側の Gemini 呼び出し。APIキーはサーバ環境変数(GEMINI_API_KEY)に隠し、
// ブラウザには出さない。クライアントは /api/ai-comment 経由でここを叩く。
// parts はクライアントが組み立てたもの([{text}] / {inlineData:{mimeType,data}})をそのまま転送。
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 一時的なサーバ側エラー(過負荷/レート制限)。リトライ対象。
const RETRIABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function geminiGenerate({
  apiKey, model = 'gemini-3.6-flash', system = '', parts,
  fetchImpl = globalThis.fetch, temperature = 0.4, maxOutputTokens = 8192,
  responseMimeType = null, retries = 3,
}) {
  const url = `${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const generationConfig = { temperature, maxOutputTokens };
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let res;
  for (let attempt = 0; ; attempt += 1) {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    if (RETRIABLE.has(res.status) && attempt < retries) {
      await sleep(500 * 2 ** attempt); // 0.5s, 1s, 2s
      continue;
    }
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => typeof p.text === 'string')
    .map((p) => p.text).join('');
  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || '不明';
    throw new Error(`Gemini 応答に本文がありません(finishReason=${reason})`);
  }
  return text;
}
