// server/repos/practiceDayFor.js
// 練習日の器(practice_days)を「組織×日付／本人×日付」で探す(無ければ作る)共用処理。
// 記録セッションの紐付け(sessionsRepo)と、アプリからの練習日の作成・振り返り(appRepo)が同じ器を使う。
import { randomBytes } from 'node:crypto';
import { jstMidnightMs } from '../sensorimport.js';
import { emptyProject } from '../minutesimport.js';
import { uniqueProjectName } from '../../src/projectfs.js';

const two = (n) => String(n).padStart(2, '0');

// JST の 'YYYY-MM-DD'。
export function jstDate(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

// 練習(Web の project 形)の日付 ms。startMs が有限数ならそれ、無ければ date('YYYY/M/D' か 'YYYY-MM-DD')の JST 0:00。
// どちらも読めなければ null。
export function practiceDateToMs(practice) {
  if (Number.isFinite(practice?.startMs)) return practice.startMs;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(practice?.date ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return utc.getTime() - 9 * 3600 * 1000;
}

// 同じ日に器が複数あれば最初に作られた器(§5.2)。新しい器は Web の練習一覧に出るよう名前と practiceDate を持つ。
export function dayFor(db, { orgId, ownerUserId, firstPointMs, now }) {
  const date = jstDate(firstPointMs);
  const found = orgId
    ? db.prepare('SELECT * FROM practice_days WHERE org_id = ? AND date = ? ORDER BY created_at, id LIMIT 1').get(orgId, date)
    : db.prepare('SELECT * FROM practice_days WHERE org_id IS NULL AND owner_user_id = ? AND date = ? ORDER BY created_at, id LIMIT 1').get(ownerUserId, date);
  if (found) return found;
  const existing = new Set(db.prepare('SELECT legacy_name FROM practice_days WHERE legacy_name IS NOT NULL').all().map((r) => r.legacy_name));
  const ws = emptyProject(jstMidnightMs(firstPointMs), new Date(now).toISOString());
  delete ws.tracks;
  delete ws.reflections;
  const row = {
    id: `pd_${randomBytes(5).toString('hex')}`, org_id: orgId ?? null, owner_user_id: orgId ? null : ownerUserId,
    date, legacy_name: uniqueProjectName(firstPointMs, existing), web_state: JSON.stringify(ws),
    saved_at: ws.savedAt, rev: 0, created_at: now, updated_at: now,
  };
  db.prepare(`INSERT INTO practice_days (id, org_id, owner_user_id, date, legacy_name, web_state, saved_at, rev, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.org_id, row.owner_user_id, row.date, row.legacy_name, row.web_state, row.saved_at, row.rev, row.created_at, row.updated_at);
  return row;
}
