// server/config.js
// 環境変数から閲覧ゲートの資格情報を解決する純関数(http/副作用なし → node --test 可能)。
// 旧実装はコードに部内共有アカウントの既定値を埋め込んでいた。これを廃止し、
// 本番(NODE_ENV=production)では SAILVIZ_VIEW_USER / SAILVIZ_VIEW_PASSWORD を必須にする。
// 非本番で未設定なら空文字を返し、ゲート無効(createApi 側で viewEnabled=false)として扱う。
export function resolveViewGate(env = process.env) {
  const viewUser = env.SAILVIZ_VIEW_USER || '';
  const viewPassword = env.SAILVIZ_VIEW_PASSWORD || '';
  if (env.NODE_ENV === 'production' && !(viewUser && viewPassword)) {
    throw new Error(
      '本番では SAILVIZ_VIEW_USER と SAILVIZ_VIEW_PASSWORD が必須です(閲覧ゲートの既定値は廃止しました)',
    );
  }
  return { viewUser, viewPassword };
}
