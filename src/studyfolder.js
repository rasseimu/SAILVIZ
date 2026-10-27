// プロ動画の勉強ページ(③)の純関数(DOM 非依存。フォルダは FileSystemDirectoryHandle 相当を受け取る)。
// 動画ルート(①の `練習動画`)の中の勉強用フォルダ(`プロ動画`・`コーチング(beta)`)を読み、
// それぞれの直下と下4段(A/B/C/D/)までの動画をフォルダの木にまとめる(最上段は動画ルート)。
// 動画は 名前 + ファイルサイズ で指す(サーバの studyVideoKey と同じ形。フォルダを移動・改名してもコメントが付いたまま)。
import { VIDEO_RE } from './folderimport.js';
import { videoRootButtonState } from './videoroot.js';

// 勉強用フォルダの名前(この順で一覧に出す)。
export const STUDY_FOLDER_NAMES = ['プロ動画', 'コーチング(beta)'];
export const STUDY_FOLDER_NAME = STUDY_FOLDER_NAMES[0];
// 案内の文言用(「プロ動画・コーチング(beta)」)。
export const STUDY_FOLDERS_LABEL = STUDY_FOLDER_NAMES.join('・');
export const STUDY_MAX_DEPTH = 4;

// macOS の同期フォルダは名前が濁点を分けた形(NFD)になることがあるので、比べる・送る名前は NFC にそろえる。
const nfc = (s) => String(s ?? '').normalize('NFC');
const collator = new Intl.Collator('ja', { numeric: true });
const byName = (a, b) => collator.compare(a.name, b.name);
// ._ で始まる AppleDouble や隠しファイルは動画として出さない。
const isVideoName = (name) => !name.startsWith('.') && VIDEO_RE.test(name);

// 勉強用フォルダの名前の比べ方: NFKC(全角の括弧・英字を半角に)+ 前後の空白を除く + 小文字。
const studyNorm = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();
const studyIndex = (name) => STUDY_FOLDER_NAMES.findIndex((n) => studyNorm(n) === studyNorm(name));
export const isStudyFolderName = (name) => studyIndex(name) >= 0;

// 動画ルートの中の勉強用フォルダ。{ isRoot, folders }(folders は STUDY_FOLDER_NAMES の順)。
// ルート自体が勉強用フォルダのどれかなら、それ1つだけ(isRoot: true)。無ければ folders は空。
export async function findStudyFolders(root) {
  if (!root) return { isRoot: false, folders: [] };
  if (isStudyFolderName(root.name)) return { isRoot: true, folders: [root] };
  const found = [];
  for await (const entry of root.values()) {
    if (entry.kind === 'directory' && isStudyFolderName(entry.name)) found.push(entry);
  }
  found.sort((a, b) => studyIndex(a.name) - studyIndex(b.name) || collator.compare(nfc(a.name), nfc(b.name)));
  return { isRoot: false, folders: found };
}

// フォルダを走査して木 { name, path, folders: [木], videos: [{ name, size, file, handle }] } を返す(一覧でフォルダを開いて進む)。
// path は dir からの相対(直下は ''、下は 'A' | 'A/B')。path を渡すとその下として付ける(dir 自身の path)。
// 各段のフォルダ・動画は名前の数値順。maxDepth より深いフォルダは見ない(既定は下4段 A/B/C/D まで)。
// 配下に動画が1本も無いフォルダは出さない。
export async function scanStudyTree(dir, { maxDepth = STUDY_MAX_DEPTH, path = '' } = {}) {
  async function walk(d, name, path, depth) {
    const videos = [];
    const subdirs = [];
    for await (const entry of d.values()) {
      const n = nfc(entry.name);
      if (entry.kind === 'directory') {
        if (depth < maxDepth && !n.startsWith('.')) subdirs.push({ name: n, entry });
      } else if (entry.kind === 'file' && isVideoName(n)) {
        const file = await entry.getFile();
        videos.push({ name: n, size: file.size, file, handle: entry });
      }
    }
    const folders = [];
    for (const s of subdirs.sort(byName)) {
      const child = await walk(s.entry, s.name, path ? `${path}/${s.name}` : s.name, depth + 1);
      if (child.videos.length || child.folders.length) folders.push(child);
    }
    return { name, path, folders, videos: videos.sort(byName) };
  }
  return walk(dir, nfc(dir?.name), nfc(path), 0);
}

