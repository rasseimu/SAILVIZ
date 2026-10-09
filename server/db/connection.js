// server/db/connection.js
// node:sqlite の接続。WAL(同時読み取り向上)と外部キー制約を有効にする。
// node:sqlite は Node >=22.5(実験的)/ 24(安定)が要る。
import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  // :memory: では journal_mode=WAL は 'memory' になるが害はない。
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
