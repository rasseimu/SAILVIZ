// server/mail.js
// メール送信のアダプタ。差し替え可能にしてあり、S2.3 では log(リンクをログに出すだけ)とテスト用スタブだけ。
// MAIL_PROVIDER=log(既定)| brevo(S2.8)。
// 本文の組み立てもここ。リンクは Web のページ(2026-10-12 決定): /verify-email?token=… と /reset-password?token=…
// アダプタの形: { send({ to, kind, url }) -> Promise<void> }。kind は 'verify' | 'reset'。

export function buildLink(baseUrl, kind, token) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const page = kind === 'verify' ? 'verify-email' : 'reset-password';
  return `${base}/${page}?token=${encodeURIComponent(token)}`;
}

const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, '$1***$2'); // ログに宛先の全文を残さない

// 確認リンクをログに出すだけ(開発・ステージング用)。
// redactToken=true(本番)ではリンクのトークンを伏せる(ログを読めた人がアカウントを乗っ取れないように)。
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
// 要確認: 実 API の仕様(POST /v3/smtp/email、ヘッダ api-key、成功は 201)は実機で未確認。
export function createBrevoMailer({ apiKey, from, fromName = 'SailViz', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
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
      if (!res.ok) throw new Error(`Brevo が送信を拒否(HTTP ${res.status})`);
    },
  };
}

export function createMailer({ provider = 'log', logger, redactToken = false, apiKey, from, fetchImpl } = {}) {
  if (!provider || provider === 'log') return createLogMailer({ logger, redactToken });
  if (provider === 'brevo') {
    // 起動時に分かるよう、必須設定が無ければここで例外(サーバは起動しない)。
    if (!apiKey) throw new Error('MAIL_PROVIDER=brevo には BREVO_API_KEY が必要です');
    if (!from) throw new Error('MAIL_PROVIDER=brevo には MAIL_FROM(送信者メール)が必要です');
    return createBrevoMailer({ apiKey, from, fetchImpl });
  }
  throw new Error(`MAIL_PROVIDER=${provider} は未実装です(使えるのは log・brevo)`);
}
