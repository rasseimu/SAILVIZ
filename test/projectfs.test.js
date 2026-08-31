import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectFileName, projectLabel, listProjectFiles, readProject, writeProject,
  PROGRESS_FILE, readProgress, writeProgress,
} from '../src/projectfs.js';

// 列挙用フェイクディレクトリ(values() のみ)
function fakeListDir(names) {
  return { values: async function* () { for (const n of names) yield { kind: 'file', name: n }; } };
}
// 読み書き用フェイクディレクトリ(getFileHandle が Map を裏で操作)
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

test('projectFileName は実データ時刻を JST 整形したファイル名を作る', () => {
  // JST 09:30 の練習(TZ 非依存に検証するため明示オフセットで指定)。
  assert.equal(projectFileName(new Date('2026-08-17T09:30:00+09:00')), 'sailviz-20260817-0930.sailviz.json');
  // UTC 23:00 = JST 翌朝 08:00。マシン TZ に依らず JST で命名する。
  assert.equal(projectFileName(new Date('2026-08-16T23:00:00Z')), 'sailviz-20260817-0800.sailviz.json');
});

test('projectLabel は読みやすい日時に、不正なら名前をそのまま', () => {
  assert.equal(projectLabel('sailviz-20260817-0930.sailviz.json'), '2026-08-17 09:30');
  assert.equal(projectLabel('memo.sailviz.json'), 'memo.sailviz.json');
});

test('listProjectFiles は .sailviz.json のみを新しい順(名前降順)で返す', async () => {
  const dir = fakeListDir([
    'sailviz-20260817-0930.sailviz.json',
    'notes.txt',
    'sailviz-20260818-0800.sailviz.json',
    'video.mp4',
  ]);
  const list = await listProjectFiles(dir);
  assert.deepEqual(list.map((x) => x.name), [
    'sailviz-20260818-0800.sailviz.json',
    'sailviz-20260817-0930.sailviz.json',
  ]);
  assert.equal(list[0].label, '2026-08-18 08:00');
});

test('writeProject→readProject のラウンドトリップ', async () => {
  const dir = fakeRWDir();
  await writeProject(dir, 'p.sailviz.json', { version: 1, mode: 'absolute' });
  const got = await readProject(dir, 'p.sailviz.json');
  assert.deepEqual(got, { version: 1, mode: 'absolute' });
});

test('readProgress はファイルが無ければ {} を返す', async () => {
  assert.deepEqual(await readProgress(fakeRWDir()), {});
});

test('writeProgress→readProgress のラウンドトリップ', async () => {
  const dir = fakeRWDir();
  await writeProgress(dir, { r1: { issueStage: 2, goalDone: true, text: { goal: '新目標' } } });
  assert.equal(dir.files.has(PROGRESS_FILE), true);
  assert.deepEqual(await readProgress(dir), { r1: { issueStage: 2, goalDone: true, text: { goal: '新目標' } } });
});

test('readProgress は壊れたJSONでも {} を返す', async () => {
  const dir = fakeRWDir();
  dir.files.set(PROGRESS_FILE, 'not json');
  assert.deepEqual(await readProgress(dir), {});
});
