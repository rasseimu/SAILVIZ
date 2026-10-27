// test/videolink.test.js
// 練習の動画一覧の突き合わせ(name + t で同一判定)。架空のファイル名と小さな時刻だけを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  videoKey, normalizeVideoEntry, validateVideoAppend, appendVideos, mergeUnknownRemote, pickRelinkFile, nextVideoSeq,
  MAX_VIDEO_APPEND,
} from '../src/videolink.js';

test('videoKey は name と t(ms に丸め)の組。名前が同じでも時刻が違えば別の動画', () => {
  assert.equal(videoKey({ name: 'IMG_0001.MOV', t: 1000.4 }), videoKey({ name: 'IMG_0001.MOV', t: 1000 }));
  assert.notEqual(videoKey({ name: 'IMG_0001.MOV', t: 1000 }), videoKey({ name: 'IMG_0001.MOV', t: 5000 }));
  assert.notEqual(videoKey({ name: 'a.mp4', t: 1 }), videoKey({ name: 'b.mp4', t: 1 }));
});

test('normalizeVideoEntry は保存形式 { id, t, name, durationMs } にそろえ、url などは落とす', () => {
  assert.deepEqual(normalizeVideoEntry({ id: 'vid3', t: 1, name: 'a.mp4', url: 'blob:x' }), { id: 'vid3', t: 1, name: 'a.mp4', durationMs: null });
  assert.deepEqual(normalizeVideoEntry({ t: 1, name: 'a.mp4', durationMs: 5 }), { id: null, t: 1, name: 'a.mp4', durationMs: 5 });
});

test('validateVideoAppend: 配列・1回100件まで・name 1〜255字・t 有限数・durationMs は null か 0 以上', () => {
  assert.equal(validateVideoAppend([]), null);
  assert.equal(validateVideoAppend([{ id: 'vid0', t: 1, name: 'a.mp4', durationMs: null }, { t: 2, name: 'b.mp4', durationMs: 0 }]), null);
  assert.ok(validateVideoAppend(undefined));
  assert.ok(validateVideoAppend({ videos: [] }));
  assert.ok(validateVideoAppend(Array.from({ length: MAX_VIDEO_APPEND + 1 }, (_, i) => ({ t: i, name: 'a.mp4' }))));
  assert.equal(validateVideoAppend(Array.from({ length: MAX_VIDEO_APPEND }, (_, i) => ({ t: i, name: 'a.mp4' }))), null);
  assert.ok(validateVideoAppend([{ t: 1, name: '' }]));
  assert.ok(validateVideoAppend([{ t: 1, name: 'x'.repeat(256) }]));
  assert.equal(validateVideoAppend([{ t: 1, name: 'x'.repeat(255) }]), null);
  assert.ok(validateVideoAppend([{ t: Infinity, name: 'a.mp4' }]));
  assert.ok(validateVideoAppend([{ t: '1', name: 'a.mp4' }]));
  assert.ok(validateVideoAppend([{ t: 1, name: 'a.mp4', durationMs: -1 }]));
  assert.ok(validateVideoAppend([{ t: 1, name: 'a.mp4', durationMs: NaN }]));
  assert.ok(validateVideoAppend([{ t: 1, name: 'a.mp4', id: 5 }]));
  assert.ok(validateVideoAppend([null]));
});

