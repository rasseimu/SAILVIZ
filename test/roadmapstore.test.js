import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, loadRoadmap, saveRoadmap,
  setGoal, addMilestone, renameMilestone, removeMilestone,
  moveMilestone, toggleMilestone, roadmapProgress,
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

test('roadmapProgress: 現在地=最初の未達index、全達成なら total', () => {
  const ms = (dones) => dones.map((d, i) => ({ id: `m${i}`, title: '', done: d, doneAt: d ? 1 : null }));
  assert.deepEqual(roadmapProgress(ms([true, true, false, false])), { total: 4, done: 2, currentIndex: 2 });
  assert.deepEqual(roadmapProgress(ms([false, false])), { total: 2, done: 0, currentIndex: 0 });
  assert.deepEqual(roadmapProgress(ms([true, true])), { total: 2, done: 2, currentIndex: 2 });
  // 非連続(後段だけ達成)でも currentIndex は最初の未達を指す
  assert.deepEqual(roadmapProgress(ms([false, true])), { total: 2, done: 1, currentIndex: 0 });
  assert.deepEqual(roadmapProgress([]), { total: 0, done: 0, currentIndex: 0 });
});
