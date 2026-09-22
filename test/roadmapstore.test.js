import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, loadRoadmap, saveRoadmap,
  setGoal, addMilestone, renameMilestone, removeMilestone,
  moveMilestone, toggleMilestone, roadmapProgress,
  addChild, toggleChild, renameChild, removeChild, childProgress,
  ROADMAP_FILE, readRoadmapFile, writeRoadmapFile,
} from '../src/roadmapstore.js';

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// 保存フォルダ(FileSystemDirectoryHandle)の読み書きフェイク。projectfs.test の流用。
function fakeRWDir() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts || !opts.create) throw new Error('not found');
        files.set(name, '');
      }
      return {
        getFile: async () => ({ text: async () => files.get(name) }),
        createWritable: async () => ({
          write: async (data) => { files.set(name, data); },
          close: async () => {},
        }),
      };
    },
  };
}

test('load/save 往復', () => {
  const st = memStorage();
  const obj = { '村瀬 礼': { goal: '全日本', milestones: [{ id: 'a', title: 'x', done: false, doneAt: null }] } };
  saveRoadmap(obj, st);
  assert.deepEqual(loadRoadmap(st), obj);
});

test('loadRoadmap は空/壊れ入力で {} を返す', () => {
  assert.deepEqual(loadRoadmap(memStorage()), {});
  assert.deepEqual(loadRoadmap(memStorage({ [STORAGE_KEY]: 'not json' })), {});
});

test('setGoal: 部員の大目標を不変更新でセット', () => {
  const a = {};
  const b = setGoal(a, '村瀬 礼', '全日本インカレ出場');
  assert.notEqual(a, b);
  assert.equal(b['村瀬 礼'].goal, '全日本インカレ出場');
  assert.deepEqual(b['村瀬 礼'].milestones, []);
});

test('addMilestone: 末尾に {id,title,done:false,doneAt:null} を追加', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'レース完走');
  o = addMilestone(o, '村瀬 礼', 'm2', '入賞');
  assert.deepEqual(o['村瀬 礼'].milestones, [
    { id: 'm1', title: 'レース完走', done: false, doneAt: null },
    { id: 'm2', title: '入賞', done: false, doneAt: null },
  ]);
});

test('addMilestone: 空白のみタイトルは無視', () => {
  const o = addMilestone({}, '村瀬 礼', 'm1', '   ');
  assert.deepEqual(o, {});
});

test('renameMilestone: 該当idのtitleを更新', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', '旧名');
  o = renameMilestone(o, '村瀬 礼', 'm1', '新名');
  assert.equal(o['村瀬 礼'].milestones[0].title, '新名');
});

test('renameMilestone: 空白のみは元のtitleを維持', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', '旧名');
  o = renameMilestone(o, '村瀬 礼', 'm1', '  ');
  assert.equal(o['村瀬 礼'].milestones[0].title, '旧名');
});

test('removeMilestone: 該当idを削除', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addMilestone(o, '村瀬 礼', 'm2', 'b');
  o = removeMilestone(o, '村瀬 礼', 'm1');
  assert.deepEqual(o['村瀬 礼'].milestones.map((m) => m.id), ['m2']);
});

