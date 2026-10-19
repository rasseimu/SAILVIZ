// server/api.js
// http (req,res) を受け /api/* を処理。処理したら true を返す。
// ルートは routes/ のモジュールに分割し、ここは順番に試す小さなディスパッチャに徹する。
// 保存の窓口(repo)・閲覧ゲートの状態・認可ヘルパを ctx にまとめて各ルートへ渡す。
import { send } from './routes/http.js';
import { isAuthorized, isViewer } from './auth.js';
import { createFileRepo } from './repos/fileRepo.js';
import { basemapRoute } from './routes/basemap.js';
import { aiRoute } from './routes/ai.js';
import { compatRoute } from './routes/compat.js';
import { createAuthRoute, unavailableRoute } from './routes/auth.js';
import { createOrgsRoute } from './routes/orgs.js';
import { createMailer } from './mail.js';
import { resolveSubject } from './compatPrincipal.js';
import { randomBytes } from 'node:crypto';

// accounts(accountsRepo)があればアカウント API(§10.2)が有効。無い(STORAGE=file)ときは該当パスが 503。
// mailer / baseUrl は確認・再設定メール用(MAIL_PROVIDER 未設定なら log)。authOptions はテスト用の差し替え。
export function createApi({
  dataDir, repo, token, geminiKey, viewUser, viewPassword, accounts, mailer, baseUrl, authOptions = {},
  migrationOrgId,
}) {
  // 保存の窓口。明示 repo が無ければ dataDir からファイル実装を組み立てる(既存挙動のまま)。
  const store = repo || createFileRepo(dataDir);
  const authRoute = accounts
    ? createAuthRoute({
      accounts, mailer: mailer || createMailer({ redactToken: process.env.NODE_ENV === 'production' }), baseUrl: baseUrl || 'http://localhost:8000', writeToken: token,
      secureCookie: process.env.NODE_ENV === 'production' ? '; Secure' : '', ...authOptions,
    })
    : unavailableRoute;
  const orgsRoute = accounts
    ? createOrgsRoute({
      accounts, writeToken: token, now: authOptions.now, baseUrl: baseUrl || 'http://localhost:8000',
    })
    : async () => false;
  // 閲覧ゲート: user/password が両方設定されている時のみ有効。
  // 有効時はランダム秘密を発行し、ログイン成功で Cookie に載せる(パスワードは載せない)。
  const viewEnabled = Boolean(viewUser && viewPassword);
  const viewSecret = viewEnabled ? randomBytes(24).toString('hex') : null;

  return async function api(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    const method = req.method;
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    // 閲覧セッションを要求するヘルパ。未ログインなら 401 を返して true(処理済み)。
    const requireViewer = () => {
      if (isViewer(req, viewSecret, token)) return false;
      send(res, 401, { error: 'login required' });
      return true;
    };
    // 書き込みを要求するヘルパ。編集モードは廃止し、閲覧ゲート有効時は閲覧ログイン
    // (または編集トークン)、無効時は編集トークンを要求する。未認証なら 401。
    const requireWrite = () => {
      const ok = viewEnabled ? isViewer(req, viewSecret, token) : isAuthorized(req, token);
      if (ok) return false;
      send(res, 401, { error: 'unauthorized' });
      return true;
    };

    // 互換 API の認可(policy.js)用の主体。リクエストごとに1度だけ組み立てる。未ログインは null。
    let subject;
    const getSubject = () => {
      if (subject === undefined) {
        subject = resolveSubject(req, {
          token, viewEnabled, viewSecret, accounts, migrationOrgId, now: (authOptions.now || Date.now)(),
        });
      }
      return subject;
    };

    const ctx = {
      store, token, geminiKey, viewEnabled, viewSecret, viewUser, viewPassword,
      secureCookie, path, method, requireViewer, requireWrite, getSubject,
    };

    try {
      if (path === '/api/health') { send(res, 200, { ok: true }); return true; }

      if (await basemapRoute(req, res, ctx)) return true;
      if (await aiRoute(req, res, ctx)) return true;
      if (await authRoute(req, res, ctx)) return true;
      if (await orgsRoute(req, res, ctx)) return true;
      if (await compatRoute(req, res, ctx)) return true;
      send(res, 404, { error: 'no route' });
      return true;
    } catch (e) {
      // 壊れた JSON(readBody)は 400。旧 API の 400 と同じ { error: 文字列 } の形。
      if (e && e.code === 'bad_json') { send(res, 400, { error: 'bad json' }); return true; }
      // 内部の例外メッセージは利用者へ返さない。ログにも e.message は出さない
      // (入力の断片=パスワード等が入りうる)。例外名とスタックのフレーム行だけ出す。
      const frames = String(e && e.stack || '').split('\n').filter((l) => /^\s+at /.test(l)).join('\n');
      console.error(`[api] ${method} ${path} -> 500: ${e && e.name || 'Error'}\n${frames}`);
      send(res, 500, { error: 'internal_error' });
      return true;
    }
  };
}
