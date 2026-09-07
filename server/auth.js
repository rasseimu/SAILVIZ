// server/auth.js
// 共有トークンの抽出・照合。DOM/http 非依存の純関数でテストする。
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookies = parseCookies(req.headers.cookie);
  return cookies.sailviz_token || null;
}

export function isAuthorized(req, token) {
  if (!token) return false;
  return extractToken(req) === token;
}
