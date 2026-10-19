// server/mail.js
// メール送信のアダプタ。差し替え可能にしてあり、log(リンクをログに出すだけ)・brevo(S2.8)・テスト用スタブがある。
// MAIL_PROVIDER=log(既定)| brevo。
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

const SUBJECTS = { verify: 'SailViz: メールアドレスの確認', reset: 'SailViz: パスワードの再設定' };
const INTROS = {
  verify: 'SailViz にご登録ありがとうございます。次のリンクを開いてメールアドレスを確認してください。',
  reset: 'パスワードの再設定を受け付けました。次のリンクを開いて新しいパスワードを設定してください。',
};

// Brevo の HTTP API(暫定の送信先。2026-10-12 決定)。依存なし・fetch は注入可能(テストは偽の fetch)。
// 送信失敗(非 2xx・通信例外・タイムアウト)は例外を投げる。呼び出し側(routes/auth.js の sendMail)が
// 捕まえてログに残し、登録などの API 応答は失敗にしない(既存の方針)。
// 例外メッセージに API キー・宛先・リンク(トークン)・応答本文は入れない(ステータスだけ)。
// 実 API の仕様(POST /v3/smtp/email、ヘッダ api-key、成功は 201)は 2026-10-19 に実キーで送信・受信を確認済み。
// タイムアウトは 5 秒(利用者決定)。routes 側は送信を await する(待たない形にはしない)。
export const DEFAULT_BREVO_TIMEOUT_MS = 5000;
export function createBrevoMailer({ apiKey, from, fromName = 'SailViz', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_BREVO_TIMEOUT_MS } = {}) {
  return {
    async send({ to, kind, url }) {
      const text = `${INTROS[kind] || ''}\n\n${url}\n\n心当たりがない場合は、このメールを破棄してください。`;
      const body = {
        sender: { email: from, name: fromName },
        to: [{ email: to }],
        subject: SUBJECTS[kind] || 'SailViz',
        textContent: text,
      };
      let res;
      try {
        res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new Error(`Brevo への接続に失敗(${e && e.name || 'Error'})`);
      }
      if (!res.ok) {
        // 応答本文は読まずに捨てる(接続を解放する)。
        try { await res.body?.cancel(); } catch { /* ignore */ }
        throw new Error(`Brevo が送信を拒否(HTTP ${res.status})`);
      }
    },
  };
}

// 本番で MAIL_PROVIDER が未設定・log だと確認メール・再設定メールが届かない。起動時の WARN 文字列(不要なら null)。
// ハブのスモークが「WARN:」と「MAIL_PROVIDER」を含む行を拾うので文言の先頭と語を変えないこと。
export function mailProviderWarning({ nodeEnv, provider } = {}) {
  if (nodeEnv !== 'production') return null;
  if (provider && provider !== 'log') return null;
  return 'WARN: MAIL_PROVIDER が未設定または log です: 確認メール・再設定メールが届かず、アカウント機能(登録・ログイン・パスワード再設定)が使えません。fly secrets set MAIL_PROVIDER=brevo BREVO_API_KEY=... MAIL_FROM=... を設定してください';
}

export function createMailer({ provider = 'log', logger, redactToken = false, apiKey, from, fetchImpl } = {}) {
  if (!provider || provider === 'log') return createLogMailer({ logger, redactToken });
  if (provider === 'brevo') {
    // 起動時に分かるよう、必須設定が無ければここで例外(サーバは起動しない)。
    if (!apiKey) throw new Error('MAIL_PROVIDER=brevo には BREVO_API_KEY が必要です');
    if (!from) throw new Error('MAIL_PROVIDER=brevo には MAIL_FROM(送信者メール)が必要です');
    if (!String(from).includes('@') || String(from).length < 3) throw new Error('MAIL_FROM はメールアドレスの形式(@ を含む)にしてください');
    return createBrevoMailer({ apiKey, from, fetchImpl });
  }
  throw new Error(`MAIL_PROVIDER=${provider} は未実装です(使えるのは log・brevo)`);
}
