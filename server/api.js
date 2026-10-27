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
import { createSessionsRoute } from './routes/sessions.js';
import { createMeRoute } from './routes/me.js';
import { createReflectionExtrasRoute } from './routes/reflectionExtras.js';
import { createPracticeDaysRoute } from './routes/practiceDays.js';
import { createVideoCommentsRoute } from './routes/videoComments.js';
import { createStudyCommentsRoute } from './routes/studyComments.js';
import { createMailer } from './mail.js';
import { resolveSubject } from './compatPrincipal.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DELETED_DIR_NAME, saveDeleted } from './deletedData.js';
import { describeError } from './domain/errorLog.js';

// accounts(accountsRepo)があればアカウント API(§10.2)が有効。無い(STORAGE=file)ときは該当パスが 503。
// mailer / baseUrl は確認・再設定メール用(MAIL_PROVIDER 未設定なら log)。authOptions はテスト用の差し替え。
export function createApi({
  dataDir, repo, token, geminiKey, viewUser, viewPassword, accounts, mailer, baseUrl, authOptions = {},
  migrationOrgId, sessions, app, videoComments,
}) {
  // 保存の窓口。明示 repo が無ければ dataDir からファイル実装を組み立てる(既存挙動のまま)。
  const store = repo || createFileRepo(dataDir);
  const authRoute = accounts
    ? createAuthRoute({
      accounts, mailer: mailer || createMailer({ redactToken: process.env.NODE_ENV === 'production' }), baseUrl: baseUrl || 'http://localhost:8000', writeToken: token,
      secureCookie: process.env.NODE_ENV === 'production' ? '; Secure' : '', migrationOrgId, ...authOptions,
    })
    : unavailableRoute;
  const orgsRoute = accounts
    ? createOrgsRoute({
      accounts, writeToken: token, now: authOptions.now, baseUrl: baseUrl || 'http://localhost:8000', migrationOrgId,
    })
    : async () => false;
  // 記録セッション(Phase 3。§10.4)。sessions(sessionsRepo)は STORAGE=db のときだけ。無ければ 503。
  const sessionsRoute = createSessionsRoute({ sessions: accounts ? sessions : null, accounts, now: authOptions.now });
  // アプリ向け API の「自分のもの」(Phase 4。§4)。app(appRepo)は STORAGE=db のときだけ。無ければ 503。
  const meRoute = createMeRoute({ app: accounts ? app : null, accounts, now: authOptions.now });
  // 反省の進捗とコメント(Phase 4。§6)。app が無ければ /api/reflections/* は 503。
  const reflectionExtrasRoute = createReflectionExtrasRoute({ app: accounts ? app : null, accounts, now: authOptions.now });
  // 動画の瞬間コメント(②。③も共用)。videoComments(videoCommentsRepo)は STORAGE=db のときだけ。無ければ 503。
  const videoCommentsRoute = createVideoCommentsRoute({
    repo: accounts ? videoComments : null, accounts, store, now: authOptions.now,
  });
  // 勉強動画(プロ動画)の瞬間コメント(③)。同じ表(scope 'study')。編集・削除は上の videoCommentsRoute。無ければ 503。
  const studyCommentsRoute = createStudyCommentsRoute({
    repo: accounts ? videoComments : null, accounts, now: authOptions.now,
  });
  // 練習日の器(Phase 4。§7)。app・sessions が無ければ /api/practice-days* は 503。
  const practiceDaysRoute = createPracticeDaysRoute({ app: accounts ? app : null, sessions: accounts ? sessions : null, now: authOptions.now });
  // 閲覧ゲート: user/password が両方設定されている時のみ有効。
  // 有効時はランダム秘密を発行し、ログイン成功で Cookie に載せる(パスワードは載せない)。
  const viewEnabled = Boolean(viewUser && viewPassword);
  // 削除した練習の一時保管(DATA_DIR/deleted_data_folder)。dataDir が無い(テストの一部)ときは保管しない。
  const deletedDir = dataDir ? join(dataDir, DELETED_DIR_NAME) : null;
  const trash = deletedDir ? { save: (entry) => saveDeleted(deletedDir, entry, (authOptions.now || Date.now)()) } : null;
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
      secureCookie, path, method, requireViewer, requireWrite, getSubject, accounts,
      now: authOptions.now || Date.now, trash,
    };

    try {
      if (path === '/api/health') { send(res, 200, { ok: true }); return true; }

      if (await basemapRoute(req, res, ctx)) return true;
      if (await aiRoute(req, res, ctx)) return true;
      if (await authRoute(req, res, ctx)) return true;
      if (await orgsRoute(req, res, ctx)) return true;
      if (await sessionsRoute(req, res, ctx)) return true;
      if (await meRoute(req, res, ctx)) return true;
      if (await reflectionExtrasRoute(req, res, ctx)) return true;
      if (await videoCommentsRoute(req, res, ctx)) return true;
      if (await studyCommentsRoute(req, res, ctx)) return true;
      if (await practiceDaysRoute(req, res, ctx)) return true;
      if (await compatRoute(req, res, ctx)) return true;
      send(res, 404, { error: 'no route' });
      return true;
    } catch (e) {
      // 壊れた JSON(readBody)は 400。旧 API の 400 と同じ { error: 文字列 } の形。
      if (e && e.code === 'bad_json') { send(res, 400, { error: 'bad json' }); return true; }
      // 内部の例外メッセージは利用者へ返さない。ログにも e.message は出さない
      // (入力の断片=パスワード等が入りうる)。例外名とスタックのフレーム行だけ出す。
      const { name, frames } = describeError(e);
      console.error(`[api] ${method} ${path} -> 500: ${name}\n${frames}`);
      send(res, 500, { error: 'internal_error' });
      return true;
    }
  };
}
