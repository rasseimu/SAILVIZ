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
import { randomBytes } from 'node:crypto';

export function createApi({ dataDir, repo, token, geminiKey, viewUser, viewPassword }) {
  // 保存の窓口。明示 repo が無ければ dataDir からファイル実装を組み立てる(既存挙動のまま)。
  const store = repo || createFileRepo(dataDir);
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

    const ctx = {
      store, token, geminiKey, viewEnabled, viewSecret, viewUser, viewPassword,
      secureCookie, path, method, requireViewer, requireWrite,
    };

    try {
      if (path === '/api/health') { send(res, 200, { ok: true }); return true; }

      if (await basemapRoute(req, res, ctx)) return true;
      if (await aiRoute(req, res, ctx)) return true;
      if (await compatRoute(req, res, ctx)) return true;
      send(res, 404, { error: 'no route' });
      return true;
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
      return true;
    }
  };
}
