// server/features.js
// 機能フラグ(純関数)。2026-10-20 のアカウント設計の凍結(FZ1): Web の入口を既定で隠し、
// FEATURE_ACCOUNT_EXTRAS=1 で元に戻す。サーバの API・ドメインは凍結しない(フラグに関係なく動く)。
// 画面への伝え方: API(設計書 v2 §10)は変えず、アカウント画面の HTML(/account・/join/:code など)に
// <meta name="sailviz-features" content="account-extras"> を差し込む。無ければ画面は「隠す」側に倒れる。
export const FEATURE_META_NAME = 'sailviz-features';

export function resolveFeatures(env = process.env) {
  return { accountExtras: env.FEATURE_ACCOUNT_EXTRAS === '1' };
}

export function injectFeatureMeta(html, features) {
  if (!features || !features.accountExtras) return html;
  const tag = `<meta name="${FEATURE_META_NAME}" content="account-extras" />`;
  // </head> が無い HTML には差し込まない。= 画面は「隠す」(凍結)側のままになり、機能を出す側には倒れない。
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : html;
}
