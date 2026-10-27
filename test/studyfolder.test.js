// test/studyfolder.test.js — プロ動画の勉強ページ(③)のフォルダの木・パンくず・動画キー・状態(src/studyfolder.js)。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findStudyFolders, isStudyFolderName, scanStudyTree, scanStudyRoot, findFolderNode, folderStats, breadcrumb, studyKey,
  studyVideoMatch, countByVideo, studyRootState, studyRootView, STUDY_FOLDER_NAME, STUDY_FOLDER_NAMES, STUDY_MAX_DEPTH,
} from '../src/studyfolder.js';
import { studyVideoKey } from '../server/domain/videoComments.js';

// 擬似 FileSystemHandle。file(name, size) / dir(name, children)。
const file = (name, size = 100) => ({ kind: 'file', name, getFile: async () => ({ name, size }) });
const dir = (name, children = []) => ({
  kind: 'directory', name, values: async function* values() { for (const c of children) yield c; },
});
// 木を [path, 動画, 下のフォルダ] の入れ子にする(比べやすく)。
const summary = (n) => [n.path, n.videos.map((v) => `${v.name}:${v.size}`), n.folders.map(summary)];

test('isStudyFolderName: プロ動画・コーチング(beta)。全角の括弧・大文字・前後の空白・NFD も同じとみなす', () => {
  assert.deepEqual(STUDY_FOLDER_NAMES, ['プロ動画', 'コーチング(beta)']);
  assert.equal(STUDY_FOLDER_NAME, 'プロ動画');
  for (const n of ['プロ動画', ' プロ動画 ', 'プロ動画'.normalize('NFD'), 'コーチング(beta)', 'コーチング（beta）',
    'コーチング(Beta)', 'コーチング（ＢＥＴＡ）', 'コーチング(beta)'.normalize('NFD')]) {
    assert.equal(isStudyFolderName(n), true, n);
  }
  for (const n of ['2026練習', 'プロ動画2', 'コーチング', 'コーチング(alpha)', '', null]) assert.equal(isStudyFolderName(n), false, String(n));
});

test('findStudyFolders: ルート直下の勉強用フォルダを全部(定数の順)。ルート自体が勉強用フォルダならそれ1つ', async () => {
  const pro = dir('プロ動画');
  const coach = dir('コーチング（beta）');
  const both = dir('練習動画', [coach, dir('2026練習'), file('プロ動画.mp4'), pro]);
  assert.deepEqual(await findStudyFolders(both), { isRoot: false, folders: [pro, coach] });
  assert.deepEqual(await findStudyFolders(dir('練習動画', [coach, dir('2026練習')])), { isRoot: false, folders: [coach] });
  assert.deepEqual(await findStudyFolders(dir('練習動画', [pro])), { isRoot: false, folders: [pro] });
  assert.deepEqual(await findStudyFolders(dir('2026練習', [dir('8 27(木)')])), { isRoot: false, folders: [] }, 'ルートが 2026練習');
  assert.deepEqual(await findStudyFolders(pro), { isRoot: true, folders: [pro] });
  assert.deepEqual(await findStudyFolders(coach), { isRoot: true, folders: [coach] });
  assert.deepEqual(await findStudyFolders(null), { isRoot: false, folders: [] });
  const nfd = dir(STUDY_FOLDER_NAME.normalize('NFD'));
  assert.deepEqual((await findStudyFolders(dir('練習動画', [nfd]))).folders, [nfd]);
});

