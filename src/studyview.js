// プロ動画の勉強ページ(③。設計書 docs/superpowers/specs/2026-10-28-pro-video-study-page-design.md)。
//   createStudyView({ getRoot, onRootChanged }) → { render, leave }
//   render(): 動画ルート(①の videoRootDir)を読み、権限は確認だけ(ダイアログは出さない)
//             → 勉強用フォルダ(`プロ動画`・`コーチング(beta)`)を走査 → 一覧。
//             一覧はフォルダを開いて進む形(パンくず・上のフォルダへ・サブフォルダ・そのフォルダの動画)。
//             開いているフォルダはこの画面の中で覚える(別の画面から戻った・走査し直した後も、まだあればそこを開く)。
//             コメントは表示中の組織の全件を読み、動画ごとの件数を一覧に出す。
//   leave(): 再生を止め、blob URL を解放し、コメント欄を閉じる(別の画面へ移るとき)。
//   getRoot: 練習画面が持っている動画ルート(起動時に読んだもの)。無ければ IndexedDB から読む。
//   onRootChanged(dir): この画面でフォルダを選び直した・許可したとき(練習画面のボタンの表示を合わせる)。
// 設定・許可のボタンのクリックの中でだけ showDirectoryPicker / requestPermission を呼ぶ。
// 動画はサーバに送らない(URL.createObjectURL で再生するだけ)。文字はすべて textContent で入れる。
import {
  videoRootSupported, loadVideoRoot, chooseVideoRoot, queryVideoRootPermission, requestVideoRootPermission,
} from './videoroot.js';
import {
  findStudyFolders, scanStudyRoot, findFolderNode, folderStats, breadcrumb, studyKey, studyVideoMatch, countByVideo,
  studyRootState, studyRootView, STUDY_FOLDERS_LABEL,
} from './studyfolder.js';
import { iconHref } from './icons.js';
import { createVideoComments } from './videocomments.js';
import { apiListStudyComments, apiCreateStudyComment, apiUpdateVideoComment, apiDeleteVideoComment } from './api.js';

