// server/domain/accountInput.js
// アカウント API の入力検証(純関数・設計書 v2 §4.1・§10.2)。
// 戻り値は { ok:true, value } または { ok:false, message }。
import { validatePassword } from './password.js';

export const VISIBILITIES = ['private', 'org', 'public'];
const MAX_EMAIL = 254;
const MAX_TEXT = 200;

export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function isValidEmail(v) {
  const e = normalizeEmail(v);
  return e.length > 0 && e.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const bad = (message) => ({ ok: false, message });

// §4.1: メール・パスワード・氏名・所属・同意日時が必須。
export function validateRegister(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!isValidEmail(b.email)) return bad('メールアドレスの形式が正しくありません');
  const pw = validatePassword(b.password);
  if (!pw.ok) return bad(pw.reason === 'too_short' ? 'パスワードは8文字以上にしてください' : 'パスワードが正しくありません');
  const name = text(b.name);
  if (!name || name.length > MAX_TEXT) return bad('氏名を入力してください');
  const affiliationText = text(b.affiliationText);
  if (!affiliationText || affiliationText.length > MAX_TEXT) return bad('所属を入力してください');
  if (!Number.isFinite(b.agreedAt) || b.agreedAt <= 0) return bad('規約等への同意が必要です(agreedAt)');
  return {
    ok: true,
    value: { email: normalizeEmail(b.email), password: b.password, name, affiliationText, agreedAt: Math.trunc(b.agreedAt) },
  };
}

// PATCH /api/me。渡されたキーだけ検証する。空の更新は不可。
export function validateProfilePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const value = {};
  if (b.name !== undefined) {
    const name = text(b.name);
    if (!name || name.length > MAX_TEXT) return bad('氏名を入力してください');
    value.name = name;
  }
  if (b.affiliationText !== undefined) {
    const a = text(b.affiliationText);
    if (!a || a.length > MAX_TEXT) return bad('所属を入力してください');
    value.affiliationText = a;
  }
  if (b.defaultVisibility !== undefined) {
    if (!VISIBILITIES.includes(b.defaultVisibility)) return bad('defaultVisibility は private / org / public のいずれかです');
    value.defaultVisibility = b.defaultVisibility;
  }
  if (b.email !== undefined) {
    if (!isValidEmail(b.email)) return bad('メールアドレスの形式が正しくありません');
    value.email = normalizeEmail(b.email);
  }
  if (!Object.keys(value).length) return bad('更新する項目がありません');
  return { ok: true, value };
}
