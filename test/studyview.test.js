// test/studyview.test.js — プロ動画の勉強ページ(src/studyview.js)。最小の偽 DOM・偽フォルダ・偽 fetch で確かめる。合成データのみ。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStudyView } from '../src/studyview.js';

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this._text = ''; this.attrs = {};
    this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.listeners = {};
    this.title = ''; this.paused = true; this.src = '';
    const self = this;
    const set = () => new Set(self.className.split(' ').filter(Boolean));
    this.classList = {
      add(c) { const s = set(); s.add(c); self.className = [...s].join(' '); },
      toggle(c, on) { const s = set(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(' '); },
      contains(c) { return set().has(c); },
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  set innerHTML(_v) { throw new Error('innerHTML は使わない'); }
  append(...els) { this.children.push(...els); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = ''; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { return Promise.all((this.listeners[type] || []).map((fn) => fn({ type, preventDefault() {}, stopPropagation() {} }))); }
  click() { return this.disabled ? null : this.dispatch('click'); }
  focus() { this.ownerDocument.focused = this; }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  contains(e) { return e === this || this.all((x) => x === e).length > 0; }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  q(cls) { return this.all((e) => e.className.split(' ').includes(cls)); }
}
const IDS = ['study-status', 'study-comment-note', 'study-root', 'study-root-label', 'study-list', 'study-video', 'study-video-name',
  'study-player-empty', 'study-comments', 'study-comment-overlay'];
function mkDoc() {
  const doc = { createElement: (t) => new FakeEl(t, doc), createElementNS: (_ns, t) => new FakeEl(t, doc), els: {}, focused: null };
  for (const id of IDS) doc.els[id] = new FakeEl(id === 'study-video' ? 'video' : 'div', doc);
  doc.getElementById = (id) => doc.els[id];
  Object.defineProperty(doc, 'activeElement', { get: () => doc.focused });
  return doc;
}

// 偽フォルダ
const file = (name, size) => ({ kind: 'file', name, getFile: async () => ({ name, size, id: `${name}:${size}` }) });
const dir = (name, children = [], perms = {}) => ({
  kind: 'directory', name, values: async function* values() { for (const c of children) yield c; },
  queryPermission: async () => { perms.queries = (perms.queries || 0) + 1; return perms.state || 'granted'; },
  requestPermission: async () => { perms.requests = (perms.requests || 0) + 1; perms.state = perms.grant || 'granted'; return perms.state; },
});

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
let saved;
let urls;
let fetchCalls;
let fetchReply;
beforeEach(() => {
  saved = { fetch: globalThis.fetch, picker: globalThis.showDirectoryPicker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  urls = { made: [], revoked: [] };
  let n = 0;
  URL.createObjectURL = (f) => { const u = `blob:${++n}:${f.id}`; urls.made.push(u); return u; };
  URL.revokeObjectURL = (u) => { urls.revoked.push(u); };
  globalThis.showDirectoryPicker = async () => { throw new Error('テストでは呼ばない'); };
  fetchCalls = [];
  fetchReply = () => ({ ok: true, status: 200, json: async () => ({ comments: [], canWrite: true }) });
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return fetchReply(url, init); };
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.picker === undefined) delete globalThis.showDirectoryPicker; else globalThis.showDirectoryPicker = saved.picker;
  URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke;
});

// 動画の行(フォルダの行・上のフォルダへの行は除く)。
const items = (doc) => doc.els['study-list'].q('study-item')
  .filter((b) => !b.classList.contains('study-folder') && !b.classList.contains('study-up'));
const names = (doc) => items(doc).map((b) => b.q('study-item-name')[0].textContent);
const folders = (doc) => doc.els['study-list'].q('study-folder');
const folderNames = (doc) => folders(doc).map((b) => b.q('study-item-name')[0].textContent);
const ups = (doc) => doc.els['study-list'].q('study-up');
const crumbs = (doc) => doc.els['study-list'].q('study-crumbs').flatMap((ol) => ol.children.map((li) => li.textContent));
const folderNamed = (doc, name) => folders(doc).find((b) => b.q('study-item-name')[0].textContent === name);
// 最上段(動画ルート)から勉強用フォルダを開く。
const enter = async (doc, name) => { await folderNamed(doc, name).click(); await flush(); };
const enterPro = (doc) => enter(doc, 'プロ動画');
const crumbButton = (doc, label) => doc.els['study-list'].q('study-crumb').find((e) => e.tagName === 'BUTTON' && e.textContent === label);

test('開いただけでは権限ダイアログを出さない(query だけ)。許可が要れば「動画フォルダを許可」、押すと要求して走査する', async () => {
  const doc = mkDoc();
  const perms = { state: 'prompt' };
  const root = dir('練習動画', [dir('プロ動画', [file('clip01.mp4', 10)])], perms);
  const changed = [];
  const view = createStudyView({ doc, getRoot: () => root, onRootChanged: (d, p) => changed.push([d.name, p]) });
  await view.render(); await flush();
  assert.equal(perms.requests || 0, 0, 'requestPermission を呼ばない');
  assert.ok(perms.queries >= 1);
  assert.equal(doc.els['study-root'].hidden, false);
  assert.equal(doc.els['study-root'].dataset.action, 'grant');
  assert.equal(doc.els['study-root-label'].textContent, '動画フォルダを許可');
  assert.match(doc.els['study-status'].textContent, /許可/);
  assert.deepEqual(names(doc), []);
  await doc.els['study-root'].click(); await flush();
  assert.equal(perms.requests, 1);
  assert.deepEqual(changed, [['練習動画', 'granted']]);
  assert.deepEqual(folderNames(doc), ['プロ動画']);
  await enterPro(doc);
  assert.deepEqual(names(doc), ['clip01.mp4']);
  assert.equal(doc.els['study-status'].hidden, true);
});

test('動画ルートが 2026練習 で プロ動画 が無ければその旨を出す。未設定なら「動画フォルダを設定」', async () => {
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('2026練習', [dir('8 27(木)', [file('a.mp4', 1)])]) });
  await view.render(); await flush();
  assert.equal(doc.els['study-status'].textContent, 'プロ動画・コーチング(beta) フォルダが見つかりません(動画フォルダ「2026練習」の中に置いてください)');
  assert.equal(doc.els['study-root-label'].textContent, '動画フォルダを選び直す');
  assert.deepEqual(names(doc), []);

  const doc2 = mkDoc();
  // getRoot が null で IndexedDB も無い(テスト環境)→ 未設定
  const v2 = createStudyView({ doc: doc2, getRoot: () => null });
  await v2.render(); await flush();
  assert.equal(doc2.els['study-root-label'].textContent, '動画フォルダを設定');
  assert.equal(doc2.els['study-root'].dataset.action, 'choose');
});

