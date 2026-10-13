// server/domain/tokens.js
// 不透明トークンの生成とハッシュ(設計書 v2 §4.3)。DB にはハッシュだけ保存し、平文は発行時に一度だけ返す。
import { randomBytes, createHash } from 'node:crypto';

export const TOKEN_BYTES = 32; // §4.3「ランダム 32 バイト以上」
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUTH_TOKEN_TTL_MS = 60 * DAY_MS; // §4.3 最終使用から 60 日(スライド)
// メール確認・再設定トークンの有効期限。設計書に値が無いので S2.2 で選んだ値(報告に記載)。
export const EMAIL_TOKEN_TTL_MS = { verify: 3 * DAY_MS, reset: 60 * 60 * 1000, change: 3 * DAY_MS };

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// 入力が高エントロピーなランダム値なので、パスワード用の遅いハッシュは不要(SHA-256 で十分)。
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
