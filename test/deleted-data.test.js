// test/deleted-data.test.js — 削除した練習の一時保管(deleted_data_folder)と、1か月以上たった分の片付け。合成データのみ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deletedFileName, deletedAtFromName, shouldPurge, saveDeleted, purgeDeleted } from '../server/deletedData.js';

// 日本時間の日時 → epoch ms
const jst = (s) => Date.parse(`${s}+09:00`);

test('deletedFileName: 削除した日時(日本時間)_練習ID.json。ID のファイル名に使えない文字は _ にする', () => {
  assert.equal(deletedFileName('pd_0123456789', jst('2026-10-31T23:59:58')), '20261031-235958_pd_0123456789.json');
  assert.equal(deletedFileName('sailviz-20260101-0900.sailviz.json', jst('2026-11-01T00:00:00')),
    '20261101-000000_sailviz-20260101-0900.sailviz.json.json');
  assert.equal(deletedFileName('../x/y', jst('2026-11-01T00:00:00')), '20261101-000000_.._x_y.json');
});

test('deletedAtFromName: ファイル名の日時を読む。形が違えば null', () => {
  assert.equal(deletedAtFromName('20261031-235958_pd_0123456789.json'), jst('2026-10-31T23:59:58'));
  assert.equal(deletedAtFromName('memo.txt'), null);
  assert.equal(deletedAtFromName('20261399-000000_x.json'), null);
});

test('shouldPurge: 削除した月の翌々月(日本時間)に入ったら消す=少なくとも1か月は残す', () => {
  const d = jst('2026-10-31T23:00:00');
  assert.equal(shouldPurge(d, jst('2026-11-01T00:00:00')), false, '翌月はまだ残す');
  assert.equal(shouldPurge(d, jst('2026-11-30T23:59:59')), false);
  assert.equal(shouldPurge(d, jst('2026-12-01T00:00:00')), true, '翌々月の1日で消す');
  assert.equal(shouldPurge(jst('2026-10-01T00:00:00'), jst('2026-11-30T23:59:59')), false);
  assert.equal(shouldPurge(jst('2026-11-15T12:00:00'), jst('2027-01-01T00:00:00')), true, '年をまたぐ');
  assert.equal(shouldPurge(jst('2026-11-15T12:00:00'), jst('2026-12-31T23:59:59')), false);
  // UTC では前月でも、日本時間で月が変わっていれば日本時間で数える
  assert.equal(shouldPurge(jst('2026-11-01T08:00:00'), jst('2026-12-31T23:00:00')), false);
});

test('saveDeleted: フォルダを作って書き出し、中身(削除の情報・データ)を読み戻せる。書きかけのファイルは残らない', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'sailviz-del-')), 'deleted_data_folder');
  try {
    const at = jst('2026-10-27T21:00:00');
    const name = await saveDeleted(dir, { id: 'pd_0123456789', name: 'sailviz-20260101-0900.sailviz.json', deletedBy: { kind: 'shared' }, data: { rows: [1, 2] } }, at);
    assert.equal(name, '20261027-210000_pd_0123456789.json');
    assert.deepEqual(await readdir(dir), [name]);
    const j = JSON.parse(await readFile(join(dir, name), 'utf8'));
    assert.deepEqual(j, {
      id: 'pd_0123456789', name: 'sailviz-20260101-0900.sailviz.json',
      deletedAt: new Date(at).toISOString(), deletedBy: { kind: 'shared' }, data: { rows: [1, 2] },
    });
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('purgeDeleted: 1か月以上たった分だけ消す。日時の読めないファイルは更新日時で判断する。フォルダが無くても失敗しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sailviz-del-'));
  const dir = join(root, 'deleted_data_folder');
  try {
    assert.deepEqual(await purgeDeleted(dir, jst('2026-12-01T00:00:00')), []);
    for (const n of ['20261001-090000_a.json', '20261031-235959_b.json', '20261101-000000_c.json']) {
      await saveDeleted(dir, { id: n.slice(16, 17), data: {} }, deletedAtFromName(n));
    }
    await writeFile(join(dir, 'memo.json'), '{}');
    const old = new Date(jst('2026-09-15T00:00:00'));
    await utimes(join(dir, 'memo.json'), old, old);
    const removed = await purgeDeleted(dir, jst('2026-12-01T00:00:00'));
    assert.deepEqual(removed.sort(), ['20261001-090000_a.json', '20261031-235959_b.json', 'memo.json']);
    assert.deepEqual(await readdir(dir), ['20261101-000000_c.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
