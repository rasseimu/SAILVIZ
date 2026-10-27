// test/videocomments.test.js — 動画の瞬間コメント欄(src/videocomments.js)。最小の偽 DOM で操作を確かめる。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVideoComments } from '../src/videocomments.js';
import { practiceVideoMatch } from '../src/videocommentsmodel.js';

// ---- 最小の偽 DOM(このテストで使う分だけ) ----
class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this._text = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.listeners = {};
    const self = this;
    this.classList = {
      toggle(c, on) { const s = new Set(self.className.split(' ').filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(' '); },
      contains(c) { return self.className.split(' ').includes(c); },
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  set innerHTML(_v) { throw new Error('innerHTML は使わない'); }
  append(...els) { this.children.push(...els); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) {
    const e = { type, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...ev };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  click() { if (!this.disabled) return this.dispatch('click'); return null; }
  focus() {}
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  q(cls) { return this.all((e) => e.className.split(' ').includes(cls)); }
}
const mkDoc = () => { const doc = { createElement: (t) => new FakeEl(t, doc) }; return doc; };
const visible = (e) => !e.hidden;

function setup() {
  const doc = mkDoc();
  const root = new FakeEl('section', doc); root.className = 'hidden';
  const overlay = new FakeEl('div', doc); overlay.className = 'hidden';
  const video = new FakeEl('video', doc);
  video.currentTime = 0; video.duration = 120; video.paused = false;
  video.pause = () => { video.paused = true; };
  const confirms = [];
  const vc = createVideoComments({ root, overlayEl: overlay, videoEl: video, confirmFn: (m) => { confirms.push(m); return true; } });
  return { root, overlay, video, vc, confirms };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const cm = (id, positionMs, over = {}) => ({
  id, videoName: 'a.mp4', videoT: 1000, positionMs, text: `本文${id}`, authorName: '乗員1', createdAt: 0, canEdit: false, canDelete: false, ...over,
});
// 呼び出しを記録する source。
function mkSource(state) {
  const calls = [];
  return {
    calls,
    key: 'practice:pd_test',
    load: async () => { calls.push(['load']); if (state.fail) throw new Error('x'); return { comments: state.comments, canWrite: state.canWrite ?? true, unavailable: state.unavailable }; },
    create: (b) => { calls.push(['create', b]); return state.createP || Promise.resolve({}); },
    update: async (id, text) => { calls.push(['update', id, text]); },
    remove: async (id) => { calls.push(['remove', id]); },
  };
}
const video0 = { name: 'a.mp4', t: 1000 };

test('開いた動画のコメントを位置順に出し、選ぶとシークする。オーバーレイは位置〜4秒', async () => {
  const { root, overlay, video, vc } = setup();
  const st = { comments: [cm('b', 30_000), cm('x', 0, { videoName: 'other.mp4' }), cm('a', 10_000)] };
  vc.setTarget({ source: mkSource(st), match: practiceVideoMatch(video0) });
  await vc.refresh();
  assert.equal(root.classList.contains('hidden'), false);
  const items = root.q('vc-item');
  assert.deepEqual(items.map((li) => li.dataset.id), ['a', 'b']);
  assert.match(items[0].textContent, /^0:10乗員1本文a/);
  assert.equal(root.q('vc-count')[0].textContent, '2件');
  items[1].q('vc-jump')[0].click();
  assert.equal(video.currentTime, 30);
  video.dispatch('seeked');
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.match(overlay.textContent, /本文b/);
  video.currentTime = 34; video.dispatch('timeupdate');
  assert.equal(overlay.classList.contains('hidden'), true);
});

test('今の位置にコメント: 一時停止して位置を出し、送信は二重に送らない。Esc は取消だけで外に伝えない', async () => {
  const { root, video, vc } = setup();
  let resolve;
  const st = { comments: [], createP: new Promise((r) => { resolve = r; }) };
  const src = mkSource(st);
  vc.setTarget({ source: src, match: practiceVideoMatch(video0), linked: true });
  await vc.refresh();
  video.currentTime = 75.4;
  const add = root.q('vc-add')[0];
  assert.equal(visible(add), true);
  add.click();
  assert.equal(video.paused, true);
  const form = root.q('vc-form')[0];
  assert.equal(visible(form), true);
  assert.equal(form.q('vc-time')[0].textContent, '1:15');
  const input = form.q('vc-input')[0];
  const send = form.q('vc-send')[0];
  // 空は送らない
  send.click();
  assert.equal(src.calls.filter((c) => c[0] === 'create').length, 0);
  input.value = 'ここで体重移動';
  send.click(); send.click(); send.dispatch('click');
  const creates = src.calls.filter((c) => c[0] === 'create');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0][1], { positionMs: 75_400, text: 'ここで体重移動' });
  st.comments = [cm('n', 75_400)];
  resolve({});
  await flush(); await flush();
  assert.equal(visible(root.q('vc-form')[0]), false);
  assert.deepEqual(root.q('vc-item').map((li) => li.dataset.id), ['n']);
  // Esc
  add.click();
  const e = input.dispatch('keydown', { key: 'Escape' });
  assert.equal(e.propagationStopped, true);
  assert.equal(visible(root.q('vc-form')[0]), false);
});

test('書けない主体には入力ボタンを出さない。未リンクの動画では押せない', async () => {
  const { root, vc } = setup();
  vc.setTarget({ source: mkSource({ comments: [cm('a', 0)], canWrite: false }), match: practiceVideoMatch(video0) });
  await vc.refresh();
  assert.equal(visible(root.q('vc-add')[0]), false);
  assert.equal(root.q('vc-item').length, 1);
  vc.setTarget({ source: mkSource({ comments: [] }), match: practiceVideoMatch(video0), linked: false });
  await vc.refresh();
  assert.equal(visible(root.q('vc-add')[0]), true);
  assert.equal(root.q('vc-add')[0].disabled, true);
});

test('編集・削除は canEdit / canDelete に従い、削除は確認してから', async () => {
  const { root, vc, confirms } = setup();
  const st = { comments: [cm('mine', 0, { canEdit: true, canDelete: true }), cm('adm', 1000, { canDelete: true }), cm('other', 2000)] };
  const src = mkSource(st);
  vc.setTarget({ source: src, match: practiceVideoMatch(video0) });
  await vc.refresh();
  const [mine, adm, other] = root.q('vc-item');
  assert.equal(mine.q('vc-edit').length, 1);
  assert.equal(mine.q('vc-del').length, 1);
  assert.equal(adm.q('vc-edit').length, 0);
  assert.equal(adm.q('vc-del').length, 1);
  assert.equal(other.q('vc-edit').length + other.q('vc-del').length, 0);
  adm.q('vc-del')[0].click();
  await flush();
  assert.equal(confirms.length, 1);
  assert.deepEqual(src.calls.find((c) => c[0] === 'remove'), ['remove', 'adm']);
  // 編集
  root.q('vc-item')[0].q('vc-edit')[0].click();
  const li = root.q('vc-item')[0];
  li.q('vc-input')[0].value = '直した';
  li.q('vc-send')[0].click();
  await flush();
  assert.deepEqual(src.calls.find((c) => c[0] === 'update'), ['update', 'mine', '直した']);
});

test('未保存・読込失敗・使えないサーバ・取得中の切り替え', async () => {
  const { root, vc, overlay } = setup();
  vc.setTarget({ source: null, match: () => false, emptyMessage: '練習を保存するとコメントできます' });
  await vc.refresh();
  assert.equal(root.classList.contains('hidden'), false);
  assert.equal(root.q('vc-status-text')[0].textContent, '練習を保存するとコメントできます');
  assert.equal(visible(root.q('vc-add')[0]), false);
  // 読込失敗 → 再読込
  const st = { comments: [cm('a', 0)], fail: true };
  vc.setTarget({ source: mkSource(st), match: practiceVideoMatch(video0) });
  await vc.refresh();
  assert.equal(root.q('vc-status-text')[0].textContent, 'コメントを読み込めませんでした');
  const retry = root.q('vc-retry')[0];
  assert.equal(visible(retry), true);
  st.fail = false;
  retry.click();
  await flush();
  assert.equal(root.q('vc-item').length, 1);
  // 503 は欄ごと隠す
  vc.clear();
  vc.setTarget({ source: { ...mkSource({ comments: [], unavailable: true }), key: 'k2' }, match: () => true });
  await vc.refresh();
  assert.equal(root.classList.contains('hidden'), true);
  // 取得中に対象を外したら古い結果を出さない
  let release;
  const slow = { key: 'k3', load: () => new Promise((r) => { release = r; }) };
  vc.setTarget({ source: slow, match: () => true });
  const p = vc.refresh();
  vc.clear();
  release({ comments: [cm('late', 0)], canWrite: true });
  await p;
  assert.equal(root.classList.contains('hidden'), true);
  assert.equal(overlay.classList.contains('hidden'), true);
  vc.setTarget({ source: { ...slow, load: () => new Promise(() => {}) }, match: () => true });
  assert.equal(root.q('vc-item').length, 0, '捨てた結果は使い回さない');
});

test('preload した結果は同じ key の動画を開くとすぐ出る', async () => {
  const { root, vc } = setup();
  const st = { comments: [cm('a', 0)] };
  await vc.preload(mkSource(st));
  assert.equal(root.classList.contains('hidden'), true, '先読みでは欄を出さない');
  vc.setTarget({ source: { ...mkSource(st), load: () => new Promise(() => {}) }, match: practiceVideoMatch(video0) });
  assert.deepEqual(root.q('vc-item').map((li) => li.dataset.id), ['a']);
});

test('編集中の書きかけは、追加の送信・別コメントの削除で描き直されても残り、フォーカスは編集を始めたときだけ', async () => {
  const { root, vc } = setup();
  const st = { comments: [cm('mine', 0, { canEdit: true, canDelete: true }), cm('adm', 1000, { canDelete: true })] };
  vc.setTarget({ source: mkSource(st), match: practiceVideoMatch(video0), linked: true });
  await vc.refresh();
  const editFocus = [];
  const origFocus = FakeEl.prototype.focus;
  // 一覧の中の(編集の)入力欄へのフォーカスだけ数える
  FakeEl.prototype.focus = function () { if (root.q('vc-list')[0].all((e) => e === this).length) editFocus.push(this.value); };
  try {
    root.q('vc-item')[0].q('vc-edit')[0].click();
    await flush();
    assert.equal(editFocus.length, 1);
    const ta = () => root.q('vc-item')[0].q('vc-input')[0];
    ta().value = '書きかけ';
    ta().dispatch('input');
    // 新しいコメントを追加して送信する(読み直しで一覧が描き直される)
    root.q('vc-add')[0].click();
    root.q('vc-form')[0].q('vc-input')[0].value = '追加';
    root.q('vc-form')[0].q('vc-send')[0].click();
    await flush(); await flush();
    assert.equal(ta().value, '書きかけ');
    // 別のコメントを削除する
    root.q('vc-item')[1].q('vc-del')[0].click();
    await flush(); await flush();
    assert.equal(ta().value, '書きかけ');
    await flush();
    assert.equal(editFocus.length, 1, '描き直しでフォーカスを奪わない');
  } finally { FakeEl.prototype.focus = origFocus; }
});

test('一度 503 と分かったら、未保存の案内も含めて欄を出さない。未保存のときは probe で1回だけ確かめる', async () => {
  const { root, vc } = setup();
  let probes = 0;
  const probe = async () => { probes += 1; return false; };
  const unsaved = () => ({ source: null, match: () => false, emptyMessage: '練習を保存するとコメントできます', probe });
  vc.setTarget(unsaved());
  await flush();
  assert.equal(probes, 1);
  assert.equal(root.classList.contains('hidden'), true);
  vc.setTarget(unsaved());
  await flush();
  assert.equal(probes, 1, '確かめるのは1回だけ');
  assert.equal(root.classList.contains('hidden'), true);

  // load の unavailable で分かった場合も同じ(probe なし)
  const b = setup();
  b.vc.setTarget({ source: mkSource({ comments: [], unavailable: true }), match: () => true });
  await b.vc.refresh();
  b.vc.clear();
  b.vc.setTarget({ source: null, match: () => false, emptyMessage: '練習を保存するとコメントできます' });
  assert.equal(b.root.classList.contains('hidden'), true);

  // 使えるサーバ(probe が true)なら案内を出す
  const c = setup();
  c.vc.setTarget({ source: null, match: () => false, emptyMessage: '練習を保存するとコメントできます', probe: async () => true });
  await flush();
  assert.equal(c.root.classList.contains('hidden'), false);
  assert.equal(c.root.q('vc-status-text')[0].textContent, '練習を保存するとコメントできます');
});

test('オーバーレイは表示中のコメントが前回と同じなら DOM に触らない', async () => {
  const { overlay, video, vc } = setup();
  vc.setTarget({ source: mkSource({ comments: [cm('a', 1000)] }), match: practiceVideoMatch(video0) });
  await vc.refresh();
  video.currentTime = 1.5; video.dispatch('timeupdate');
  const first = overlay.children[0];
  assert.ok(first);
  video.currentTime = 2.5; video.dispatch('timeupdate');
  assert.equal(overlay.children[0], first, '同じ要素のまま');
  video.currentTime = 9; video.dispatch('timeupdate');
  assert.equal(overlay.children.length, 0);
});

test('送信中に同じ動画を開き直しても、保存できたら読み直す', async () => {
  const { root, vc } = setup();
  let resolve;
  const st = { comments: [], createP: new Promise((r) => { resolve = r; }) };
  const src = mkSource(st);
  vc.setTarget({ source: src, match: practiceVideoMatch(video0) });
  await vc.refresh();
  root.q('vc-add')[0].click();
  root.q('vc-form')[0].q('vc-input')[0].value = '送る';
  root.q('vc-form')[0].q('vc-send')[0].click();
  // 開き直し(app.js は動画を開くたびに source を作り直す)
  const src2 = mkSource(st);
  vc.setTarget({ source: src2, match: practiceVideoMatch(video0) });
  await vc.refresh();
  st.comments = [cm('new', 0)];
  const loadsBefore = src2.calls.filter((c) => c[0] === 'load').length;
  resolve({});
  await flush(); await flush();
  assert.equal(src2.calls.filter((c) => c[0] === 'load').length, loadsBefore + 1);
  assert.deepEqual(root.q('vc-item').map((li) => li.dataset.id), ['new']);
});

test('削除の失敗は描き直しても残す。404(ほかの人が先に削除)は読み直す', async () => {
  const { root, video, vc } = setup();
  const st = { comments: [cm('a', 0, { canDelete: true }), cm('b', 1000, { canDelete: true })] };
  const src = mkSource(st);
  let fail = { status: 500, message: '削除に失敗 (500)' };
  src.remove = async (id) => { src.calls.push(['remove', id]); if (fail) throw Object.assign(new Error(fail.message), { status: fail.status }); };
  vc.setTarget({ source: src, match: practiceVideoMatch(video0) });
  await vc.refresh();
  root.q('vc-item')[0].q('vc-del')[0].click();
  await flush();
  const text = () => root.q('vc-status-text')[0].textContent;
  assert.equal(text(), '削除に失敗 (500)');
  video.dispatch('seeked');
  await vc.refresh();
  assert.equal(text(), '削除に失敗 (500)', '描き直しで消さない');
  assert.equal(visible(root.q('vc-status')[0]), true);
  // 404 は読み直す
  fail = { status: 404, message: 'x' };
  st.comments = [cm('b', 1000, { canDelete: true })];
  const loads = src.calls.filter((c) => c[0] === 'load').length;
  root.q('vc-item')[0].q('vc-del')[0].click();
  await flush(); await flush();
  assert.equal(src.calls.filter((c) => c[0] === 'load').length, loads + 1);
  assert.deepEqual(root.q('vc-item').map((li) => li.dataset.id), ['b']);
  assert.notEqual(text(), '削除に失敗 (500)');
});
