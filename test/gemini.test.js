import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiGenerate, pdfPart } from '../src/gemini.js';

test('pdfPart: inlineData(application/pdf)を作る', () => {
  assert.deepEqual(pdfPart('BASE64'), { inlineData: { mimeType: 'application/pdf', data: 'BASE64' } });
});

test('geminiGenerate: /api/ai-comment へ same-origin POST し text を返す', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ text: 'こたえ' }) };
  };
  const out = await geminiGenerate({
    model: 'gemini-3.6-flash', system: 'sys', parts: [{ text: 'hello' }], fetchImpl,
  });
  assert.equal(out, 'こたえ');
  assert.equal(seen.url, '/api/ai-comment');
  assert.equal(seen.opts.credentials, 'same-origin');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.parts, [{ text: 'hello' }]);
  assert.equal('apiKey' in body, false); // キーはクライアントから送らない
});

test('geminiGenerate: 非2xxはサーバのerror文言で例外', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
  await assert.rejects(geminiGenerate({ parts: [{ text: 'x' }], fetchImpl }), /unauthorized/);
});
