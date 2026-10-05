// server/repos/openRepo.js
// 保存先の切替。STORAGE=db なら node:sqlite を開いてマイグレーションを当て DB 版リポジトリを、
// それ以外はファイル版リポジトリを返す。db ハンドルは呼び出し側が終了時に閉じる(index.js)。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate, loadMigrations } from '../db/migrate.js';
import { createFileRepo } from './fileRepo.js';
import { createDbRepo } from './dbRepo.js';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export function openRepo({ storage, dataDir, dbPath } = {}) {
  if (storage === 'db') {
    const db = openDb(dbPath || join(dataDir, 'sailviz.db'));
    migrate(db, loadMigrations(MIG_DIR));
    return { repo: createDbRepo({ db, dataDir }), db };
  }
  return { repo: createFileRepo(dataDir), db: null };
}
