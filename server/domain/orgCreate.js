// server/domain/orgCreate.js
// 組織の作成(POST /api/orgs)の純粋な規則。DB・HTTP・時刻に触れない(時刻は引数)。
export const ORG_NAME_MAX = 80;
export const MAX_ORGS_PER_USER = 5;       // 1ユーザーが管理者になれる組織の上限
export const ORG_CREATE_RATE = { limit: 10, windowMs: 60 * 60 * 1000 }; // 1時間に10回(失敗も数える)

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

// キーごとの固定長でない(スライディング)窓の回数制限。メモリ内(マシン1台前提)。
// check(key, now) → true なら許可して記録、false なら制限超過。
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    check(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => t > now - windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}