test('一覧にコメント件数を出し、選ぶと再生。別の動画に切り替えたら前の blob URL を解放、画面を離れたら止めて解放する', async () => {
  fetchReply = () => ({ ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
    { id: 'vc_1', videoName: 'clip01.mp4', videoSize: 10, positionMs: 0, text: 'a', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
    { id: 'vc_2', videoName: 'clip01.mp4', videoSize: 10, positionMs: 1000, text: 'b', authorName: '乗員2', createdAt: 1, updatedAt: 1 },
    { id: 'vc_3', videoName: 'clip01.mp4', videoSize: 99, positionMs: 0, text: '別サイズ', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
  ] }) });
  const doc = mkDoc();
  const root = dir('練習動画', [dir('プロ動画', [file('clip02.mp4', 20), file('clip01.mp4', 10), dir('A大会', [file('a.mp4', 3)])])]);
  const view = createStudyView({ doc, getRoot: () => root });
  await view.render(); await flush();
  await enterPro(doc);
  assert.deepEqual(names(doc), ['clip01.mp4', 'clip02.mp4']);
  assert.deepEqual(folderNames(doc), ['A大会']);
  assert.deepEqual(items(doc).map((b) => b.q('study-count').map((e) => e.textContent).join('')), ['2', '']);
  assert.equal(doc.els['study-player-empty'].hidden, false);

  await items(doc)[0].click(); await flush();
  const vid = doc.els['study-video'];
  assert.equal(vid.src, urls.made[0]);
  assert.equal(vid.paused, false);
  assert.equal(doc.els['study-video-name'].textContent, 'プロ動画/clip01.mp4');
  assert.ok(items(doc)[0].classList.contains('active'));
  // コメント欄(②の部品)に、この動画(名前 + サイズ)のコメントだけが出る
  assert.equal(doc.els['study-comments'].classList.contains('hidden'), false);
  assert.deepEqual(doc.els['study-comments'].q('vc-text').map((e) => e.textContent), ['a', 'b']);

  await folders(doc)[0].click(); await flush();
  assert.deepEqual(names(doc), ['a.mp4']);
  await items(doc)[0].click(); await flush();
  assert.deepEqual(urls.revoked, [urls.made[0]]);
  assert.equal(vid.src, urls.made[1]);
  assert.equal(doc.els['study-video-name'].textContent, 'プロ動画/A大会/a.mp4');
  assert.deepEqual(doc.els['study-comments'].q('vc-text').map((e) => e.textContent), []);

  view.leave();
  assert.deepEqual(urls.revoked, [urls.made[0], urls.made[1]]);
  assert.equal(vid.paused, true);
  assert.equal(vid.src, '');
  assert.equal(doc.els['study-comments'].classList.contains('hidden'), true);
});

