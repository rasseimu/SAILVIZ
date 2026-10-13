// server/domain/orgCreate.js
// 組織の作成(POST /api/orgs)の純粋な規則。DB・HTTP・時刻に触れない。
// 回数制限は routes/auth.js の LIMITS.orgCreate(domain/rateLimit.js)を使う。
export const ORG_NAME_MAX = 80;
export const MAX_ORGS_PER_USER = 5; // 1ユーザーが管理者になれる組織の上限

// 戻り値: { ok:true, name } | { ok:false, message }
export function validateOrgName(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'name は文字列で指定してください' };
  const name = raw.trim();
  if (!name) return { ok: false, message: '組織名を入力してください' };
  if ([...name].length > ORG_NAME_MAX) {
    return { ok: false, message: `組織名は ${ORG_NAME_MAX} 文字以内にしてください` };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: '組織名に制御文字は使えません' };
  return { ok: true, name };
}
