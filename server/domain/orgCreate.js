// server/domain/orgCreate.js
// 組織の作成(POST /api/orgs)の純粋な規則。DB・HTTP・時刻に触れない。
// 回数制限は routes/auth.js の LIMITS.orgCreate(domain/rateLimit.js)を使う。
export const ORG_NAME_MAX = 80;
export const MAX_ORGS_PER_USER = 5; // 1ユーザーが管理者になれる組織の上限

// 禁止する符号位置の範囲 [from, to]。C0・DEL・C1、ALM(061C)、LRM/RLM(200E-200F)、
// 行/段落区切り(2028-2029)、LRE〜RLO(202A-202E)、LRI〜PDI(2066-2069)、
// ゼロ幅スペース(200B)・WORD JOINER と不可視演算子(2060-2064)・BOM/ZWNBSP(FEFF)、
// タグ文字(E0000-E007F)、対になっていないサロゲート(D800-DFFF。[...name] は対のものを 1 文字にまとめるので、ここに残るのは孤立したもの)。
// ZWJ(200D)・ZWNJ(200C)は絵文字の結合・文字の字形に要るので許可する。
const FORBIDDEN_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x061c, 0x061c], [0x200b, 0x200b], [0x200e, 0x200f],
  [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069],
  [0xd800, 0xdfff], [0xfeff, 0xfeff], [0xe0000, 0xe007f],
];
const isForbiddenChar = (cp) => FORBIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b);

// 戻り値: { ok:true, name } | { ok:false, message }
export function validateOrgName(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'name は文字列で指定してください' };
  const name = raw.trim();
  if (!name) return { ok: false, message: '組織名を入力してください' };
  if ([...name].length > ORG_NAME_MAX) {
    return { ok: false, message: `組織名は ${ORG_NAME_MAX} 文字以内にしてください` };
  }
  if ([...name].some((ch) => isForbiddenChar(ch.codePointAt(0)))) {
    return { ok: false, message: '組織名に制御文字は使えません' };
  }
  return { ok: true, name };
}
