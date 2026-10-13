// server/mail.js
// メール送信のアダプタ。差し替え可能にしてあり、S2.3 では log(リンクをログに出すだけ)とテスト用スタブだけ。
// 外部サービス(Brevo 等)の実装は S2.8。MAIL_PROVIDER 未設定は log。
// 本文の組み立てもここ。リンクは Web のページ(2026-10-12 決定): /verify-email?token=… と /reset-password?token=…
// アダプタの形: { send({ to, kind, url }) -> Promise<void> }。kind は 'verify' | 'reset'。

export function buildLink(baseUrl, kind, token) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const page = kind === 'verify' ? 'verify-email' : 'reset-password';
  return `${base}/${page}?token=${encodeURIComponent(token)}`;
}

const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, '$1***$2'); // ログに宛先の全文を残さない

// 確認リンクをログに出すだけ(開発・ステージング用)。
export function createLogMailer({ logger = console.log } = {}) {
  return {
    async send({ to, kind, url }) {
      logger(`[mail:log] kind=${kind} to=${maskEmail(to)} url=${url}`);
    },
  };
}

// テスト用。送ったメールを sent に溜める。
export function createStubMailer() {
  const sent = [];
  return {
    sent,
    async send(msg) { sent.push({ ...msg }); },
    last(kind) { return [...sent].reverse().find((m) => !kind || m.kind === kind) || null; },
  };
}

export function createMailer({ provider = 'log', logger } = {}) {
  if (!provider || provider === 'log') return createLogMailer({ logger });
  // TODO(S2.8): provider='brevo' など。未実装の値は起動時に気づけるよう例外にする。
  throw new Error(`MAIL_PROVIDER=${provider} は未実装です(使えるのは log)`);
}
