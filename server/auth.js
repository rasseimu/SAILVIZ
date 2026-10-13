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

// Authorization: Bearer だけを見る(アプリ向け。Cookie は見ない)。無ければ null。
export function extractBearer(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth.trim());
  return m ? m[1] : null;
}

// Web のアカウント(S2.3)のセッション Cookie 名。旧共有ログインの sailviz_token(共有の書込トークンを入れる)や
// 閲覧ゲートの sailviz_view と別名にして、同じブラウザで両方にログインしても上書きし合わないようにする。
export const SESSION_COOKIE = 'sailviz_session';
export const LEGACY_TOKEN_COOKIE = 'sailviz_token';

// 認証情報の候補をすべて取り出す。bearer は不正な形(例 "Bearer a b")なら null。
export function extractCredentials(req) {
  const cookies = parseCookies(req.headers.cookie);
  return {
    bearer: extractBearer(req),
    session: cookies[SESSION_COOKIE] || null, // アカウントのセッショントークン(Web)
    legacy: cookies[LEGACY_TOKEN_COOKIE] || null, // 旧共有ログインの書込トークン
  };
}

// 優先順位は Bearer → Cookie sailviz_session → 旧 Cookie sailviz_token で、取得元も返す
// (source は 'bearer' | 'cookie' | 'legacy-cookie')。
// extractToken との違い: Authorization が不正な形(例 "Bearer a b")のとき、extractToken は "a b" を返すが、
// extractAuth は Bearer を無いものとして Cookie にフォールバックする。
export function extractAuth(req) {
  const { bearer, session, legacy } = extractCredentials(req);
  if (bearer) return { token: bearer, source: 'bearer' };
  if (session) return { token: session, source: 'cookie' };
  if (legacy) return { token: legacy, source: 'legacy-cookie' };
  return { token: null, source: null };
}

export function isAuthorized(req, token) {
  if (!token) return false;
  return extractToken(req) === token;
}

// 閲覧セッションの判定。編集モード(write token)は閲覧を内包する。
// viewSecret が未設定(閲覧ゲート無効)なら誰でも閲覧可として true を返す。
export function isViewer(req, viewSecret, writeToken) {
  if (!viewSecret) return true;
  if (writeToken && extractToken(req) === writeToken) return true;
  return parseCookies(req.headers.cookie).sailviz_view === viewSecret;
}
