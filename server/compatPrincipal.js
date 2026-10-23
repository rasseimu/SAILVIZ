// server/compatPrincipal.js
// 互換 API のリクエストから policy.js の主体(subject)を組み立てる。S2.5-P2。
//   共有の書込トークン(Bearer / Cookie sailviz_token) → legacySharedPrincipal({orgId, canWrite: true})
//   アカウントのトークン(Bearer / Cookie sailviz_session) → user(userId, 所属組織, 表示中の組織)
//        表示中の組織 = ヘッダー X-Sailviz-Org(所属外は orgForbidden: true)、なければ所属の先頭。共有ログインはヘッダーを無視。
//   閲覧ゲートの Cookie sailviz_view(ゲート無効時は誰でも) → legacySharedPrincipal
//        canWrite は「閲覧ゲート有効なら true(閲覧ログイン=書き込み可。現行の requireWrite と同じ)、無効なら false」
//   どれでもなければ null(未ログイン。呼び出し側が 401)。
// orgId は MIGRATION_ORG_ID(未設定なら null = 共有ログインは何も読めない・書けない)。
import { isViewer, extractCredentials, parseCookies } from './auth.js';
import { resolveIdentity, sameSecret } from './accountAuth.js';
import { legacySharedPrincipal, user } from './domain/policy.js';

export function resolveSubject(req, {
  token, viewEnabled, viewSecret, accounts, migrationOrgId, now = Date.now(),
}) {
  const orgId = migrationOrgId || null;
  const id = resolveIdentity(req, { writeToken: token, repo: accounts || undefined, now });
  if (id?.kind === 'shared') return legacySharedPrincipal({ orgId, canWrite: true });
  if (id?.kind === 'user') {
    // 閲覧ゲートの Cookie が有効な間は、Cookie のセッション(Web)より旧共有ログインを優先する
    // (Phase 2: 旧共有ログインは組織メンバー(書き込み可)として並走)。Bearer は user のまま。
    if (viewEnabled && !extractCredentials(req).bearer
        && sameSecret(parseCookies(req.headers.cookie).sailviz_view, viewSecret)) {
      return legacySharedPrincipal({ orgId, canWrite: true });
    }
    const orgIds = accounts ? accounts.listMembershipsOfUser(id.user.id).map((m) => m.org_id) : [];
    // 表示中の組織: X-Sailviz-Org ヘッダー(所属組織のみ有効)。なし/空は所属の先頭。所属外は orgForbidden。
    const wanted = String(req.headers['x-sailviz-org'] ?? '').trim();
    if (!wanted) return user(id.user.id, orgIds, orgIds[0] ?? null);
    if (orgIds.includes(wanted)) return user(id.user.id, orgIds, wanted);
    return { ...user(id.user.id, orgIds, null), orgForbidden: true };
  }
  if (isViewer(req, viewSecret, token)) return legacySharedPrincipal({ orgId, canWrite: !!viewEnabled });
  return null;
}