test('コメントを付けると POST /api/study-comments に名前 + サイズで送り、件数が増える', async () => {
  const list = [];
  fetchReply = (url, init) => {
    if (init?.method === 'POST') {
      const b = JSON.parse(init.body);
      const c = { id: `vc_${list.length + 1}`, ...b, authorName: '乗員1', createdAt: 1, updatedAt: 1, canEdit: true, canDelete: true };
      list.push(c);
      return { ok: true, status: 201, json: async () => c };
    }
    return { ok: true, status: 200, json: async () => ({ comments: [...list], canWrite: true }) };
  };
  const doc = mkDoc();
  const root = dir('練習動画', [dir('プロ動画', [file('clip01.mp4', 10)])]);
  const view = createStudyView({ doc, getRoot: () => root });
  await view.render(); await flush();
  await enterPro(doc);
  await items(doc)[0].click(); await flush();
  doc.els['study-video'].currentTime = 12.34;
  const panel = doc.els['study-comments'];
  await panel.q('vc-add')[0].click();
  panel.q('vc-input')[0].value = 'ここのタック';
  await panel.q('vc-send')[0].click(); await flush();
  const post = fetchCalls.find((c) => c.init?.method === 'POST');
  assert.equal(post.url, '/api/study-comments');
  assert.deepEqual(JSON.parse(post.init.body), { videoName: 'clip01.mp4', videoSize: 10, positionMs: 12_340, text: 'ここのタック' });
  assert.deepEqual(items(doc)[0].q('study-count').map((e) => e.textContent), ['1']);
  assert.deepEqual(panel.q('vc-text').map((e) => e.textContent), ['ここのタック']);
});

test('ファイル版(503)は「このサーバではコメントを使えません」で再生だけ。組織が無い(403 no_org)は「組織のメンバーだけが使えます」', async () => {
  const root = () => dir('練習動画', [dir('プロ動画', [file('clip01.mp4', 10)])]);
  fetchReply = () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable' } }) });
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: root });
  await view.render(); await flush();
  await enterPro(doc);
  assert.match(doc.els['study-comment-note'].textContent, /このサーバではコメントを使えません/);
  await items(doc)[0].click(); await flush();
  assert.equal(doc.els['study-video'].paused, false, '再生はできる');
  assert.equal(doc.els['study-comments'].classList.contains('hidden'), true, 'コメント欄は出さない');

  fetchReply = () => ({ ok: false, status: 403, clone() { return this; }, json: async () => ({ error: { code: 'no_org' } }) });
  const doc2 = mkDoc();
  const v2 = createStudyView({ doc: doc2, getRoot: root });
  await v2.render(); await flush();
  await enterPro(doc2);
  assert.equal(doc2.els['study-comment-note'].textContent, '組織のメンバーだけが使えます');
  await items(doc2)[0].click(); await flush();
  assert.equal(doc2.els['study-comments'].classList.contains('hidden'), false);
  assert.match(doc2.els['study-comments'].textContent, /組織のメンバーだけが使えます/);
  assert.equal(doc2.els['study-comments'].q('vc-add')[0].hidden, true, '書けない');
});

