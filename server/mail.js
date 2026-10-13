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
// redactToken=true(本番: index.js が NODE_ENV=production で指定)ではリンクのトークンを伏せる
// (ログを読めた人がアカウントを乗っ取れないように)。本番の log メーラーはリンクを使えない形でしか出さない。
export function createLogMailer({ logger = console.log, redactToken = false } = {}) {
  return {
    async send({ to, kind, url }) {
      const shown = redactToken ? String(url).replace(/([?&]token=)[^&#]*/, '$1<redacted>') : url;
      logger(`[mail:log] kind=${kind} to=${maskEmail(to)} url=${shown}`);
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

export function createMailer({ provider = 'log', logger, redactToken = false } = {}) {
  if (!provider || provider === 'log') return createLogMailer({ logger, redactToken });
  // TODO(S2.8): provider='brevo' など。未実装の値(log 以外の MAIL_PROVIDER)は起動時にここで例外になり、
  // サーバは起動しない(設定ミスに気づけるように意図した挙動)。
  throw new Error(`MAIL_PROVIDER=${provider} は未実装です(使えるのは log)`);
}
