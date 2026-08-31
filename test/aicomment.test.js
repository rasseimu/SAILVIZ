import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScreenPrompt, parseScreen, buildGroundPrompt, parseGroundObject,
  generateAiComments,
} from '../src/aicomment.js';

const sources = [
  { id: 'ch19', title: 'スタート', summary: 'スタート戦術', link: 'https://x/19.html', pdf: 'p/19.pdf' },
  { id: 'ch11', title: '微風のランニング', summary: '微風風下', link: 'https://x/11.html', pdf: 'p/11.pdf' },
  { id: 'video-junpu', title: '順風動画', summary: '順風の実演', link: null, pdf: 'p/v.pdf' },
];

test('buildScreenPrompt: ソースと反省を本文に含める／複数選択を許可', () => {
  const { system, user } = buildScreenPrompt(
    [{ reflId: 'r1', field: 'issue', text: 'スタートで出遅れる' }], sources);
  assert.match(system, /セーリング|コーチ/);
  assert.match(user, /スタートで出遅れる/);
  assert.match(user, /ch19/);
  assert.match(user, /最大3つ/);   // 複数ソース許可の指示
});

test('parseScreen: 存在するsourceId・正しいfieldのみ採用(複数行OK)', () => {
  const raw = JSON.stringify([
    { reflId: 'r1', field: 'issue', sourceId: 'ch19' },
    { reflId: 'r1', field: 'issue', sourceId: 'ch11' },  // 同一反省に複数ソース
    { reflId: 'r2', field: 'goal', sourceId: 'ch999' },  // 存在しないid → 除外
    { reflId: 'r3', field: 'bogus', sourceId: 'ch11' },  // 不正field → 除外
  ]);
  assert.deepEqual(parseScreen(raw, sources), [
    { reflId: 'r1', field: 'issue', sourceId: 'ch19' },
    { reflId: 'r1', field: 'issue', sourceId: 'ch11' },
  ]);
});

test('buildGroundPrompt: 反省とソース一覧を含む／詳細化を指示', () => {
  const { system, user } = buildGroundPrompt(
    { field: 'issue', text: '出遅れ' },
    [{ id: 'ch19', title: 'スタート' }, { id: 'ch11', title: '微風のランニング' }]);
  assert.match(system, /3〜5文/);
  assert.match(user, /出遅れ/);
  assert.match(user, /ch19/);
  assert.match(user, /ch11/);
});

test('parseGroundObject: comment非空＋usedSourceIdsを返す', () => {
  const raw = JSON.stringify({ comment: 'ウエイティングラインを意識し早めに加速する。', usedSourceIds: ['ch19', 'ch11'] });
  assert.deepEqual(parseGroundObject(raw), { comment: 'ウエイティングラインを意識し早めに加速する。', usedSourceIds: ['ch19', 'ch11'] });
});

test('parseGroundObject: comment空はnull', () => {
  assert.equal(parseGroundObject(JSON.stringify({ comment: '', usedSourceIds: [] })), null);
});

test('parseGroundObject: 非JSONは例外', () => {
  assert.throws(() => parseGroundObject('これはJSONではない'));
});

// generateAiComments: fetch と loadPdfBase64 をモックし、複数ソース→詳細コメント＋複数出典を検証。
test('generateAiComments: 複数ソースをまとめて根拠付けし出典配列を返す', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const bodyStr = opts.body;
    const hasPdf = bodyStr.includes('inlineData');
    calls.push({ hasPdf });
    const text = hasPdf
      ? JSON.stringify({ comment: '出艇を早め、微風では上って走る。', usedSourceIds: ['ch19', 'ch11'] })
      : JSON.stringify([
        { reflId: 'r1', field: 'issue', sourceId: 'ch19' },
        { reflId: 'r1', field: 'issue', sourceId: 'ch11' },
      ]);
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      text: async () => text,
    };
  };
  const loadedPdfs = [];
  const out = await generateAiComments({
    items: [{ reflId: 'r1', field: 'issue', text: 'スタート出遅れ' }],
    sources, apiKey: 'g-key',
    loadPdfBase64: async (p) => { loadedPdfs.push(p); return `B64:${p}`; },
    fetchImpl,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].comment, '出艇を早め、微風では上って走る。');
  assert.deepEqual(out[0].refs, [
    { link: 'https://x/19.html', title: 'スタート' },
    { link: 'https://x/11.html', title: '微風のランニング' },
  ]);
  assert.equal(out[0].url, 'ai:r1:issue:ch11,ch19'); // 使用ソートで安定キー
  // スクリーニング1回＋根拠付け1回(2PDFまとめ)
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hasPdf, false);
  assert.equal(calls[1].hasPdf, true);
  assert.deepEqual(loadedPdfs, ['p/19.pdf', 'p/11.pdf']); // 両PDFを読み込む
});

test('generateAiComments: usedSourceIds空なら渡した全ソースを出典にする', async () => {
  const fetchImpl = async (url, opts) => {
    const hasPdf = opts.body.includes('inlineData');
    const text = hasPdf
      ? JSON.stringify({ comment: '基本を確認。', usedSourceIds: [] })
      : JSON.stringify([{ reflId: 'r1', field: 'goal', sourceId: 'ch19' }]);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text };
  };
  const out = await generateAiComments({
    items: [{ reflId: 'r1', field: 'goal', text: '安定して走る' }],
    sources, apiKey: 'k', loadPdfBase64: async () => 'B64', fetchImpl,
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].refs, [{ link: 'https://x/19.html', title: 'スタート' }]);
});

test('generateAiComments: apiKey空やitems空は[]', async () => {
  const never = async () => { throw new Error('呼んではいけない'); };
  assert.deepEqual(await generateAiComments({ items: [], sources, apiKey: 'k', loadPdfBase64: never, fetchImpl: never }), []);
  assert.deepEqual(await generateAiComments({ items: [{ reflId: 'r', field: 'goal', text: 'x' }], sources, apiKey: '', loadPdfBase64: never, fetchImpl: never }), []);
});

test('generateAiComments: 全PDF読込失敗の反省はスキップ(全体は止めない)', async () => {
  const fetchImpl = async (url, opts) => {
    const hasPdf = opts.body.includes('inlineData');
    const text = JSON.stringify([{ reflId: 'r1', field: 'issue', sourceId: 'ch19' }]);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: hasPdf ? '{}' : text }] } }] }), text: async () => text };
  };
  const out = await generateAiComments({
    items: [{ reflId: 'r1', field: 'issue', text: 't' }],
    sources, apiKey: 'k', loadPdfBase64: async () => { throw new Error('PDFなし'); }, fetchImpl,
  });
  assert.deepEqual(out, []);
});