// getFile を手で終わらせられるファイル(読み直しの完了順を入れ替える)。
const slowFile = (name, size) => {
  const f = { kind: 'file', name, pending: [], scanned: false };
  f.getFile = () => {
    if (!f.scanned) { f.scanned = true; return Promise.resolve({ name, size, id: `${name}:${size}` }); } // 走査
    return new Promise((r) => f.pending.push(() => r({ name, size, id: `${name}:${size}` })));
  };
  return f;
};

test('素早く2本続けて選ぶと、読み直しの完了順に関係なく後に選んだ方を再生する', async () => {
  const doc = mkDoc();
  const f1 = slowFile('clip01.mp4', 10); const f2 = slowFile('clip02.mp4', 20);
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [f1, f2])]) });
  await view.render(); await flush();
  await enterPro(doc);
  items(doc)[0].click(); await flush();
  items(doc)[1].click(); await flush();
  f2.pending.shift()(); await flush(); // 後に選んだ方が先に終わる
  f1.pending.shift()(); await flush(); // 先に選んだ方が遅れて終わる → 捨てる
  assert.equal(doc.els['study-video-name'].textContent, 'プロ動画/clip02.mp4');
  assert.deepEqual(urls.made, [doc.els['study-video'].src]);
  assert.match(urls.made[0], /clip02/);
});

test('ファイルの読み直しを待つ間に画面を離れたら、その選択は捨てる', async () => {
  const doc = mkDoc();
  const f1 = slowFile('clip01.mp4', 10);
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [f1])]) });
  await view.render(); await flush();
  await enterPro(doc);
  items(doc)[0].click(); await flush();
  view.leave();
  f1.pending.shift()(); await flush();
  assert.deepEqual(urls.made, []);
  assert.equal(doc.els['study-video'].src, '');
  assert.equal(doc.els['study-video'].paused, true);
});

test('走査に失敗したら「読めませんでした」だけを出し、「動画がありません」は出さない', async () => {
  const doc = mkDoc();
  const broken = { kind: 'directory', name: 'プロ動画', values: async function* values() { throw new Error('読めない'); } };
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [broken]) });
  await view.render(); await flush();
  assert.match(doc.els['study-status'].textContent, /読めませんでした/);
  assert.doesNotMatch(doc.els['study-list'].textContent, /動画がありません/);
  assert.equal(doc.els['study-player-empty'].hidden, true);
});

test('選んだときにファイルのサイズが走査時と違えば、今のサイズで一覧とコメントを指し直す', async () => {
  fetchReply = (url, init) => {
    if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'vc_9' }) };
    return { ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
      { id: 'vc_1', videoName: 'clip01.mp4', videoSize: 10, positionMs: 0, text: '古いサイズ', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
      { id: 'vc_2', videoName: 'clip01.mp4', videoSize: 15, positionMs: 0, text: '新しいサイズ', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
    ] }) };
  };
  let size = 10;
  const f = { kind: 'file', name: 'clip01.mp4', getFile: async () => ({ name: 'clip01.mp4', size, id: `clip01:${size}` }) };
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [f])]) });
  await view.render(); await flush();
  await enterPro(doc);
  size = 15; // 走査の後に置き換わった
  await items(doc)[0].click(); await flush();
  const panel = doc.els['study-comments'];
  assert.deepEqual(panel.q('vc-text').map((e) => e.textContent), ['新しいサイズ']);
  assert.deepEqual(items(doc)[0].q('study-count').map((e) => e.textContent), ['1']);
  assert.ok(items(doc)[0].classList.contains('active'));
  await panel.q('vc-add')[0].click();
  panel.q('vc-input')[0].value = 'x';
  await panel.q('vc-send')[0].click(); await flush();
  assert.equal(JSON.parse(fetchCalls.find((c) => c.init?.method === 'POST').init.body).videoSize, 15);
});

// フォルダを開いて進む一覧(パンくず・上のフォルダへ・サブフォルダ)
const proTree = () => [
  file('top.mp4', 1),
  dir('B大会', [file('b.mp4', 5)]),
  dir('A大会', [file('a.mp4', 2), dir('2日目', [file('a2.mp4', 3), file('a3.mp4', 4)])]),
  dir('空', [file('メモ.txt'), dir('もっと空')]),
];
const proComments = () => ({ ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
  { id: 'vc_1', videoName: 'a2.mp4', videoSize: 3, positionMs: 0, text: 'x', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
  { id: 'vc_2', videoName: 'a2.mp4', videoSize: 3, positionMs: 1, text: 'y', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
  { id: 'vc_3', videoName: 'b.mp4', videoSize: 5, positionMs: 0, text: 'z', authorName: '乗員2', createdAt: 1, updatedAt: 1 },
] }) });

