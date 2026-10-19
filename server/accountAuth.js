// server/accountAuth.js
// アカウントのトークン発行・照合(設計書 v2 §4.3)。accountsRepo の auth_tokens / email_tokens を使う。
// 平文トークンは発行時に一度だけ返し、DB にはハッシュだけ保存する。HTTP は扱わない(ルートは S2.3)。
import { timingSafeEqual } from 'node:crypto';
import { generateToken, hashToken, AUTH_TOKEN_TTL_MS, EMAIL_TOKEN_TTL_MS } from './domain/tokens.js';
import { extractCredentials } from './auth.js';

export function issueAuthToken(repo, userId, now = Date.now()) {
  const token = generateToken();
  const expiresAt = now + AUTH_TOKEN_TTL_MS;
  const id = repo.createAuthToken({ userId, tokenHash: hashToken(token), expiresAt, now });
  return { token, id, expiresAt };
}

// 有効なら { user, tokenId }、無効(未知・失効・期限切れ・削除済みユーザー)なら null。
// 有効なら最終使用を更新し、期限を now+60 日へスライドさせる。
export function authenticateToken(repo, token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const row = repo.getAuthTokenByHash(hashToken(token));
  if (!row || row.revoked_at != null) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  const user = repo.getUser(row.user_id);
  if (!user || user.deleted_at != null) return null;
  repo.touchAuthToken(row.id, { lastUsedAt: now, expiresAt: now + AUTH_TOKEN_TTL_MS });
  return { user, tokenId: row.id };
}

// ログアウト(このトークンだけ失効)。失効させたら true。
export function revokeToken(repo, token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return false;
  const row = repo.getAuthTokenByHash(hashToken(token));
  return row ? repo.revokeAuthToken(row.id, now) : false;
}

// ---- メール確認・再設定・変更のワンタイムトークン ----
export function issueEmailToken(repo, { userId, purpose, newEmail, now = Date.now() }) {
  const ttl = EMAIL_TOKEN_TTL_MS[purpose];
  if (!ttl) throw new Error(`invalid purpose: ${purpose}`);
  const token = generateToken();
  const expiresAt = now + ttl;
  const id = repo.createEmailToken({ userId, purpose, tokenHash: hashToken(token), newEmail, expiresAt });
  return { token, id, expiresAt };
}

// peek と consume が共有する検証条件(目的一致・未使用・期限内)。有効な行か null を返す。
function findUsableEmailToken(repo, token, purpose, now) {
  if (typeof token !== 'string' || !token) return null;
  const row = repo.getEmailTokenByHash(hashToken(token));
  if (!row || row.purpose !== purpose || row.used_at != null) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  return row;
}

// 消費せずに検証する。consumeEmailToken と同じ条件で { userId, newEmail } か null を返す。
export function peekEmailToken(repo, token, purpose, now = Date.now()) {
  const row = findUsableEmailToken(repo, token, purpose, now);
  return row ? { userId: row.user_id, newEmail: row.new_email ?? null } : null;
}

// 使用する。目的が合い・未使用・期限内なら { userId, newEmail } を返して使用済みにする。それ以外は null。
// 二重使用は2回目が null(markEmailTokenUsed の更新件数で判定)。
export function consumeEmailToken(repo, token, purpose, now = Date.now()) {
  const row = findUsableEmailToken(repo, token, purpose, now);
  if (!row) return null;
  if (!repo.markEmailTokenUsed(row.id, now)) return null;
  return { userId: row.user_id, newEmail: row.new_email ?? null };
}

// 共有トークン(SAILVIZ_WRITE_TOKEN)との時間一定比較。
function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// リクエストの身元。旧共有ログインとアカウントのトークンが共存する(S2.5 で並走)。
//   { kind: 'shared' }            … 共有トークン(Bearer または Cookie sailviz_token)と一致
//   { kind: 'user', user, tokenId } … DB のアカウントトークンが有効
//   null                          … どちらでもない
// 共有トークンを先に判定するので、旧経路の挙動は変わらない。repo が無ければアカウント照合はしない。
// 共有トークンの候補は Bearer と旧 Cookie sailviz_token、アカウントの候補は Bearer と Cookie sailviz_session
// (Cookie 名を分けたので、両方のログインが同じブラウザにあっても互いに隠れない)。
export function resolveIdentity(req, { writeToken, repo, now = Date.now() } = {}) {
  const { bearer, session, legacy } = extractCredentials(req);
  if (sameSecret(bearer, writeToken) || sameSecret(legacy, writeToken)) return { kind: 'shared' };
  if (!repo) return null;
  for (const token of [bearer, session]) {
    if (!token) continue;
    const hit = authenticateToken(repo, token, now);
    if (hit) return { kind: 'user', user: hit.user, tokenId: hit.tokenId };
  }
  return null;
}
