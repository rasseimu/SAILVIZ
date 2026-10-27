// 動画の瞬間コメント欄(②練習動画。③勉強動画でも同じ部品を使う)。
//   createVideoComments({ root, overlayEl, videoEl }) → { setTarget, refresh, preload, clear }
//   setTarget({ source, match, emptyMessage, linked } | null)
//     source: { key?, load() → { comments, canWrite, unavailable }, create({ positionMs, text }), update(id, text), remove(id) }
//             create は開いている動画に付ける(source は動画ごとに作る)。load は同じ key の source で共有してよい
//             (練習の全動画ぶんを読み、match で絞る)。key が同じなら読んだ結果を使い回す(無ければ source そのもので比べる)。
//     match:  コメント → 開いている動画のものか(練習は practiceVideoMatch、③は name + size)
//     emptyMessage: あればコメントを読まずにこの文言だけ出す(未保存の練習など)
//     linked: false なら動画が再生できないので「今の位置にコメント」を押せない
//     probe: 省略可。emptyMessage のときに、このサーバでコメントを使えるか(true/false)を1回だけ確かめる関数
//   一度でも「使えない」(load の unavailable・probe の false)と分かったら、以後は欄ごと出さない(emptyMessage も)。
//   refresh(): 今の source から読み直す。preload(source): 欄を出さずに先に読んでおく(同じ source を開いたらすぐ出す)。
//   clear(): 読んだコメントを捨てて欄を隠す(練習を閉じた・切り替えた)。
// 文字はすべて textContent で入れる(innerHTML を使わない)。オーバーレイは pointer-events:none(CSS)で動画の操作を妨げない。
// 一覧から選ぶと videoEl.currentTime を動かすだけ。GPS の追従は呼び出し側の seeked の処理に任せる。
import { formatVideoPos } from './reflections.js';
import {
  commentsForVideo, activeCommentsAt, validateDraft, positionMsOf, seekTimeFor, formatCommentDate, MAX_COMMENT_TEXT,
} from './videocommentsmodel.js';

