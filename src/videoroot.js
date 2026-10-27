// 動画ルート(Drive for Desktop の同期フォルダ内の `練習動画` フォルダ)のハンドル。
// IndexedDB の 'videoRootDir' に1つだけ記憶する(保存フォルダの 'projectDir' とは別)。
// 自動の経路では queryPermission だけを使い、requestPermission はボタンのクリックからだけ呼ぶ。
import { saveHandle, loadHandle, queryHandlePermission } from './dirhandle.js';

const KEY = 'videoRootDir';

export const videoRootSupported = () => typeof globalThis.showDirectoryPicker === 'function';

// 記憶した動画ルート。無い・読めなければ null。
export async function loadVideoRoot() {
  try { return await loadHandle(KEY); } catch { return null; }
}

// フォルダ選択ダイアログ(読み取り)で動画ルートを選び、記憶する。キャンセルは null。
// ユーザー操作(クリック)の中から呼ぶ。
export async function chooseVideoRoot(current = null) {
  let dir;
  try {
    dir = await globalThis.showDirectoryPicker({ mode: 'read', ...(current ? { startIn: current } : {}) });
  } catch { return null; } // キャンセル
  try { await saveHandle(KEY, dir); } catch { /* 永続化失敗は致命ではない(このページの間は使える) */ }
  return dir;
}

export const queryVideoRootPermission = (handle) => queryHandlePermission(handle, 'read');

// 権限を要求する(ユーザー操作の中から呼ぶ)。'granted' | 'prompt' | 'denied'。
export async function requestVideoRootPermission(handle) {
  if (!handle || typeof handle.requestPermission !== 'function') return 'denied';
  try { return await handle.requestPermission({ mode: 'read' }); } catch { return 'denied'; }
}

// 動画フォルダボタンの待機表示。action: choose(未設定・拒否済み)| grant(要許可)| ready(許可済み)| unsupported。
export function videoRootButtonState({ supported, hasHandle, permission, name = '' }) {
  if (!supported) return { action: 'unsupported', label: '動画フォルダ(非対応ブラウザ)' };
  if (!hasHandle) return { action: 'choose', label: '動画フォルダを設定' };
  // 拒否されたハンドルは許可を求め直せないので、フォルダを選び直してもらう。
  if (permission === 'denied') return { action: 'choose', label: '動画フォルダを選び直す' };
  if (permission !== 'granted') return { action: 'grant', label: '動画フォルダを許可' };
  return { action: 'ready', label: name ? `動画フォルダ: ${name}` : '動画フォルダ' };
}