test('scanStudyRoot: 最上段は動画ルート(動画は置かない)、子は勉強用フォルダ(定数の順・実際の名前)。空の勉強用フォルダは出さない', async () => {
  const coachName = 'コーチング（beta）';
  const pro = dir('プロ動画', [file('p.mp4', 1), dir('A大会', [file('a.mp4', 2)])]);
  const coach = dir(coachName, [dir('講習1', [file('c.mp4', 3)])]);
  const root = dir('練習動画', [file('root.mp4', 9), dir('2026練習', [file('x.mp4', 8)]), coach, pro]);
  const { folders } = await findStudyFolders(root);
  const tree = await scanStudyRoot(root, folders);
  assert.equal(tree.name, '練習動画');
  assert.deepEqual(summary(tree), ['', [], [
    ['プロ動画', ['p.mp4:1'], [['プロ動画/A大会', ['a.mp4:2'], []]]],
    [coachName, [], [[`${coachName}/講習1`, ['c.mp4:3'], []]]],
  ]]);
  assert.equal(findFolderNode(tree, `${coachName}/講習1`).videos[0].name, 'c.mp4');
  // 空の勉強用フォルダは出さない。全部空なら最上段も空
  const empty = dir('練習動画', [dir('プロ動画', [dir('空')]), dir('コーチング(beta)', [file('メモ.txt')])]);
  const t2 = await scanStudyRoot(empty, (await findStudyFolders(empty)).folders);
  assert.deepEqual(summary(t2), ['', [], []]);
  // ルート自体が勉強用フォルダなら、そのフォルダが最上段(直下の動画も出す)
  const t3 = await scanStudyRoot(pro, [pro]);
  assert.deepEqual(summary(t3), ['', ['p.mp4:1'], [['A大会', ['a.mp4:2'], []]]]);
});

test('scanStudyRoot: 各勉強用フォルダの下4段まで(5段目は見ない)', async () => {
  const deep = (name) => dir(name, [dir('A', [dir('B', [dir('C', [dir('D', [file('d.mp4', 4), dir('E', [file('e.mp4', 5)])])])])])]);
  const root = dir('練習動画', [deep('プロ動画'), deep('コーチング(beta)')]);
  const tree = await scanStudyRoot(root, (await findStudyFolders(root)).folders);
  for (const top of STUDY_FOLDER_NAMES) {
    const d = findFolderNode(tree, `${top}/A/B/C/D`);
    assert.deepEqual(d.videos.map((v) => v.name), ['d.mp4'], top);
    assert.deepEqual(d.folders, [], `${top}: 5段目(E)は見ない`);
  }
});

test('scanStudyTree: フォルダの木。動画以外・隠しファイル・隠しフォルダ・動画の無い枝は出さない。数値順', async () => {
  const root = dir('プロ動画', [
    file('clip10.mp4', 10), file('clip2.mov', 2), file('メモ.txt'), file('._clip3.mp4'), file('CLIP1.M4V', 1),
    dir('B大会', [file('b.webm', 5)]),
    dir('A大会', [
      file('a.mp4', 3),
      dir('2日目', [file('a2.mp4', 4)]),
      dir('10日目', [file('a10.mp4', 6)]),
      dir('空', [file('x.txt'), dir('もっと空')]),
    ]),
    dir('空フォルダ', [dir('下に動画', [file('under.mp4', 7)])]),
    dir('.hidden', [file('h.mp4')]),
  ]);
  const tree = await scanStudyTree(root);
  assert.equal(tree.name, 'プロ動画');
  assert.deepEqual(summary(tree), ['', ['CLIP1.M4V:1', 'clip2.mov:2', 'clip10.mp4:10'], [
    ['A大会', ['a.mp4:3'], [
      ['A大会/2日目', ['a2.mp4:4'], []],
      ['A大会/10日目', ['a10.mp4:6'], []],
    ]],
    ['B大会', ['b.webm:5'], []],
    ['空フォルダ', [], [['空フォルダ/下に動画', ['under.mp4:7'], []]]],
  ]]);
  assert.deepEqual(tree.folders.map((f) => f.name), ['A大会', 'B大会', '空フォルダ']);
  assert.ok(tree.videos[0].file && tree.videos[0].handle);
  assert.deepEqual(summary(await scanStudyTree(dir('プロ動画'))), ['', [], []]);
});

