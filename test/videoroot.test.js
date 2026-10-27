// test/videoroot.test.js
// 動画ルートのボタン表示と権限の確認(自動の経路ではダイアログを出さない)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoRootButtonState, queryVideoRootPermission, requestVideoRootPermission } from '../src/videoroot.js';

test('videoRootButtonState: 非対応・未設定・拒否済み・要許可・許可済みで表示を変える', () => {
  assert.equal(videoRootButtonState({ supported: false, hasHandle: true, permission: 'granted' }).action, 'unsupported');
  assert.deepEqual(videoRootButtonState({ supported: true, hasHandle: false, permission: 'prompt' }), { action: 'choose', label: '動画フォルダを設定' });
  assert.deepEqual(videoRootButtonState({ supported: true, hasHandle: true, permission: 'prompt' }), { action: 'grant', label: '動画フォルダを許可' });
  assert.deepEqual(videoRootButtonState({ supported: true, hasHandle: true, permission: 'denied' }),
    { action: 'choose', label: '動画フォルダを選び直す' }, '拒否済みはフォルダを選び直す');
  assert.deepEqual(videoRootButtonState({ supported: true, hasHandle: true, permission: 'granted', name: '練習動画' }),
    { action: 'ready', label: '動画フォルダ: 練習動画' });
});

test('queryVideoRootPermission は queryPermission だけを読み取りで呼び、requestPermission は呼ばない', async () => {
  const calls = [];
  const handle = {
    queryPermission: async (o) => { calls.push(['query', o.mode]); return 'prompt'; },
    requestPermission: async () => { calls.push(['request']); return 'granted'; },
  };
  assert.equal(await queryVideoRootPermission(handle), 'prompt');
  assert.deepEqual(calls, [['query', 'read']]);
  assert.equal(await queryVideoRootPermission(null), 'prompt');
  assert.equal(await queryVideoRootPermission({ queryPermission: async () => { throw new Error('x'); } }), 'prompt');
});

test('requestVideoRootPermission は読み取りで要求し、失敗・ハンドル無しは denied', async () => {
  let mode = null;
  assert.equal(await requestVideoRootPermission({ requestPermission: async (o) => { mode = o.mode; return 'granted'; } }), 'granted');
  assert.equal(mode, 'read');
  assert.equal(await requestVideoRootPermission(null), 'denied');
  assert.equal(await requestVideoRootPermission({ requestPermission: async () => { throw new Error('x'); } }), 'denied');
});