export function createVideoComments({ root, overlayEl, videoEl, confirmFn = (m) => globalThis.confirm(m) }) {
  const doc = root.ownerDocument;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (cls, text, title) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  };

  // ---- 骨組み(1回だけ作る) ----
  root.textContent = '';
  const head = el('div', 'vc-head');
  const title = el('span', 'vc-title', 'コメント');
  const count = el('span', 'vc-count');
  const addBtn = btn('vc-add', '今の位置にコメント', '動画を止めて、今の再生位置にコメントを付ける');
  head.append(title, count, addBtn);

  const form = el('div', 'vc-form');
  const formPos = el('span', 'vc-time');
  const input = el('textarea', 'vc-input');
  input.rows = 2;
  input.maxLength = MAX_COMMENT_TEXT;
  input.placeholder = 'この瞬間へのコメント';
  const sendBtn = btn('vc-send', '送信');
  const cancelBtn = btn('vc-cancel', '取消');
  const formMsg = el('span', 'vc-msg');
  const formBtns = el('div', 'vc-form-btns');
  formBtns.append(formMsg, cancelBtn, sendBtn);
  form.append(formPos, input, formBtns);
  form.hidden = true;

  const status = el('div', 'vc-status');
  const statusText = el('span', 'vc-status-text');
  const retryBtn = btn('vc-retry', '再読込');
  retryBtn.hidden = true;
  status.append(statusText, retryBtn);

  const list = el('ul', 'vc-list');
  root.append(head, form, status, list);
  if (overlayEl) overlayEl.textContent = '';

  // ---- 状態 ----
  let target = null;
  let cache = null; // { source, comments, canWrite, unavailable }
  let phase = 'idle'; // idle | loading | ready | error
  let seq = 0; // 読み込みの世代(古い結果を捨てる)
  let draft = null; // { positionMs }
  let sending = false;
  let editing = null; // { id, text(書きかけ), msg, sending, focus(次の描画で入力欄に移す) }
  let notice = ''; // 操作の失敗(削除など)。描き直しても消さない。対象が変わるか次の操作で消す
  let available = null; // このサーバでコメントを使えるか(null = まだ分からない)
  let probing = false;
  let overlayKey = ''; // オーバーレイに出しているコメント(id@updatedAt の並び)

  const keyOf = (src) => (src && src.key != null ? src.key : src);
  const cached = () => !!target && !!cache && keyOf(cache.source) === keyOf(target.source);
  const forVideo = () => (cached() ? commentsForVideo(cache.comments, target.match) : []);

  function setVisible(v) { root.classList.toggle('hidden', !v); }

  function renderOverlay() {
    if (!overlayEl) return;
    const shown = target && !target.emptyMessage && cached() && !cache.unavailable
      ? activeCommentsAt(forVideo(), positionMsOf(videoEl.currentTime))
      : [];
    const key = shown.map((c) => `${c.id}@${c.updatedAt}`).join('|');
    if (key === overlayKey) return; // 前回と同じなら DOM に触らない
    overlayKey = key;
    overlayEl.textContent = '';
    for (const c of shown) {
      const line = el('div', 'vc-ov-item');
      line.append(el('span', 'vc-ov-author', c.authorName || ''), el('span', 'vc-ov-text', c.text));
      overlayEl.append(line);
    }
    overlayEl.classList.toggle('hidden', shown.length === 0);
  }

  function renderItem(c) {
    const li = el('li', 'vc-item');
    li.dataset.id = c.id;
    if (editing?.id === c.id) {
      const ta = el('textarea', 'vc-input');
      ta.rows = 2;
      ta.maxLength = MAX_COMMENT_TEXT;
      ta.value = editing.text;
      ta.addEventListener('input', () => { if (editing?.id === c.id) editing.text = ta.value; });
      const msg = el('span', 'vc-msg', editing.msg);
      const save = btn('vc-send', '保存');
      const cancel = btn('vc-cancel', '取消');
      save.disabled = !!editing.sending;
      const done = () => { editing = null; renderList(); };
      cancel.addEventListener('click', done);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
      });
      save.addEventListener('click', async () => {
        const ed = editing;
        if (!ed || ed.id !== c.id || ed.sending) return;
        ed.text = ta.value;
        const bad = validateDraft(ed.text);
        if (bad) { ed.msg = bad; msg.textContent = bad; return; }
        ed.sending = true; save.disabled = true; ed.msg = '保存中…'; msg.textContent = ed.msg;
        try {
          await target.source.update(c.id, ed.text);
          if (editing === ed) editing = null;
          await refresh();
        } catch (e) {
          ed.sending = false; ed.msg = e?.message || '保存に失敗しました';
          if (editing === ed) renderList();
        }
      });
      const row = el('div', 'vc-form-btns');
      row.append(msg, cancel, save);
      li.append(el('span', 'vc-time', formatVideoPos(c.positionMs)), ta, row);
      // フォーカスは編集を始めたときだけ(描き直しで奪わない)。
      if (editing.focus) { editing.focus = false; queueMicrotask(() => ta.focus()); }
      return li;
    }
    const jump = btn('vc-jump', null, 'この位置へ移動');
    jump.append(
      el('span', 'vc-time', formatVideoPos(c.positionMs)),
      el('span', 'vc-author', c.authorName || ''),
      el('span', 'vc-text', c.text),
    );
    jump.addEventListener('click', () => {
      videoEl.currentTime = seekTimeFor(c.positionMs, videoEl.duration);
    });
    const meta = el('div', 'vc-meta');
    meta.append(el('span', 'vc-date', formatCommentDate(c.createdAt)));
    if (c.canEdit) {
      const ed = btn('vc-edit', '編集');
      ed.addEventListener('click', () => {
        editing = { id: c.id, text: c.text, msg: '', sending: false, focus: true };
        renderList();
      });
      meta.append(ed);
    }
    if (c.canDelete) {
      const del = btn('vc-del', '削除');
      del.addEventListener('click', async () => {
        if (!confirmFn('このコメントを削除しますか？')) return;
        del.disabled = true;
        notice = '';
        const t0 = target;
        try {
          await t0.source.remove(c.id);
          await refresh();
        } catch (e) {
          if (target !== t0) return;
          if (e?.status === 404) { await refresh(); return; } // ほかの人が先に消した
          notice = e?.message || '削除に失敗しました';
          render();
        }
      });
      meta.append(del);
    }
    li.append(jump, meta);
    return li;
  }

  function renderList() {
    list.textContent = '';
    for (const c of forVideo()) list.append(renderItem(c));
  }

  function render() {
    if (!target || available === false) { setVisible(false); renderOverlay(); return; }
    const ready = cached();
    if (ready && cache.unavailable) { setVisible(false); renderOverlay(); return; }
    setVisible(true);
    const writable = !target.emptyMessage && ready && cache.canWrite;
    addBtn.hidden = !writable;
    addBtn.disabled = target.linked === false || !!draft;
    form.hidden = !writable || !draft;
    if (!form.hidden) {
      formPos.textContent = formatVideoPos(draft.positionMs);
      sendBtn.disabled = sending;
    }
    retryBtn.hidden = true;
    status.hidden = false;
    if (target.emptyMessage) {
      statusText.textContent = target.emptyMessage;
      count.textContent = '';
      list.textContent = '';
      renderOverlay();
      return;
    }
    const items = forVideo();
    count.textContent = ready ? `${items.length}件` : '';
    if (phase === 'error' && !ready) {
      statusText.textContent = 'コメントを読み込めませんでした';
      retryBtn.hidden = false;
    } else if (!ready) {
      statusText.textContent = '読込中…';
    } else if (!items.length) {
      statusText.textContent = 'この動画にはまだコメントがありません';
    } else {
      status.hidden = true;
      statusText.textContent = '';
    }
    if (notice) { status.hidden = false; statusText.textContent = notice; }
    renderList();
    renderOverlay();
  }

  // 読んだ結果を覚える。使えない(503)と分かったら以後は欄を出さない。
  function store(source, r) {
    cache = {
      source, comments: Array.isArray(r?.comments) ? r.comments : [], canWrite: r?.canWrite === true, unavailable: !!r?.unavailable,
    };
    if (cache.unavailable) available = false;
    else if (available === null) available = true;
    phase = 'ready';
  }

  async function loadInto(source) {
    const my = ++seq;
    phase = 'loading';
    render();
    try {
      const r = await source.load();
      if (my !== seq) return; // 途中で練習・動画が変わった
      store(source, r);
    } catch {
      if (my !== seq) return;
      // 読めなかったときは前の結果を捨てて「再読込」を出す(古い一覧を新しいものに見せない)。
      if (cache && keyOf(cache.source) === keyOf(source)) cache = null;
      phase = 'error';
    }
    render();
  }

  function closeForm() {
    draft = null; sending = false; input.value = ''; formMsg.textContent = '';
    render();
  }

  // ---- 操作 ----
  addBtn.addEventListener('click', () => {
    if (!target || target.linked === false) return;
    videoEl.pause();
    draft = { positionMs: positionMsOf(videoEl.currentTime) };
    formMsg.textContent = '';
    render();
    input.focus();
  });
  cancelBtn.addEventListener('click', closeForm);
  // Esc は入力の取消だけ(パネルを閉じる全体の Esc に渡さない)。
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm(); }
  });
  sendBtn.addEventListener('click', async () => {
    if (!target || !draft || sending) return;
    const bad = validateDraft(input.value);
    if (bad) { formMsg.textContent = bad; return; }
    const source = target.source;
    sending = true; sendBtn.disabled = true; formMsg.textContent = '送信中…';
    notice = '';
    try {
      await source.create({ positionMs: draft.positionMs, text: input.value });
      // 送信中に同じ動画を開き直していても、保存できたら必ず読み直す(下書きは開き直しで捨てている)。
      if (target?.source === source) closeForm(); else sending = false;
      await refresh();
    } catch (e) {
      sending = false;
      if (target?.source !== source) return;
      sendBtn.disabled = false;
      formMsg.textContent = e?.message || '送信に失敗しました';
    }
  });
  retryBtn.addEventListener('click', () => { refresh(); });
  videoEl.addEventListener('timeupdate', renderOverlay);
  videoEl.addEventListener('seeked', renderOverlay);

  // 対象が変わったら入力中の下書き・編集はやめる(位置は前の動画のもの)。
  function setTarget(t) {
    if (t && t === target) { render(); return; }
    target = t || null;
    editing = null; draft = null; sending = false; input.value = ''; formMsg.textContent = ''; notice = '';
    if (!target) seq++; // 読み込み中の結果は捨てる
    if (!cached()) phase = 'idle';
    render();
    if (target?.emptyMessage && available === null && !probing && typeof target.probe === 'function') probe(target.probe);
  }
  // 使えるかを1回だけ確かめる(未保存の練習ではコメントを読まないので、ファイル版でも案内を出してしまうため)。
  async function probe(fn) {
    probing = true;
    try {
      const ok = await fn();
      if (available === null && typeof ok === 'boolean') available = ok;
    } catch { /* 分からなければ案内を出したまま */ }
    probing = false;
    render();
  }
  function refresh() {
    if (!target || target.emptyMessage) { render(); return Promise.resolve(); }
    return loadInto(target.source);
  }
  function preload(source) {
    if (!source || target) return Promise.resolve();
    const my = ++seq;
    return Promise.resolve().then(() => source.load()).then((r) => {
      if (my !== seq) return;
      store(source, r);
      render();
    }, () => { /* 先読みの失敗は開いたときに読み直す */ });
  }
  function clear() {
    seq++;
    cache = null; target = null; draft = null; editing = null; sending = false; phase = 'idle';
    input.value = '';
    render();
  }
  render();
  return { setTarget, refresh, preload, clear };
}