test('scanStudyTree: 下4段(A/B/C/D)まで。5段目は見ない。深さは指定できる', async () => {
  assert.equal(STUDY_MAX_DEPTH, 4);
  const root = dir('プロ動画', [dir('A', [dir('B', [dir('C', [dir('D', [file('d.mp4', 4), dir('E', [file('e.mp4', 5)])])])])])]);
  const tree = await scanStudyTree(root);
  const d = findFolderNode(tree, 'A/B/C/D');
  assert.deepEqual(d.videos.map((v) => v.name), ['d.mp4']);
  assert.deepEqual(d.folders, [], '5段目(E)は見ない');
  // 5段目にしか動画が無ければ、その枝ごと出さない
  const only5 = await scanStudyTree(dir('プロ動画', [dir('A', [dir('B', [dir('C', [dir('D', [dir('E', [file('e.mp4', 5)])])])])])]));
  assert.deepEqual(only5.folders, []);
  // 0 なら直下だけ
  assert.deepEqual((await scanStudyTree(root, { maxDepth: 0 })).folders, []);
});

test('scanStudyTree: 名前は NFC にそろえる(PC ごとに名前の形が違ってもコメントが一致する)', async () => {
  const nfd = 'プロのタック.mp4'.normalize('NFD');
  const folder = 'ブラジル大会'.normalize('NFD');
  const tree = await scanStudyTree(dir('プロ動画', [file(nfd, 42), dir(folder, [file(nfd, 43)])]));
  assert.equal(tree.videos[0].name, 'プロのタック.mp4');
  assert.equal(tree.folders[0].name, 'ブラジル大会');
  assert.equal(tree.folders[0].path, 'ブラジル大会');
  assert.equal(tree.folders[0].videos[0].name, 'プロのタック.mp4');
  // NFD のパスでも見つかる
  assert.equal(findFolderNode(tree, folder), tree.folders[0]);
});

test('findFolderNode: パスのフォルダ。直下は空文字。無ければ null', async () => {
  const tree = await scanStudyTree(dir('プロ動画', [dir('A大会', [dir('2日目', [file('a.mp4', 1)])]), file('top.mp4', 2)]));
  assert.equal(findFolderNode(tree, ''), tree);
  assert.equal(findFolderNode(tree, 'A大会').path, 'A大会');
  assert.equal(findFolderNode(tree, 'A大会/2日目').videos[0].name, 'a.mp4');
  assert.equal(findFolderNode(tree, 'A大会/3日目'), null);
  assert.equal(findFolderNode(tree, 'B大会'), null);
  assert.equal(findFolderNode(null, ''), null);
});

test('folderStats: 配下すべての動画本数とコメント合計', async () => {
  const tree = await scanStudyTree(dir('プロ動画', [
    file('top.mp4', 1),
    dir('A大会', [file('a.mp4', 2), dir('2日目', [file('a2.mp4', 3), file('a3.mp4', 4)])]),
  ]));
  const counts = countByVideo([
    { videoName: 'top.mp4', videoSize: 1 },
    { videoName: 'a.mp4', videoSize: 2 },
    { videoName: 'a2.mp4', videoSize: 3 }, { videoName: 'a2.mp4', videoSize: 3 },
    { videoName: 'a3.mp4', videoSize: 999 }, // 別サイズは数えない
  ]);
  assert.deepEqual(folderStats(tree, counts), { videos: 4, comments: 4 });
  assert.deepEqual(folderStats(findFolderNode(tree, 'A大会'), counts), { videos: 3, comments: 3 });
  assert.deepEqual(folderStats(findFolderNode(tree, 'A大会/2日目'), counts), { videos: 2, comments: 2 });
  assert.deepEqual(folderStats(findFolderNode(tree, 'A大会')), { videos: 3, comments: 0 });
});

test('breadcrumb: 最上段(練習動画)も押せる › プロ動画 › …。ルートが プロ動画 なら プロ動画 から', () => {
  assert.deepEqual(breadcrumb({ rootName: '練習動画', path: '' }), [{ label: '練習動画', path: '' }]);
  assert.deepEqual(breadcrumb({ rootName: '練習動画', path: 'プロ動画/A大会/2日目' }), [
    { label: '練習動画', path: '' }, { label: 'プロ動画', path: 'プロ動画' },
    { label: 'A大会', path: 'プロ動画/A大会' }, { label: '2日目', path: 'プロ動画/A大会/2日目' },
  ]);
  assert.deepEqual(breadcrumb({ rootName: '練習動画', path: 'コーチング(beta)' }), [
    { label: '練習動画', path: '' }, { label: 'コーチング(beta)', path: 'コーチング(beta)' },
  ]);
  assert.deepEqual(breadcrumb({ rootName: 'プロ動画', path: 'A大会' }), [
    { label: 'プロ動画', path: '' }, { label: 'A大会', path: 'A大会' },
  ]);
  assert.deepEqual(breadcrumb({ rootName: 'プロ動画' }), [{ label: 'プロ動画', path: '' }]);
});

