// クライアントは Gemini を直接叩かず、自サーバの /api/ai-comment 経由で呼ぶ。
// APIキーはサーバ環境変数(GEMINI_API_KEY)に隠され、ブラウザには出さない。
// 課金保護のためサーバ側で編集モード(認証)必須(same-origin Cookie を送る)。
// parts: [{ text }] や { inlineData: { mimeType, data } } の配列。戻り値は生成テキスト。
export async function geminiGenerate({
  model, system, parts, temperature, maxOutputTokens, responseMimeType,
  fetchImpl = globalThis.fetch,
}) {
  const res = await fetchImpl('/api/ai-comment', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, system, parts, temperature, maxOutputTokens, responseMimeType }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `AIコメント生成に失敗しました (${res.status})`);
  }
  return (await res.json()).text;
}

// PDF(base64)を inline parts 要素にする。
export function pdfPart(base64) {
  return { inlineData: { mimeType: 'application/pdf', data: base64 } };
}