test('appendVideos: 未登録の動画だけ末尾へ足す。既存の項目・順序は変えず、incoming 同士の重複も1本に', () => {
  const current = [
    { id: 'vid0', t: 100, name: 'a.mp4', durationMs: null, extra: 'keep' },
    { id: 'vid1', t: 200, name: 'b.mp4', durationMs: 10 },
  ];
  const snapshot = JSON.parse(JSON.stringify(current));
  const { videos, added } = appendVideos(current, [
    { id: 'vid0', t: 100, name: 'a.mp4', durationMs: 99 }, // 登録済み(durationMs が違っても上書きしない)
    { id: 'vid0', t: 300, name: 'a.mp4', durationMs: null }, // 同名・別時刻 → 足す(id は振り直す)
    { id: 'vid7', t: 400, name: 'c.mp4', durationMs: 5 },
    { id: 'vid8', t: 400, name: 'c.mp4', durationMs: 5 }, // incoming 同士の重複
  ]);
  assert.equal(added, 2);
  assert.deepEqual(current, snapshot, '引数は変更しない');
  assert.deepEqual(videos.slice(0, 2), snapshot);
  assert.deepEqual(videos.slice(2).map((v) => [v.id, v.name, v.t]), [['vid2', 'a.mp4', 300], ['vid7', 'c.mp4', 400]]);
});

test('appendVideos: 旧形式・空の videos(未定義)でも動き、足せないもの(name・t が無い)は飛ばす', () => {
  assert.deepEqual(appendVideos(undefined, [{ t: 1, name: 'a.mp4' }]).videos, [{ id: 'vid0', t: 1, name: 'a.mp4', durationMs: null }]);
  assert.equal(appendVideos([], [{ name: 'a.mp4' }, null]).added, 0);
  // 既存に壊れた項目があっても残す
  const r = appendVideos([{ foo: 1 }], [{ t: 1, name: 'a.mp4' }]);
  assert.deepEqual(r.videos[0], { foo: 1 });
  assert.equal(r.added, 1);
});

test('mergeUnknownRemote: 既知でもローカルにも無い動画だけ未リンクで足す。自分で消した(既知の)動画は戻さない', () => {
  const local = [{ id: 'vid0', t: 100, name: 'a.mp4', durationMs: null, url: 'blob:a' }];
  const known = new Set([videoKey({ name: 'a.mp4', t: 100 }), videoKey({ name: 'deleted.mp4', t: 50 })]);
  const remote = [
    { id: 'vid0', t: 100, name: 'a.mp4', durationMs: null },
    { id: 'vid0', t: 50, name: 'deleted.mp4', durationMs: null }, // 自分で消した
    { id: 'vid0', t: 700, name: 'other.mp4', durationMs: 3 },     // 他のメンバーが追記(id が重なる)
    { t: 'bad', name: 'x.mp4' },
  ];
  const { videos, added } = mergeUnknownRemote(local, remote, known);
  assert.deepEqual(added, [{ id: 'vid1', t: 700, name: 'other.mp4', durationMs: 3 }]);
  assert.equal(videos.length, 2);
  assert.equal(videos[0], local[0], 'ローカルの項目(url 付き)はそのまま');
  assert.equal(videos[1].url, undefined);
  assert.equal(local.length, 1, 'local は変更しない');
});

test('mergeUnknownRemote: remote が配列でなければ何も足さない', () => {
  const { videos, added } = mergeUnknownRemote([], null, new Set());
  assert.deepEqual(videos, []);
  assert.deepEqual(added, []);
});

test('pickRelinkFile: ±2秒以内で最も近い候補。範囲外・時刻不明は選ばない', () => {
  const c = [{ t: 1000, file: 'x' }, { t: 2900, file: 'y' }, { t: null, file: 'z' }, { t: 3500, file: 'w' }];
  assert.equal(pickRelinkFile(c, 3000).file, 'y');
  assert.equal(pickRelinkFile(c, 1500).file, 'x');
  assert.equal(pickRelinkFile(c, 6000), null);
  assert.equal(pickRelinkFile(c, 3000, 50), null);
  assert.equal(pickRelinkFile([], 1), null);
  assert.equal(pickRelinkFile(c, null), null);
});

test('nextVideoSeq: vidN の最大 N + 1。vidN 以外の id は数えない', () => {
  assert.equal(nextVideoSeq([]), 0);
  assert.equal(nextVideoSeq([{ id: 'vid2' }, { id: 'vid10' }, { id: 'x' }, {}]), 11);
  assert.equal(nextVideoSeq(undefined), 0);
});
