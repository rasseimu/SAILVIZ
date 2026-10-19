// src/account/logic.js
// アカウント画面(S2.7)の純関数。DOM・fetch を使わない(node:test で検証する)。

// パスから画面を決める。/verify-email・/reset-password は確認・再設定メールのリンク先(server/mail.js)。
export function pageModeForPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '');
  if (p === '/verify-email') return 'verify';
  if (p === '/reset-password') return 'reset';
  if (/^\/join\/[^/]+$/.test(p)) return 'join';
  return 'account';
}

// /join/:code のコード。無い・不正なら null。(`/?invite=<code>` はサーバが /join/<code> へ 302 で寄せる: server/static.js)
export function inviteCodeFromPath(pathname) {
  const m = /^\/join\/([^/]+)$/.exec(String(pathname || '').replace(/\/+$/, ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]) || null; } catch { return null; }
}

const intOrNull = (s, min, max) => {
  const t = String(s ?? '').trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= min && n <= max ? { ok: true, value: n } : { ok: false };
};

// 招待発行フォームの入力 → POST /api/orgs/:orgId/invites の本文。範囲はサーバ(domain/invites.js)と同じ。
export function parseInviteForm(days, maxUses) {
  const d = intOrNull(days, 1, 365);
  if (!d.ok) return { ok: false, message: '有効日数は 1〜365 の整数にしてください(空なら無期限)' };
  const m = intOrNull(maxUses, 1, 1000);
  if (!m.ok) return { ok: false, message: '使用回数の上限は 1〜1000 の整数にしてください(空なら無制限)' };
  const body = {};
  if (d.value != null) body.expiresInDays = d.value;
  if (m.value != null) body.maxUses = m.value;
  return { ok: true, body };
}

// 招待一覧の「期限・使用回数」表示。
export function inviteLimitLabel(inv, now) {
  const exp = inv.expiresAt == null ? '無期限' : `あと${Math.max(0, Math.ceil((inv.expiresAt - now) / 86400000))}日`;
  const uses = inv.maxUses == null ? `${inv.useCount ?? 0} 回使用(無制限)` : `${inv.useCount ?? 0} / ${inv.maxUses} 回使用`;
  return `${exp}・${uses}`;
}

// 招待の参加(プレビュー・accept)に失敗したときの表示の種類と文言。
export function joinFailureView(status, json) {
  const code = json && json.error && json.error.code;
  if (status === 404) return { kind: 'notfound', message: 'この招待リンクは見つかりません。リンクが正しいか、招待した人に確認してください。' };
  if (status === 401) return { kind: 'login', needsLogin: true, message: 'ログインが必要です。' };
  if (status === 403) return { kind: 'unverified', message: '招待を使うには、先にメールアドレスの確認が必要です。確認メールのリンクを開いてから、このページを開き直してください。' };
  if (status === 410) {
    const why = code === 'invite_expired' ? '有効期限が切れています' : code === 'invite_exhausted' ? '利用上限に達しています' : '失効しています';
    return { kind: 'gone', message: `この招待リンクは${why}。招待した人に新しいリンクを頼んでください。` };
  }
  return { kind: 'error', message: apiErrorMessage(status, json) };
}

// ?token=… を取り出す。無い・空なら null。
export function tokenFromSearch(search) {
  const t = new URLSearchParams(String(search || '')).get('token');
  return t ? t : null;
}

// サーバの { error: { message } } を優先し、無ければ状態コードから文言を作る。
export function apiErrorMessage(status, json) {
  const m = json && json.error && typeof json.error.message === 'string' ? json.error.message : '';
  if (m) return m;
  if (!status) return '通信できませんでした。ネットワークを確認してください';
  if (status === 401) return 'ログインが必要です';
  if (status === 403) return '権限がありません';
  if (status === 429) return '試行回数が多すぎます。しばらくしてからやり直してください';
  if (status === 503) return 'アカウント機能は現在使えません(アカウント機能が無効です)';
  if (status >= 500) return 'サーバでエラーが起きました。時間をおいてやり直してください';
  return `処理に失敗しました(${status})`;
}

// GET members の応答を表示用の状態にする。200 以外は「メンバー0人」とは区別してエラーにする。
export function membersView(status, json) {
  if (status !== 200 || !Array.isArray(json)) return { kind: 'error', message: `メンバーを読み込めませんでした。${apiErrorMessage(status, json)}` };
  return { kind: 'list', members: json };
}

const MIN_PASSWORD = 8;
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const bad = (message) => ({ ok: false, message });

export function checkNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return bad(`パスワードは${MIN_PASSWORD}文字以上にしてください`);
  if (password !== confirm) return bad('確認用のパスワードが一致しません');
  return { ok: true };
}

// 送信前の簡易チェック(最終判断はサーバ)。
export function checkRegisterForm(f) {
  if (!looksLikeEmail(f.email)) return bad('メールアドレスの形式が正しくありません');
  const pw = checkNewPassword(f.password, f.password);
  if (!pw.ok) return pw;
  if (!String(f.name || '').trim()) return bad('氏名を入力してください');
  if (!String(f.affiliationText || '').trim()) return bad('所属を入力してください');
  if (!f.agreed) return bad('利用規約等への同意が必要です');
  return { ok: true };
}

// 1行を区切り文字(タブ優先、無ければカンマ)で分ける。"…" で囲めばカンマを含められる。
function splitLine(line) {
  const sep = line.includes('\t') ? '\t' : ',';
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"' && cur.trim() === '') { quoted = true; cur = ''; } else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// 名簿のテキスト(列: 氏名, メール, 旧名簿の氏名)を PUT roster の行に変換する。
// 先頭のヘッダ行(1列目が氏名/name かつ 2列目がメール/email)と空行は読み飛ばす。空なら空の名簿(全員を外す)。
export function parseRosterText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let first = true;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cells = splitLine(lines[i]);
    if (first) {
      first = false;
      if (/^(氏名|name)$/i.test(cells[0]) && /^(メール|メールアドレス|e-?mail)$/i.test(cells[1] || '')) continue;
    }
    if (!cells[0]) return bad(`${i + 1} 行目: 氏名が空です`);
    rows.push({ name: cells[0], email: cells[1] || null, legacyName: cells[2] || null });
  }
  return { ok: true, rows };
}

const cell = (v) => (v == null ? '' : /[",\t\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function rosterToText(rows) {
  return (rows || []).map((r) => [r.name, r.email, r.legacyName].map(cell).join(',')).join('\n');
}