test('studyKey: サーバの studyVideoKey と同じ形で、名前に区切り文字が入っても衝突しない', () => {
  assert.equal(studyKey('clip01.mp4', 1234), studyVideoKey('clip01.mp4', 1234));
  assert.notEqual(studyKey('a",1', 2), studyKey('a', 1));
  assert.notEqual(studyKey('a', 12), studyKey('a1', 2));
  assert.equal(studyKey('プ'.normalize('NFD'), 1), studyKey('プ', 1));
});

test('studyVideoMatch / countByVideo: 名前 + サイズで動画ごとに分ける', () => {
  const cs = [
    { videoName: 'clip01.mp4', videoSize: 10, positionMs: 0 },
    { videoName: 'clip01.mp4', videoSize: 10, positionMs: 5 },
    { videoName: 'clip01.mp4', videoSize: 11, positionMs: 0 },
    { videoName: 'clip02.mp4', videoSize: 10, positionMs: 0 },
    { videoName: 'x.mp4', videoT: 1 }, null,
  ];
  const m = studyVideoMatch({ name: 'clip01.mp4', size: 10 });
  assert.equal(cs.filter(m).length, 2);
  assert.equal(m(null), false);
  const counts = countByVideo(cs);
  assert.equal(counts.get(studyKey('clip01.mp4', 10)), 2);
  assert.equal(counts.get(studyKey('clip01.mp4', 11)), 1);
  assert.equal(counts.get(studyKey('clip02.mp4', 10)), 1);
  assert.equal(counts.size, 3);
  assert.equal(countByVideo(null).size, 0);
});

test('studyRootState: 6つの状態', () => {
  const h = { name: '練習動画' };
  assert.equal(studyRootState({ supported: false, handle: h, permission: 'granted', folderFound: true }), 'unsupported');
  assert.equal(studyRootState({ supported: true, handle: null, permission: 'prompt' }), 'unset');
  assert.equal(studyRootState({ supported: true, handle: h, permission: 'prompt' }), 'prompt');
  assert.equal(studyRootState({ supported: true, handle: h, permission: 'denied' }), 'denied');
  assert.equal(studyRootState({ supported: true, handle: h, permission: 'granted', folderFound: false }), 'noFolder');
  assert.equal(studyRootState({ supported: true, handle: h, permission: 'granted', folderFound: true }), 'ready');
});

test('studyRootView: 状態ごとの案内とボタン(①と同じ文言)', () => {
  assert.deepEqual(studyRootView('unsupported').action, null);
  assert.deepEqual(pickAL(studyRootView('unset')), ['choose', '動画フォルダを設定']);
  assert.equal(studyRootView('unset').message, '動画フォルダ(中に「プロ動画」・「コーチング(beta)」がある「練習動画」)を設定してください');
  assert.deepEqual(pickAL(studyRootView('prompt')), ['grant', '動画フォルダを許可']);
  assert.deepEqual(pickAL(studyRootView('denied')), ['choose', '動画フォルダを選び直す']);
  const nf = studyRootView('noFolder', { rootName: '2026練習' });
  assert.deepEqual(pickAL(nf), ['choose', '動画フォルダを選び直す']);
  assert.equal(nf.message, 'プロ動画・コーチング(beta) フォルダが見つかりません(動画フォルダ「2026練習」の中に置いてください)');
  assert.equal(studyRootView('noFolder').message, 'プロ動画・コーチング(beta) フォルダが見つかりません');
  assert.equal(studyRootView('ready').message, '');
});
const pickAL = (v) => [v.action, v.label];
