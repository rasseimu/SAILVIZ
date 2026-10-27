// test/helpers/apiHarness.js — API テストの共通土台。:memory: の DB にマイグレーションを当て、createApi を立てる。
// node:sqlite が要る(Node 24)ので、使うテストは skip を付ける。合成データのみ。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from '../../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
export const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
export const clock = 1_000_000;
const MIG_DIR = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url));
// 記録の点の起点: 2026-10-26 09:00 JST から 1 秒ごと。
export const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const chunkCsv = (from, n, t0) => {
  const rows = ['time,latitude,longitude,speed,horizontalaccuracy'];
  for (let i = from; i < from + n; i++) rows.push(`${t0 + i * 1000},${(35.3 + i * 0.0001).toFixed(6)},${(139.48 + i * 0.0001).toFixed(6)},2.5,4.8`);
  return rows.join('\n') + '\n';
};

// extra は createApi へ足す引数(例: アプリ向け API の repo)。
export async function startApi(extra = {}) {
  const { openDb } = await import('../../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../../server/db/migrate.js');
  const { createAccountsRepo } = await import('../../server/repos/accountsRepo.js');
  const { createDbRepo } = await import('../../server/repos/dbRepo.js');
  const { createSessionsRepo } = await import('../../server/repos/sessionsRepo.js');
  const { createAppRepo } = await import('../../server/repos/appRepo.js');
  const { createVideoCommentsRepo } = await import('../../server/repos/videoCommentsRepo.js');
  const { issueAuthToken } = await import('../../server/accountAuth.js');
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const repo = createDbRepo({ db, dataDir: '/nonexistent' });
  const sessions = createSessionsRepo({ db });
  const app = createAppRepo({ db });
  const videoComments = createVideoCommentsRepo({ db });
  const api = createApi({ repo, token: 'shared-secret', accounts, sessions, app, videoComments, authOptions: { now: () => clock }, ...extra });
  const server = createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;
  const mkUser = () => {
    seq += 1;
    const u = accounts.createUser({ email: `s${seq}@example.test`, name: `乗員${seq}`, passwordHash: 'x', now: clock });
    accounts.markEmailVerified(u.id, clock);
    return { user: u, tok: issueAuthToken(accounts, u.id, clock).token };
  };
  const mkOrg = (...members) => {
    const org = accounts.createOrg({ name: 'テスト組織', adminUserIds: [members[0].user.id], now: clock });
    for (const m of members) accounts.linkMember({ orgId: org.id, userId: m.user.id, rosterId: null, now: clock });
    return org;
  };
  const call = (method, path, tok, body, headers = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(typeof body === 'string' ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }),
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  // 登録 → 2 チャンク → finalize まで(test/sessions-api.test.js の recordFull と同じ)。失敗は例外。
  // extra は POST の本文へ足す(例: { kind: 'race' }・{ visibility: 'org' })。t0 で点の起点日を変えられる。
  const recordFull = async (me, extra = {}, headers = {}, t0 = T0) => {
    const s = {
      id: randomUUID(), kind: 'practice', boatNo: '4321',
      crew: [{ role: 'helm', userId: me.user.id, name: me.user.name }],
      startedMs: t0, device: { platform: 'ios', osVersion: '27.0', app: '1.0.0' }, ...extra,
    };
    const ok = async (r) => { if (r.status !== 200) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
    await ok(await call('POST', '/api/sessions', me.tok, s, headers));
    for (const [seq, csv] of [[0, chunkCsv(0, 3, t0)], [1, chunkCsv(3, 2, t0)]]) {
      await ok(await call('PUT', `/api/sessions/${s.id}/chunks/${seq}`, me.tok, csv, { 'x-chunk-sha256': sha(csv), ...headers }));
    }
    const fin = await ok(await call('POST', `/api/sessions/${s.id}/finalize`, me.tok, { endedMs: t0 + 5000, chunkCount: 2 }, headers));
    return { s, fin };
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { base, db, accounts, repo, sessions, app, videoComments, mkUser, mkOrg, call, recordFull, close };
}