test('moveMilestone: dir=-1 で前へ、端では変化なし', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addMilestone(o, '村瀬 礼', 'm2', 'b');
  o = addMilestone(o, '村瀬 礼', 'm3', 'c');
  const up = moveMilestone(o, '村瀬 礼', 'm3', -1);
  assert.deepEqual(up['村瀬 礼'].milestones.map((m) => m.id), ['m1', 'm3', 'm2']);
  const noop = moveMilestone(o, '村瀬 礼', 'm1', -1);
  assert.deepEqual(noop['村瀬 礼'].milestones.map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('moveMilestone: dir=+1 で後ろへ、端では変化なし', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addMilestone(o, '村瀬 礼', 'm2', 'b');
  const down = moveMilestone(o, '村瀬 礼', 'm1', 1);
  assert.deepEqual(down['村瀬 礼'].milestones.map((m) => m.id), ['m2', 'm1']);
  const noop = moveMilestone(o, '村瀬 礼', 'm2', 1);
  assert.deepEqual(noop['村瀬 礼'].milestones.map((m) => m.id), ['m1', 'm2']);
});

test('toggleMilestone: done=true で doneAt に ts を記録、false で null', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = toggleMilestone(o, '村瀬 礼', 'm1', true, 12345);
  assert.deepEqual(o['村瀬 礼'].milestones[0], { id: 'm1', title: 'a', done: true, doneAt: 12345 });
  o = toggleMilestone(o, '村瀬 礼', 'm1', false, 99999);
  assert.deepEqual(o['村瀬 礼'].milestones[0], { id: 'm1', title: 'a', done: false, doneAt: null });
});

test('不変更新: 元オブジェクトを破壊しない', () => {
  const a = addMilestone({}, '村瀬 礼', 'm1', 'a');
  const b = toggleMilestone(a, '村瀬 礼', 'm1', true, 1);
  assert.equal(a['村瀬 礼'].milestones[0].done, false);
  assert.equal(b['村瀬 礼'].milestones[0].done, true);
});

test('readRoadmapFile はファイルが無ければ {} を返す', async () => {
  assert.deepEqual(await readRoadmapFile(fakeRWDir()), {});
});

test('writeRoadmapFile→readRoadmapFile のラウンドトリップ', async () => {
  const dir = fakeRWDir();
  const obj = { '村瀬 礼': { goal: '全日本', milestones: [{ id: 'a', title: 'x', done: true, doneAt: 1 }] } };
  await writeRoadmapFile(dir, obj);
  assert.equal(dir.files.has(ROADMAP_FILE), true);
  assert.deepEqual(await readRoadmapFile(dir), obj);
});

test('readRoadmapFile は壊れたJSONでも {} を返す', async () => {
  const dir = fakeRWDir();
  dir.files.set(ROADMAP_FILE, 'not json');
  assert.deepEqual(await readRoadmapFile(dir), {});
});

// ===== 小目標(children): 大目標 > 段階 > 小目標 の3階層 =====

test('addChild: 段階の子として {id,title,done:false,doneAt:null} を追加', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'クローズで速く');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'ヒールを一定に');
  assert.deepEqual(o['村瀬 礼'].milestones[0].children, [
    { id: 'c1', title: 'ヒールを一定に', done: false, doneAt: null },
  ]);
});

test('addChild: 空白のみタイトルは無視', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  const before = o;
  o = addChild(o, '村瀬 礼', 'm1', 'c1', '   ');
  assert.equal(o, before);
});

test('addChild: 済みの段階に未達の子を足すと親が未達に戻る', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = toggleMilestone(o, '村瀬 礼', 'm1', true, 100); // 子なしは手動達成
  o = addChild(o, '村瀬 礼', 'm1', 'c1', '子');
  assert.equal(o['村瀬 礼'].milestones[0].done, false);
  assert.equal(o['村瀬 礼'].milestones[0].doneAt, null);
});

test('toggleChild: 全子達成で親が自動 done(doneAt=ts)', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'x');
  o = addChild(o, '村瀬 礼', 'm1', 'c2', 'y');
  o = toggleChild(o, '村瀬 礼', 'm1', 'c1', true, 111);
  assert.equal(o['村瀬 礼'].milestones[0].done, false); // まだ c2 が未達
  o = toggleChild(o, '村瀬 礼', 'm1', 'c2', true, 222);
  assert.equal(o['村瀬 礼'].milestones[0].done, true);
  assert.equal(o['村瀬 礼'].milestones[0].doneAt, 222);
});

