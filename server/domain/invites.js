// server/domain/invites.js
// 組織の招待コード(設計書 v2 §5.1 org_invites / §10.3)。純関数(DB・HTTP・時刻に触れない)。
import { randomBytes } from 'node:crypto';

export const DAY_MS = 24 * 60 * 60 * 1000;
// 正本に値が無いので S2.9 で選んだ上限(報告に記載)。
export const MAX_EXPIRES_IN_DAYS = 365;
export const MAX_USES_LIMIT = 1000;

// 招待の状態: 'revoked' | 'expired' | 'exhausted' | 'valid'(行が無ければ null)。
// expires_at <= now で期限切れ、use_count >= max_uses で上限超過。NULL は無期限/無制限。
export function inviteStatus(inv, now) {
  if (!inv) return null;
  if (inv.revoked_at != null) return 'revoked';
  if (inv.expires_at != null && inv.expires_at <= now) return 'expired';
  if (inv.max_uses != null && inv.use_count >= inv.max_uses) return 'exhausted';
  return 'valid';
}

const intIn = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// POST /api/orgs/:orgId/invites の本文。省略・null は「無期限/無制限」。
export function validateInviteInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { ok: true, expiresInDays: null, maxUses: null };
  if (b.expiresInDays != null) {
    if (!intIn(b.expiresInDays, 1, MAX_EXPIRES_IN_DAYS)) {
      return { ok: false, message: `expiresInDays は 1〜${MAX_EXPIRES_IN_DAYS} の整数にしてください` };
    }
    out.expiresInDays = b.expiresInDays;
  }
  if (b.maxUses != null) {
    if (!intIn(b.maxUses, 1, MAX_USES_LIMIT)) {
      return { ok: false, message: `maxUses は 1〜${MAX_USES_LIMIT} の整数にしてください` };
    }
    out.maxUses = b.maxUses;
  }
  return out;
}

export const expiresAtFromDays = (days, now) => (days == null ? null : now + days * DAY_MS);

// 128 ビットのランダム値(URL-safe)。
export const generateInviteCode = () => randomBytes(16).toString('base64url');
