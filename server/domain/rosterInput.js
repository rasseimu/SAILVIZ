// server/domain/rosterInput.js
// 名簿(PUT /api/orgs/:orgId/roster)の入力検証。純関数(設計書 v2 §4.4・§10.3)。
// 1行は「氏名・メール・旧名簿の氏名(任意)」。メールの無い行は照合されないだけで許す。
// 戻り値: { ok:true, rows:[{name,email,legacyName}] } | { ok:false, message, code? }
import { isValidEmail, normalizeEmail } from './accountInput.js';

export const ROSTER_MAX_ROWS = 1000;
const MAX_TEXT = 200;
const bad = (message, code) => ({ ok: false, message, ...(code ? { code } : {}) });

export function validateRosterRows(raw) {
  if (!Array.isArray(raw)) return bad('roster は配列で指定してください');
  if (raw.length > ROSTER_MAX_ROWS) return bad(`名簿は ${ROSTER_MAX_ROWS} 行までです`);
  const rows = [];
  const seen = new Map();
  const seenLegacy = new Map();
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const n = i + 1;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return bad(`${n} 行目: オブジェクトで指定してください`);
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.trim().length > MAX_TEXT) {
      return bad(`${n} 行目: 氏名を入力してください`);
    }
    let email = null;
    if (r.email !== undefined && r.email !== null && r.email !== '') {
      if (!isValidEmail(r.email)) return bad(`${n} 行目: メールアドレスの形式が正しくありません`);
      email = normalizeEmail(r.email);
    }
    let legacyName = null;
    if (r.legacyName !== undefined && r.legacyName !== null) {
      if (typeof r.legacyName !== 'string' || r.legacyName.trim().length > MAX_TEXT) {
        return bad(`${n} 行目: 旧名簿の氏名が正しくありません`);
      }
      legacyName = r.legacyName.trim() || null;
    }
    if (legacyName !== null) {
      if (seenLegacy.has(legacyName)) return bad(`${n} 行目: 旧名簿の氏名が ${seenLegacy.get(legacyName)} 行目と重複しています`, 'duplicate_legacy_name');
      seenLegacy.set(legacyName, n);
    }
    if (email !== null) {
      if (seen.has(email)) return bad(`${n} 行目: メールアドレスが ${seen.get(email)} 行目と重複しています`, 'duplicate_email');
      seen.set(email, n);
    }
    rows.push({ name: r.name.trim(), email, legacyName });
  }
  return { ok: true, rows };
}
