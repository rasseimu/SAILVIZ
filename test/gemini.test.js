import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiGenerate, pdfPart } from '../src/gemini.js';

test('pdfPart: inlineData(application/pdf)を作る', () => {
  assert.deepEqual(pdfPart('BASE64'), { inlineData: { mimeType: 'application/pdf', data: 'BASE64' } });
});

test('geminiGenerate: 正しいURL/本文でPOSTし候補テキストを返す', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'こたえ' }] } }] }),
      text: async () => 'ok',
    };
  };
  const out = await geminiGenerate({
    apiKey: 'g-key', model: 'gemini-3.6-flash', system: 'sys',
    parts: [{ text: 'hello' }], fetchImpl,
  });
  assert.equal(out, 'こたえ');
  assert.match(seen.url, /models\/gemini-3\.6-flash:generateContent\?key=g-key/);
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(body.contents[0].parts, [{ text: 'hello' }]);
});

test('geminiGenerate: HTTPエラーは例外', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad', json: async () => ({}) });
  await assert.rejects(geminiGenerate({ apiKey: 'k', parts: [{ text: 'x' }], fetchImpl }));
});
