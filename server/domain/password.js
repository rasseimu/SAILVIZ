// server/domain/password.js
// パスワードのハッシュと照合(設計書 v2 §4.1・§4.3)。node:crypto の scrypt のみ・依存なし。
// 保存形式: scrypt$N$r$p$<salt base64url>$<hash base64url>
//   ソルトとパラメータを文字列に含めるので、後でパラメータを上げても既存ハッシュを照合できる(needsRehash)。
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8; // §4.1
export const MAX_PASSWORD_LENGTH = 1024; // scrypt への過大入力を避ける上限(設計書に無い実装上の安全弁)

// 現在のパラメータ(設計書は「scrypt」としか定めていない。選定理由は S2.2 の報告に記載)。
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 3, keyLen: 32, saltLen: 16 }); // OWASP 最小推奨(S2.2-P3・H22=a)。旧 p=1 は needsRehash で上がる
// maxmem は固定。scrypt のメモリは約 128*N*r(+128*r*p)で p にほぼ比例しない。MAX_MEM_BYTES 以下に限るので余裕を足した値にする。
const MAXMEM = 80 * 1024 * 1024;
// 保存値から読んだパラメータの上限(壊れた/悪意ある値でメモリ・CPU を食わないため。本番 VM が 256MB の可能性がある)
const MAX_MEM_BYTES = 64 * 1024 * 1024; // メモリの見積り 128*N*r の上限。現行(N=32768・r=8)は 32MiB
const MAX_COST_BYTES = 128 * 1024 * 1024; // CPU 作業量の目安 128*N*r*p の上限。現行(p=3)は 96MiB、旧 p=1 は 32MiB
const MAX_HASH_BYTES = 64; // 保存値の hash 長(= keyLen)の上限
const LIMITS = { N: 1 << 20, r: 32, p: 16 };

const derive = (password, salt, { N, r, p }, keyLen) => new Promise((resolve, reject) => {
  scrypt(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: MAXMEM },
    (err, key) => (err ? reject(err) : resolve(key)));
});

// 注意: 下限はコードポイント数、上限は UTF-16 の長さ(String#length)で、どちらも NFKC 正規化の前に数える。
export function validatePassword(password) {
  if (typeof password !== 'string') return { ok: false, reason: 'not_string' };
  if ([...password].length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

export async function hashPassword(password, params = SCRYPT_PARAMS) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) throw new TypeError('invalid password');
  const salt = randomBytes(params.saltLen);
  const key = await derive(password, salt, params, params.keyLen);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (r < 1 || p < 1 || N > LIMITS.N || r > LIMITS.r || p > LIMITS.p) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (128 * N * r > MAX_MEM_BYTES || 128 * N * r * p > MAX_COST_BYTES) return null;
  // OpenSSL の scrypt は N < 2^(16r) を要求する(r=1 なら N<65536)。満たさない値は照合不能なので不正扱い。
  if (16 * r < 53 && N >= 2 ** (16 * r)) return null;
  if (!salt.length || !hash.length || hash.length > MAX_HASH_BYTES) return null;
  return { N, r, p, salt, hash };
}

// 照合。形式不正・パスワード不一致は false。比較は時間一定。
export async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const key = await derive(password, parsed.salt, parsed, parsed.hash.length);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

// ログイン成功時に呼び、true なら新パラメータで保存し直す(「後で強度を上げられる」§4.1)。
export function needsRehash(stored, params = SCRYPT_PARAMS) {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.N !== params.N || parsed.r !== params.r || parsed.p !== params.p
    || parsed.salt.length !== params.saltLen || parsed.hash.length !== params.keyLen;
}