test('toggleChild: 子を外すと親も未達に戻る', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'x');
  o = toggleChild(o, '村瀬 礼', 'm1', 'c1', true, 111);
  assert.equal(o['村瀬 礼'].milestones[0].done, true);
  o = toggleChild(o, '村瀬 礼', 'm1', 'c1', false, 222);
  assert.equal(o['村瀬 礼'].milestones[0].done, false);
  assert.equal(o['村瀬 礼'].milestones[0].doneAt, null);
});

test('renameChild: 子のtitleを更新(done不変)、空白は無視', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', '旧');
  o = renameChild(o, '村瀬 礼', 'm1', 'c1', '新');
  assert.equal(o['村瀬 礼'].milestones[0].children[0].title, '新');
  o = renameChild(o, '村瀬 礼', 'm1', 'c1', '  ');
  assert.equal(o['村瀬 礼'].milestones[0].children[0].title, '新');
});

test('removeChild: 該当子を削除', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'x');
  o = addChild(o, '村瀬 礼', 'm1', 'c2', 'y');
  o = removeChild(o, '村瀬 礼', 'm1', 'c1', 1);
  assert.deepEqual(o['村瀬 礼'].milestones[0].children.map((c) => c.id), ['c2']);
});

test('removeChild: 最後の未達の子を削除して残り全達成なら親が自動完了', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'x');
  o = addChild(o, '村瀬 礼', 'm1', 'c2', 'y');
  o = toggleChild(o, '村瀬 礼', 'm1', 'c1', true, 111);
  assert.equal(o['村瀬 礼'].milestones[0].done, false);
  o = removeChild(o, '村瀬 礼', 'm1', 'c2', 333); // 残りは c1(済)のみ
  assert.equal(o['村瀬 礼'].milestones[0].done, true);
  assert.equal(o['村瀬 礼'].milestones[0].doneAt, 333);
});

test('toggleMilestone: 子を持つ段階は手動トグル不可(不変)', () => {
  let o = addMilestone({}, '村瀬 礼', 'm1', 'a');
  o = addChild(o, '村瀬 礼', 'm1', 'c1', 'x');
  const before = o;
  o = toggleMilestone(o, '村瀬 礼', 'm1', true, 999);
  assert.equal(o, before);
});

test('childProgress: 子の達成数を返す(子なしは total:0)', () => {
  assert.deepEqual(childProgress({ id: 'm', title: '', done: false, doneAt: null }), { done: 0, total: 0 });
  assert.deepEqual(childProgress({
    id: 'm', title: '', done: false, doneAt: null,
    children: [{ done: true }, { done: false }, { done: true }],
  }), { done: 2, total: 3 });
});

test('子の不変更新: 元オブジェクトを破壊しない', () => {
  const a = addChild(addMilestone({}, '村瀬 礼', 'm1', 'a'), '村瀬 礼', 'm1', 'c1', 'x');
  const b = toggleChild(a, '村瀬 礼', 'm1', 'c1', true, 1);
  assert.equal(a['村瀬 礼'].milestones[0].children[0].done, false);
  assert.equal(b['村瀬 礼'].milestones[0].children[0].done, true);
});

test('roadmapProgress: 現在地=最初の未達index、全達成なら total', () => {
  const ms = (dones) => dones.map((d, i) => ({ id: `m${i}`, title: '', done: d, doneAt: d ? 1 : null }));
  assert.deepEqual(roadmapProgress(ms([true, true, false, false])), { total: 4, done: 2, currentIndex: 2 });
  assert.deepEqual(roadmapProgress(ms([false, false])), { total: 2, done: 0, currentIndex: 0 });
  assert.deepEqual(roadmapProgress(ms([true, true])), { total: 2, done: 2, currentIndex: 2 });
  // 非連続(後段だけ達成)でも currentIndex は最初の未達を指す
  assert.deepEqual(roadmapProgress(ms([false, true])), { total: 2, done: 1, currentIndex: 0 });
  assert.deepEqual(roadmapProgress([]), { total: 0, done: 0, currentIndex: 0 });
});