test('フォルダを押すと中身が出る。パンくず・上のフォルダへで戻れる。動画の無いフォルダは出さない', async () => {
  fetchReply = proComments;
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', proTree())]) });
  await view.render(); await flush();
  // 最上段(動画ルート): パンくずは 練習動画(今いる段)だけ。勉強用フォルダだけが出る
  assert.deepEqual(crumbs(doc), ['練習動画']);
  assert.equal(crumbButton(doc, '練習動画'), undefined, '今いる段は押せない');
  assert.equal(doc.els['study-list'].q('study-crumb-current')[0].attrs['aria-current'], 'location');
  assert.deepEqual(ups(doc), [], '最上段には「上のフォルダへ」が無い');
  assert.deepEqual(folderNames(doc), ['プロ動画']);
  assert.deepEqual(names(doc), []);
  await enterPro(doc);
  // プロ動画: 練習動画(押せる)› プロ動画(今いる段)
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画']);
  assert.ok(crumbButton(doc, '練習動画'));
  assert.equal(crumbButton(doc, 'プロ動画'), undefined, '今いる段は押せない');
  assert.equal(ups(doc).length, 1);
  assert.deepEqual(folderNames(doc), ['A大会', 'B大会'], '数値順・動画の無い「空」は出さない');
  assert.deepEqual(folders(doc).map((b) => b.q('study-folder-n')[0].textContent), ['3本', '1本']);
  assert.deepEqual(folders(doc).map((b) => b.q('study-count').map((e) => e.textContent).join('')), ['2', '1']);
  assert.ok(folders(doc).every((b) => b.tagName === 'BUTTON' && b.type === 'button'));
  assert.deepEqual(names(doc), ['top.mp4']);

  await folders(doc)[0].click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会']);
  assert.equal(ups(doc).length, 1);
  assert.deepEqual(folderNames(doc), ['2日目']);
  assert.deepEqual(names(doc), ['a.mp4']);

  await folders(doc)[0].click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会', '2日目']);
  assert.deepEqual(folderNames(doc), []);
  assert.deepEqual(names(doc), ['a2.mp4', 'a3.mp4']);

  // 上のフォルダへ → A大会(来たフォルダの行にフォーカス)
  await ups(doc)[0].click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会']);
  assert.equal(doc.focused, folders(doc)[0]);

  // パンくずの プロ動画 → 直下(来た A大会 の行にフォーカス)
  await folders(doc)[0].click(); await flush();
  await crumbButton(doc, 'プロ動画').click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画']);
  assert.deepEqual(names(doc), ['top.mp4']);
  assert.equal(doc.focused, folders(doc)[0]);
  assert.equal(folderNames(doc)[0], 'A大会');
  // パンくずの 練習動画 → 最上段(来た プロ動画 の行にフォーカス)
  await crumbButton(doc, '練習動画').click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画']);
  assert.equal(doc.focused, folderNamed(doc, 'プロ動画'));
});

test('動画ルート自体が プロ動画 なら、パンくずは プロ動画 から始まる', async () => {
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('プロ動画', proTree()) });
  await view.render(); await flush();
  assert.deepEqual(crumbs(doc), ['プロ動画']);
  await folders(doc)[0].click(); await flush();
  assert.deepEqual(crumbs(doc), ['プロ動画', 'A大会']);
  assert.ok(crumbButton(doc, 'プロ動画'));
});

test('再生中にフォルダを移っても止まらない。再生中の動画がある段に戻ると強調される', async () => {
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', proTree())]) });
  await view.render(); await flush();
  await enterPro(doc);
  await folders(doc)[0].click(); await flush(); // A大会
  await folders(doc)[0].click(); await flush(); // A大会/2日目
  await items(doc)[1].click(); await flush(); // a3.mp4
  const vid = doc.els['study-video'];
  const src = vid.src;
  assert.ok(items(doc)[1].classList.contains('active'));

  await crumbButton(doc, 'プロ動画').click(); await flush();
  assert.equal(vid.paused, false, '止めない');
  assert.equal(vid.src, src);
  assert.deepEqual(urls.revoked, []);
  assert.equal(doc.els['study-video-name'].textContent, 'プロ動画/A大会/2日目/a3.mp4');
  assert.ok(items(doc).every((b) => !b.classList.contains('active')), '直下の動画は強調しない');

  await folders(doc)[0].click(); await flush();
  await folders(doc)[0].click(); await flush();
  assert.deepEqual(items(doc).map((b) => b.classList.contains('active')), [false, true]);
  assert.equal(items(doc)[1].attrs['aria-current'], 'true');
  assert.equal(vid.paused, false);
});