const NO_ORG_MESSAGE = '組織のメンバーだけが使えます';
const UNAVAILABLE_MESSAGE = 'このサーバではコメントを使えません(再生だけできます)';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createStudyView({ doc = document, getRoot = () => null, onRootChanged = () => {} } = {}) {
  const $ = (id) => doc.getElementById(id);
  const statusEl = $('study-status');
  const noteEl = $('study-comment-note');
  const rootBtn = $('study-root');
  const rootBtnLabel = $('study-root-label');
  const listEl = $('study-list');
  const videoEl = $('study-video');
  const nameEl = $('study-video-name');
  const emptyEl = $('study-player-empty');
  const comments = createVideoComments({ root: $('study-comments'), overlayEl: $('study-comment-overlay'), videoEl });

  let root = null;
  let permission = 'prompt';
  let state = 'unset'; // studyRootState の値、または 'loading'(走査中)
  let tree = null; // scanStudyRoot の結果(最上段は動画ルート。その子が勉強用フォルダ)
  let studyIsRoot = false; // 動画ルート自体が勉強用フォルダ
  let openPath = ''; // 開いているフォルダ(最上段からの相対。'プロ動画/A大会' など)。走査し直しても残す
  let current = null; // 再生中の動画 { name, size, file, handle, path }
  let url = null; // 再生中の blob URL
  let commentMode = 'loading'; // loading | ok | unavailable | noOrg | error
  let counts = new Map();
  let gen = 0; // 描画の世代(画面を離れた・選び直した後の古い結果を捨てる)
  let busy = false;
  let selSeq = 0; // 動画の選択の連番(ファイルの読み直しを待つ間に次の選択・画面離脱があれば古い選択を捨てる)
  let scanFailed = false; // 走査に失敗した(「動画がありません」を出さない)

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  // 装飾アイコン(icons.js の icon() と同じ形を、innerHTML を使わずに作る)。
  const svgIcon = (name) => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', iconHref(name));
    svg.append(use);
    return svg;
  };
  const hasVideos = () => !!tree && (tree.videos.length > 0 || tree.folders.length > 0);
  const countBadge = (n) => {
    const badge = el('span', 'study-count', `${n}`);
    badge.title = `コメント ${n}件`;
    badge.setAttribute('aria-label', `コメント ${n}件`);
    return badge;
  };

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }
  function renderNote() {
    const text = commentMode === 'noOrg' ? NO_ORG_MESSAGE : commentMode === 'unavailable' ? UNAVAILABLE_MESSAGE : '';
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }
  function renderRootBtn() {
    const v = studyRootView(state, { rootName: root?.name || '' });
    rootBtn.hidden = !v.action || state === 'loading';
    rootBtn.dataset.action = v.action || '';
    rootBtnLabel.textContent = v.label;
    rootBtn.disabled = busy;
    return v;
  }

  // 一覧の行のフォーカス用の識別子(描き直した後に同じ行へフォーカスを戻す)。
  const focusKey = {
    video: (path, v) => `v:${JSON.stringify([path, v.name])}`, // サイズは含めない(選んだときにサイズが変わっても戻せる)
    folder: (path) => `f:${path}`,
    up: 'up',
    crumb: (path) => `c:${path}`,
  };
  // 今フォーカスがある一覧の行の識別子。フォーカスが一覧の外(コメント入力中など)なら null。
  function focusedKey() {
    const a = doc.activeElement;
    if (!a || a === listEl || !listEl.contains?.(a)) return null;
    return a.dataset?.focusKey || null;
  }

  // 一覧(今いるフォルダ)。パンくず → 上のフォルダへ → サブフォルダ → 動画。
  // 描き直す前に一覧の中の行にフォーカスがあれば、描き直した後に同じ行へ戻す(無くなっていれば戻さない)。
  function renderList() {
    const keep = focusedKey();
    listEl.textContent = '';
    if (state !== 'ready' || scanFailed || !tree) return null;
    if (!hasVideos()) {
      listEl.append(el('p', 'study-empty', `${studyIsRoot ? tree.name : STUDY_FOLDERS_LABEL} フォルダに動画がありません`));
      return null;
    }
    let node = findFolderNode(tree, openPath);
    if (!node) { openPath = ''; node = tree; }
    const keyed = new Map(); // focusKey → 行のボタン
    const mark = (b, key) => { b.dataset.focusKey = key; keyed.set(key, b); return b; };
    listEl.append(renderCrumbs(mark));
    const ul = el('ul', 'study-videos');
    const rows = { first: null, folders: new Map() }; // フォルダを移った後のフォーカス先
    const row = (b, key) => {
      mark(b, key);
      const li = el('li');
      li.append(b);
      ul.append(li);
      rows.first ||= b;
      return b;
    };
    if (node.path) {
      const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
      const b = el('button', 'study-item study-up');
      b.type = 'button';
      b.append(svgIcon('arrow-up'), el('span', 'study-item-name', '上のフォルダへ'));
      b.addEventListener('click', () => { openFolder(parent, node.path); });
      row(b, focusKey.up);
    }
    for (const f of node.folders) {
      const { videos, comments: n } = folderStats(f, counts);
      const b = el('button', 'study-item study-folder');
      b.type = 'button';
      b.title = f.path;
      b.setAttribute('aria-label', `フォルダ ${f.name}(動画 ${videos}本${n ? `、コメント ${n}件` : ''})`);
      b.append(svgIcon('folder'), el('span', 'study-item-name', f.name), el('span', 'study-folder-n', `${videos}本`));
      if (n) b.append(countBadge(n));
      b.addEventListener('click', () => { openFolder(f.path); });
      rows.folders.set(f.path, row(b, focusKey.folder(f.path)));
    }
    for (const v of node.videos) {
      const b = el('button', 'study-item');
      b.type = 'button';
      b.title = node.path ? `${node.path}/${v.name}` : v.name;
      if (current && current.name === v.name && current.size === v.size && current.path === node.path) {
        b.classList.add('active');
        b.setAttribute('aria-current', 'true');
      }
      b.append(el('span', 'study-item-name', v.name));
      const n = counts.get(studyKey(v.name, v.size)) || 0;
      if (n) b.append(countBadge(n));
      const path = node.path;
      b.addEventListener('click', () => { select({ ...v, path }); });
      row(b, focusKey.video(path, v));
    }
    // 防御用: 走査で動画の無い枝は除き、消えたパスは直下に戻すので、普段はここに来ない。
    if (node.folders.length + node.videos.length === 0) listEl.append(el('p', 'study-empty', 'このフォルダに動画がありません'));
    else listEl.append(ul);
    if (keep) keyed.get(keep)?.focus?.();
    return rows;
  }

  // パンくず: 動画ルート名 › プロ動画 › A › B(ルート自体が勉強用フォルダならその名前から)。今いる段は押せない(aria-current)。
  function renderCrumbs(mark) {
    const nav = el('nav', 'study-crumbs-nav');
    nav.setAttribute('aria-label', '開いているフォルダ');
    const ol = el('ol', 'study-crumbs');
    nav.append(ol);
    const items = breadcrumb({ rootName: tree?.name || '', path: openPath });
    items.forEach((c, i) => {
      const li = el('li');
      if (i === items.length - 1) {
        const s = el('span', 'study-crumb study-crumb-current', c.label);
        s.setAttribute('aria-current', 'location');
        li.append(s);
      } else {
        const b = el('button', 'study-crumb', c.label);
        b.type = 'button';
        b.addEventListener('click', () => { openFolder(c.path, openPath); });
        li.append(mark(b, focusKey.crumb(c.path)));
      }
      ol.append(li);
    });
    return nav;
  }

  // フォルダを開く(再生中の動画は止めない)。上へ戻ったときは、来たフォルダの行にフォーカスを置く。
  // renderList が戻したフォーカスより、こちらの移動を優先する。
  function openFolder(path, from = '') {
    openPath = path;
    const rows = renderList();
    if (!rows) return;
    let back = null;
    if (from) {
      const seg = from.slice(path ? path.length + 1 : 0).split('/')[0];
      back = rows.folders.get(path ? `${path}/${seg}` : seg);
    }
    (back || rows.first)?.focus?.();
  }

  // コメントを読んだ結果を件数と案内に反映する(コメント欄の読み込みでも呼ばれる)。
  function applyComments(r) {
    if (r?.unavailable) commentMode = 'unavailable';
    else if (r?.noOrg) commentMode = 'noOrg';
    else {
      commentMode = 'ok';
      counts = countByVideo(r?.comments);
    }
    renderNote();
    renderList();
    // 再生中に「使えない」「組織が無い」と分かったら、コメント欄をその表示にする。
    if (current && (commentMode === 'noOrg' || commentMode === 'unavailable')) setCommentTarget(current);
  }

  // 動画ごとに作る(create はその動画に付ける)。load は key 'study' で共有する(全件を読み、match で絞る)。
  const sourceFor = (v) => ({
    key: 'study',
    load: async () => {
      const r = await apiListStudyComments();
      applyComments(r);
      return r.noOrg ? { comments: [], canWrite: false } : r;
    },
    create: ({ positionMs, text }) => apiCreateStudyComment({ videoName: v.name, videoSize: v.size, positionMs, text }),
    update: (id, text) => apiUpdateVideoComment(id, text),
    remove: (id) => apiDeleteVideoComment(id),
  });

  function setCommentTarget(v) {
    if (!v || commentMode === 'unavailable') { comments.setTarget(null); return; }
    if (commentMode === 'noOrg') {
      comments.setTarget({ source: null, match: () => false, emptyMessage: NO_ORG_MESSAGE });
      return;
    }
    comments.setTarget({ source: sourceFor(v), match: studyVideoMatch(v), linked: true });
    comments.refresh();
  }

  function stopVideo() {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    if (url) { URL.revokeObjectURL(url); url = null; }
  }

  function renderPlayer() {
    nameEl.textContent = current ? (current.path ? `${current.path}/${current.name}` : current.name) : '';
    nameEl.hidden = !current;
    videoEl.hidden = !current;
    emptyEl.hidden = !!current || state !== 'ready' || !hasVideos();
  }

  async function select(picked) {
    let v = picked;
    if (current && current.name === v.name && current.size === v.size && current.path === v.path) return;
    const my = gen;
    const mySel = ++selSeq;
    let file = v.file;
    try { file = (await v.handle?.getFile?.()) || v.file; } catch { /* 走査したときのファイルで再生する */ }
    if (my !== gen || mySel !== selSeq) return; // 待つ間に別の動画を選んだ・画面を離れた・走査し直した
    // 走査の後にファイルが置き換わってサイズが変わっていたら、今のサイズで指し直す(コメントは名前 + サイズで付く)。
    if (Number.isSafeInteger(file?.size) && file.size !== v.size) {
      const old = v;
      v = { ...v, size: file.size, file };
      const g = findFolderNode(tree, old.path);
      const i = g ? g.videos.findIndex((x) => x.name === old.name && x.size === old.size) : -1;
      if (i >= 0) g.videos[i] = { ...g.videos[i], size: file.size, file };
    }
    stopVideo();
    current = v;
    url = URL.createObjectURL(file);
    videoEl.src = url;
    renderPlayer();
    renderList();
    setCommentTarget(v);
    videoEl.play().catch(() => { /* 自動再生がブロックされたら手動再生に任せる */ });
  }

  // フォルダの状態を確かめて、許可済みなら走査する(ダイアログは出さない)。
  async function scan() {
    const my = ++gen;
    selSeq++;
    scanFailed = false;
    stopVideo();
    current = null;
    comments.setTarget(null);
    tree = null;
    state = 'loading';
    renderRootBtn(); renderList(); renderPlayer();
    const supported = videoRootSupported();
    let found = { isRoot: false, folders: [] };
    if (supported && root) {
      try { if (permission === 'granted') found = await findStudyFolders(root); } catch (e) {
        if (my !== gen) return;
        state = 'noFolder';
        setStatus(`動画フォルダを読めませんでした: ${e?.message || e}`);
        renderRootBtn(); renderList(); renderPlayer();
        return;
      }
    }
    if (my !== gen) return;
    studyIsRoot = found.isRoot;
    state = studyRootState({ supported, handle: root, permission, folderFound: found.folders.length > 0 });
    const view = renderRootBtn();
    if (state !== 'ready') {
      setStatus(view.message);
      renderList(); renderPlayer();
      return;
    }
    setStatus('読込中…');
    try {
      tree = await scanStudyRoot(root, found.folders);
    } catch (e) {
      if (my !== gen) return;
      scanFailed = true;
      setStatus(`${studyIsRoot ? root.name : STUDY_FOLDERS_LABEL} フォルダを読めませんでした: ${e?.message || e}`);
      renderList(); renderPlayer();
      return;
    }
    if (my !== gen) return;
    setStatus('');
    renderList(); renderPlayer();
  }

  async function loadCounts() {
    const my = gen;
    try {
      const r = await apiListStudyComments();
      if (my !== gen) return;
      applyComments(r);
    } catch (e) {
      if (my !== gen) return;
      commentMode = 'error';
      noteEl.textContent = e?.message || 'コメントを読み込めませんでした';
      noteEl.hidden = false;
    }
  }

  // 同じフォルダか(選び直すと別のハンドルになるので isSameEntry で比べる)。
  async function sameEntry(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try { return !!(await a.isSameEntry?.(b)); } catch { return false; }
  }

  // 設定・許可のボタン。requestPermission / showDirectoryPicker はクリックの直後に呼ぶ(ユーザー操作が要る)。
  rootBtn.addEventListener('click', async () => {
    if (busy) return;
    const action = rootBtn.dataset.action;
    busy = true; rootBtn.disabled = true;
    try {
      if (action === 'grant') {
        permission = await requestVideoRootPermission(root);
        if (permission === 'granted') onRootChanged(root, permission);
      } else if (action === 'choose') {
        const dir = await chooseVideoRoot(root);
        if (!dir) return; // キャンセル
        // 別のフォルダを選んだら、開いていたフォルダは忘れて最上段から(同じフォルダなら保つ)。
        if (!(await sameEntry(root, dir))) openPath = '';
        root = dir;
        permission = 'granted'; // 選んだフォルダは読み取りが許可されている
        onRootChanged(dir, permission);
      } else return;
    } finally { busy = false; rootBtn.disabled = false; }
    await scan();
    loadCounts();
  });

  async function render() {
    const my = ++gen;
    setStatus('読込中…');
    commentMode = 'loading';
    renderNote();
    root = null;
    permission = 'prompt';
    if (videoRootSupported()) {
      root = getRoot() || await loadVideoRoot();
      if (my !== gen) return;
      permission = root ? await queryVideoRootPermission(root) : 'prompt';
      if (my !== gen) return;
    }
    const scanning = scan(); // 世代はここで進む(下の件数の読み込みは新しい世代で受け取る)
    loadCounts();
    await scanning;
  }

  function leave() {
    gen++;
    selSeq++;
    stopVideo();
    current = null;
    comments.clear();
    renderPlayer();
  }

  return { render, leave };
}
