// src/account/logic.js
// アカウント画面(S2.7)の純関数。DOM・fetch を使わない(node:test で検証する)。

// パスから画面を決める。/verify-email・/reset-password は確認・再設定メールのリンク先(server/mail.js)。
export function pageModeForPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '');
  if (p === '/verify-email') return 'verify';
  if (p === '/reset-password') return 'reset';
  return 'account';
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
// 先頭のヘッダ行(「氏名」「name」で始まる)と空行は読み飛ばす。空なら空の名簿(全員を外す)。
export function parseRosterText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let first = true;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cells = splitLine(lines[i]);
    if (first) {
      first = false;
      if (/^(氏名|name)$/i.test(cells[0])) continue;
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