test('開いていたフォルダは、別の画面から戻った・走査し直した後もまだあれば開く。無くなっていれば最上段', async () => {
  const children = proTree();
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', children)]) });
  await view.render(); await flush();
  await enterPro(doc);
  await folders(doc)[0].click(); await flush(); // A大会
  await folders(doc)[0].click(); await flush(); // A大会/2日目
  view.leave();
  await view.render(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会', '2日目']);
  assert.deepEqual(names(doc), ['a2.mp4', 'a3.mp4']);

  // A大会 を消して走査し直す → 最上段
  children.splice(children.findIndex((c) => c.name === 'A大会'), 1);
  view.leave();
  await view.render(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画']);
  assert.deepEqual(folderNames(doc), ['プロ動画']);
  await enterPro(doc);
  assert.deepEqual(folderNames(doc), ['B大会']);
});

test('勉強用フォルダの中に動画が1本も無ければ(空のフォルダだけでも)「プロ動画・コーチング(beta) フォルダに動画がありません」', async () => {
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [dir('空', [file('メモ.txt')]), file('x.txt')]), dir('コーチング(beta)'), file('root.mp4', 1)]) });
  await view.render(); await flush();
  assert.equal(doc.els['study-list'].q('study-empty')[0].textContent, 'プロ動画・コーチング(beta) フォルダに動画がありません');
  assert.deepEqual(folders(doc), []);
  assert.deepEqual(crumbs(doc), []);
  assert.equal(doc.els['study-player-empty'].hidden, true);
});

test('一覧を描き直しても(動画を選んだ後・コメント件数が返った後)、フォーカスは同じ行に戻る', async () => {
  let release;
  const counted = new Promise((r) => { release = r; });
  let first = true;
  fetchReply = async () => {
    if (first) { first = false; await counted; } // 最初の件数の読み込みだけ遅らせる
    return { ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
      { id: 'vc_1', videoName: 'clip02.mp4', videoSize: 20, positionMs: 0, text: 'a', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
    ] }) };
  };
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [file('clip01.mp4', 10), file('clip02.mp4', 20), dir('A大会', [file('a.mp4', 3)])])]) });
  await view.render(); await flush();
  await enterPro(doc);
  // 件数が返る前にフォルダの行へフォーカス → 件数が返って描き直しても同じ行
  folders(doc)[0].focus();
  const before = folders(doc)[0];
  release(); await flush();
  assert.deepEqual(items(doc)[1].q('study-count').map((e) => e.textContent), ['1'], '描き直された');
  assert.notEqual(folders(doc)[0], before);
  assert.equal(doc.focused, folders(doc)[0]);
  // 動画の行を押して選ぶ → 描き直した後も同じ動画の行
  items(doc)[1].focus();
  await items(doc)[1].click(); await flush();
  assert.ok(items(doc)[1].classList.contains('active'));
  assert.equal(doc.focused, items(doc)[1]);
  // パンくずのボタン・上のフォルダへも同じ(A大会 を開いて「上のフォルダへ」にフォーカス → 件数の読み直し)
  await folders(doc)[0].click(); await flush();
  ups(doc)[0].focus();
  await items(doc)[0].click(); await flush(); // a.mp4 を選ぶ(押しただけではフォーカスは動かない偽 DOM)
  assert.equal(doc.focused, ups(doc)[0]);
});