// 一覧の木。最上段(path '')は動画ルートで、その子が勉強用フォルダ(path は 'プロ動画'・'コーチング(beta)' の実際の名前)。
// 最上段に動画は置かない(ルート直下の動画・2026練習 などは出さない)。中に動画が1本も無い勉強用フォルダは出さない。
// ルート自体が勉強用フォルダ(folders が [root])なら、そのフォルダが最上段(直下の動画も出す)。
export async function scanStudyRoot(root, folders, { maxDepth = STUDY_MAX_DEPTH } = {}) {
  if (folders.length === 1 && folders[0] === root) return scanStudyTree(root, { maxDepth });
  const children = [];
  for (const f of folders) {
    const node = await scanStudyTree(f, { maxDepth, path: nfc(f.name) });
    if (node.videos.length || node.folders.length) children.push(node);
  }
  return { name: nfc(root?.name), path: '', folders: children, videos: [] };
}

// 木の中の path('' は最上段)のフォルダ。無ければ null。
export function findFolderNode(tree, path) {
  if (!tree) return null;
  let node = tree;
  for (const seg of nfc(path).split('/').filter(Boolean)) {
    node = node.folders.find((f) => f.name === seg);
    if (!node) return null;
  }
  return node;
}

// フォルダの配下すべて(下のフォルダも含む)の動画本数とコメント合計。counts は countByVideo の Map。
export function folderStats(node, counts = new Map()) {
  let videos = 0;
  let comments = 0;
  (function add(n) {
    for (const v of n.videos) { videos++; comments += counts.get(studyKey(v.name, v.size)) || 0; }
    for (const f of n.folders) add(f);
  })(node);
  return { videos, comments };
}

// パンくず [{ label, path }]。最上段(動画ルート `練習動画`、ルート自体が勉強用フォルダならそれ)の名前 › A › B。
// rootName は最上段の実際の名前。最後が今いるフォルダ。
export function breadcrumb({ rootName = '', path = '' } = {}) {
  const items = [{ label: nfc(rootName), path: '' }];
  let acc = '';
  for (const seg of nfc(path).split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    items.push({ label: seg, path: acc });
  }
  return items;
}

// 動画のキー(名前 + サイズの JSON 配列)。名前に何が入っても衝突しない。
export const studyKey = (name, size) => JSON.stringify([nfc(name), size]);

// コメント → 開いている動画({ name, size })のものか。
export function studyVideoMatch(video) {
  const name = nfc(video?.name);
  const size = video?.size;
  return (c) => !!c && nfc(c.videoName) === name && c.videoSize === size;
}

// 動画ごとのコメント件数 Map<studyKey, 件数>。
export function countByVideo(comments) {
  const m = new Map();
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c || typeof c.videoName !== 'string' || !Number.isSafeInteger(c.videoSize)) continue;
    const k = studyKey(c.videoName, c.videoSize);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

// 動画ルートの状態。'unsupported' | 'unset' | 'prompt' | 'denied' | 'noFolder' | 'ready'。
// permission は queryPermission の結果。folderFound は勉強用フォルダが1つでもあったか(許可済みのときだけ見る)。
export function studyRootState({ supported, handle, permission, folderFound }) {
  if (!supported) return 'unsupported';
  if (!handle) return 'unset';
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'prompt';
  return folderFound ? 'ready' : 'noFolder';
}

// 状態ごとの案内とボタン。action: 'choose'(フォルダを選ぶ)| 'grant'(許可を求める)| null(ボタンなし)。
// ボタンの文言は①の動画フォルダのボタンと同じ。
export function studyRootView(state, { rootName = '', folderNames = STUDY_FOLDER_NAMES } = {}) {
  const label = folderNames.join('・');
  const quoted = folderNames.map((n) => `「${n}」`).join('・');
  const btn = (permission) => videoRootButtonState({ supported: true, hasHandle: state !== 'unset', permission });
  switch (state) {
    case 'unsupported':
      return { message: 'このブラウザでは動画フォルダを読めません(Chrome / Edge で開いてください)', action: null, label: '' };
    case 'unset':
      return { message: `動画フォルダ(中に${quoted}がある「練習動画」)を設定してください`, ...pick(btn('prompt')) };
    case 'prompt':
      return { message: '動画フォルダの読み取りを許可してください', ...pick(btn('prompt')) };
    case 'denied':
      return { message: '動画フォルダの読み取りが許可されていません。フォルダを選び直してください', ...pick(btn('denied')) };
    case 'noFolder':
      return {
        message: `${label} フォルダが見つかりません${rootName ? `(動画フォルダ「${rootName}」の中に置いてください)` : ''}`,
        action: 'choose', label: '動画フォルダを選び直す',
      };
    default:
      return { message: '', action: 'choose', label: '動画フォルダを選び直す' };
  }
}
const pick = ({ action, label }) => ({ action, label });
