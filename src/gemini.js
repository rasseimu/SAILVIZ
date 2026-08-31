// Gemini API(Google AI Studio)の generateContent をブラウザから直接呼ぶ薄いラッパ。
// PDF は inline_data(base64) として parts に載せられる。fetch は注入可能(テスト用)。
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// parts: [{ text }] や { inlineData: { mimeType, data } } の配列。
// 戻り値は候補テキストを結合した文字列。HTTPエラーは例外。
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
  // responseMimeType='application/json' で構造化出力を強制(散文/コードフェンス混入を防ぐ)。
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
    // 過負荷(503)等は指数バックオフで再試行。それ以外/上限到達は即エラー。
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
  // thinkingモデルが本文を返さない場合(トークン切れ等)の診断を明示。
  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || '不明';
    throw new Error(`Gemini 応答に本文がありません(finishReason=${reason})`);
  }
  return text;
}

// PDF(base64)を inline parts 要素にする。
export function pdfPart(base64) {
  return { inlineData: { mimeType: 'application/pdf', data: base64 } };
}