test('フォーカスが一覧の外(コメント入力中など)にあるときは、描き直してもフォーカスを奪わない', async () => {
  let release;
  const counted = new Promise((r) => { release = r; });
  fetchReply = async () => { await counted; return { ok: true, status: 200, json: async () => ({ canWrite: true, comments: [] }) }; };
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [file('clip01.mp4', 10), file('clip02.mp4', 20)])]) });
  await view.render(); await flush();
  await enterPro(doc);
  const outside = doc.els['study-comments'];
  outside.focus();
  await items(doc)[0].click(); await flush();
  assert.equal(doc.focused, outside, '動画を選んで描き直しても');
  release(); await flush();
  assert.equal(doc.focused, outside, 'コメント件数が返って描き直しても');
});

test('サブフォルダの動画のサイズが走査時と違えば、今のサイズで一覧とコメントを指し直す', async () => {
  fetchReply = (url, init) => {
    if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'vc_9' }) };
    return { ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
      { id: 'vc_1', videoName: 'a2.mp4', videoSize: 10, positionMs: 0, text: '古いサイズ', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
      { id: 'vc_2', videoName: 'a2.mp4', videoSize: 15, positionMs: 0, text: '新しいサイズ', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
    ] }) };
  };
  let size = 10;
  const f = { kind: 'file', name: 'a2.mp4', getFile: async () => ({ name: 'a2.mp4', size, id: `a2:${size}` }) };
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [dir('A大会', [dir('2日目', [f])])])]) });
  await view.render(); await flush();
  await enterPro(doc);
  await folders(doc)[0].click(); await flush();
  await folders(doc)[0].click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会', '2日目']);
  size = 15; // 走査の後に置き換わった
  await items(doc)[0].click(); await flush();
  const panel = doc.els['study-comments'];
  assert.ok(items(doc)[0].classList.contains('active'));
  assert.deepEqual(items(doc)[0].q('study-count').map((e) => e.textContent), ['1']);
  assert.deepEqual(panel.q('vc-text').map((e) => e.textContent), ['新しいサイズ']);
  assert.equal(doc.els['study-video-name'].textContent, 'プロ動画/A大会/2日目/a2.mp4');
  await panel.q('vc-add')[0].click();
  panel.q('vc-input')[0].value = 'x';
  await panel.q('vc-send')[0].click(); await flush();
  assert.equal(JSON.parse(fetchCalls.find((c) => c.init?.method === 'POST').init.body).videoSize, 15);
});

test('「動画フォルダを選び直す」で別のフォルダを選ぶと最上段へ。同じフォルダ・許可では開いていたフォルダを保つ', async () => {
  const perms = {};
  const root = dir('練習動画', [dir('プロ動画', proTree())], perms);
  root.isSameEntry = async (o) => o === root || o.sameAs === root;
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => root });
  await view.render(); await flush();
  await enterPro(doc);
  const openA = async () => { await folders(doc)[0].click(); await flush(); };
  await openA();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会']);
  assert.equal(doc.els['study-root'].dataset.action, 'choose');

  // 同じフォルダを選び直す(別のハンドルだが isSameEntry で同じ)→ 保つ
  const again = { ...dir('練習動画', [dir('プロ動画', proTree())]), sameAs: root };
  globalThis.showDirectoryPicker = async () => again;
  await doc.els['study-root'].click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画', 'プロ動画', 'A大会']);

  // 別のフォルダを選ぶ(中に同じ A大会 があっても)→ 直下
  globalThis.showDirectoryPicker = async () => dir('別の練習動画', [dir('プロ動画', proTree())]);
  await doc.els['study-root'].click(); await flush();
  assert.deepEqual(crumbs(doc), ['別の練習動画']);

  // 許可(grant)し直しでは保つ
  const perms2 = { state: 'prompt' };
  const root2 = dir('練習動画', [dir('プロ動画', proTree())], perms2);
  const doc2 = mkDoc();
  const v2 = createStudyView({ doc: doc2, getRoot: () => root2 });
  perms2.state = 'granted';
  await v2.render(); await flush();
  await enterPro(doc2);
  await folders(doc2)[0].click(); await flush();
  v2.leave();
  perms2.state = 'prompt';
  await v2.render(); await flush();
  assert.equal(doc2.els['study-root'].dataset.action, 'grant');
  await doc2.els['study-root'].click(); await flush();
  assert.equal(perms2.requests, 1);
  assert.deepEqual(crumbs(doc2), ['練習動画', 'プロ動画', 'A大会']);
});

