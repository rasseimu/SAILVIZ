// test/helpers/apiHarness.js — API テストの共通土台。:memory: の DB にマイグレーションを当て、createApi を立てる。
// node:sqlite が要る(Node 24)ので、使うテストは skip を付ける。合成データのみ。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from '../../server/api.js';

const [major] = process.versions.node.split('.').map(Number);
export const skip = major >= 24 ? undefined : 'node:sqlite(Node >=24)が要る';
export const clock = 1_000_000;
const MIG_DIR = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url));

// extra は createApi へ足す引数(例: アプリ向け API の repo)。
export async function startApi(extra = {}) {
  const { openDb } = await import('../../server/db/connection.js');
  const { migrate, loadMigrations } = await import('../../server/db/migrate.js');
  const { createAccountsRepo } = await import('../../server/repos/accountsRepo.js');
  const { createDbRepo } = await import('../../server/repos/dbRepo.js');
  const { createSessionsRepo } = await import('../../server/repos/sessionsRepo.js');
  const { createAppRepo } = await import('../../server/repos/appRepo.js');
  const { issueAuthToken } = await import('../../server/accountAuth.js');
  const db = openDb(':memory:');
  migrate(db, loadMigrations(MIG_DIR));
  const accounts = createAccountsRepo({ db });
  const repo = createDbRepo({ db, dataDir: '/nonexistent' });
  const sessions = createSessionsRepo({ db });
  const app = createAppRepo({ db });
  const api = createApi({ repo, token: 'shared-secret', accounts, sessions, app, authOptions: { now: () => clock }, ...extra });
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
  const close = async () => {
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { base, db, accounts, repo, sessions, app, mkUser, mkOrg, call, close };
}
