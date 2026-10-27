// 保存フォルダの FileSystemDirectoryHandle を IndexedDB に永続化する。
// ハンドルは structured-clone 可能なので IndexedDB に直接保存できる。
const DB_NAME = 'sailviz';
const STORE = 'handles';
const KEY = 'projectDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(handle) {
  await saveHandle(KEY, handle);
}

export async function loadDirHandle() {
  return loadHandle(KEY);
}

// 権限を確認し、未許可なら要求する。granted になれば true。
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// キーを指定してハンドルを保存・復元する(動画ルートは 'videoRootDir'。保存フォルダの 'projectDir' とは別)。
export async function saveHandle(key, handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadHandle(key) {
  const db = await openDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

// 権限の確認だけ(要求はしない。ユーザー操作なしで呼んでもダイアログは出ない)。
// 'granted' | 'prompt' | 'denied'。ハンドルが無い・確認できなければ 'prompt'。
export async function queryHandlePermission(handle, mode = 'read') {
  if (!handle || typeof handle.queryPermission !== 'function') return 'prompt';
  try { return await handle.queryPermission({ mode }); } catch { return 'prompt'; }
}