// 勉強用フォルダが2つ(プロ動画・コーチング(beta))
test('最上段に プロ動画・コーチング(beta) を出し、コーチング(beta) を開いて再生 → パンくずの 練習動画 で最上段へ戻れる', async () => {
  fetchReply = () => ({ ok: true, status: 200, json: async () => ({ canWrite: true, comments: [
    { id: 'vc_1', videoName: 'c1.mp4', videoSize: 7, positionMs: 0, text: '講習のコメント', authorName: '乗員1', createdAt: 1, updatedAt: 1 },
  ] }) });
  const coachName = 'コーチング（beta）'; // 全角の括弧でも拾う。表示は実際の名前
  const root = dir('練習動画', [
    file('root.mp4', 99), dir('2026練習', [file('practice.mp4', 98)]),
    dir(coachName, [dir('講習1', [file('c1.mp4', 7)]), file('c0.mp4', 6)]),
    dir('プロ動画', proTree()),
  ]);
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => root });
  await view.render(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画']);
  assert.deepEqual(folderNames(doc), ['プロ動画', coachName], '定数の順。2026練習 は出さない');
  assert.deepEqual(names(doc), [], 'ルート直下の動画は出さない');
  assert.deepEqual(folders(doc).map((b) => b.q('study-folder-n')[0].textContent), ['5本', '2本']);
  assert.deepEqual(folders(doc).map((b) => b.q('study-count').map((e) => e.textContent).join('')), ['', '1']);

  await enter(doc, coachName);
  assert.deepEqual(crumbs(doc), ['練習動画', coachName]);
  assert.deepEqual(folderNames(doc), ['講習1']);
  assert.deepEqual(names(doc), ['c0.mp4']);
  await enter(doc, '講習1');
  await items(doc)[0].click(); await flush();
  const vid = doc.els['study-video'];
  assert.equal(vid.paused, false);
  assert.equal(doc.els['study-video-name'].textContent, `${coachName}/講習1/c1.mp4`);
  assert.deepEqual(doc.els['study-comments'].q('vc-text').map((e) => e.textContent), ['講習のコメント'], 'コメントは名前 + サイズで付く');

  await crumbButton(doc, '練習動画').click(); await flush();
  assert.deepEqual(crumbs(doc), ['練習動画']);
  assert.deepEqual(folderNames(doc), ['プロ動画', coachName]);
  assert.equal(doc.focused, folderNamed(doc, coachName), '来たフォルダの行にフォーカス');
  assert.equal(vid.paused, false, '再生は止めない');
});

test('勉強用フォルダが コーチング(beta) だけでも出す。ルート自体が コーチング(beta) ならそこから', async () => {
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('コーチング(beta)', [file('c0.mp4', 6)])]) });
  await view.render(); await flush();
  assert.equal(doc.els['study-status'].hidden, true);
  assert.deepEqual(folderNames(doc), ['コーチング(beta)']);

  const doc2 = mkDoc();
  const v2 = createStudyView({ doc: doc2, getRoot: () => dir('コーチング(beta)', [file('c0.mp4', 6), dir('講習1', [file('c1.mp4', 7)])]) });
  await v2.render(); await flush();
  assert.deepEqual(crumbs(doc2), ['コーチング(beta)']);
  assert.deepEqual(folderNames(doc2), ['講習1']);
  assert.deepEqual(names(doc2), ['c0.mp4']);
  await items(doc2)[0].click(); await flush();
  assert.equal(doc2.els['study-video-name'].textContent, 'c0.mp4');
});

test('選んだ動画のサイズが走査時と違っても、描き直した後のフォーカスは同じ動画の行に戻る', async () => {
  let size = 10;
  const f = { kind: 'file', name: 'clip01.mp4', getFile: async () => ({ name: 'clip01.mp4', size, id: `clip01:${size}` }) };
  const doc = mkDoc();
  const view = createStudyView({ doc, getRoot: () => dir('練習動画', [dir('プロ動画', [f, file('clip02.mp4', 20)])]) });
  await view.render(); await flush();
  await enterPro(doc);
  size = 15; // 走査の後に置き換わった
  items(doc)[0].focus();
  const before = items(doc)[0];
  await items(doc)[0].click(); await flush();
  assert.ok(items(doc)[0].classList.contains('active'));
  assert.notEqual(items(doc)[0], before, '描き直された');
  assert.equal(doc.focused, items(doc)[0]);
});
