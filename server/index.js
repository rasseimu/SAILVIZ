// server/index.js
// 静的フロント配信 + /api ルーターを兼ねる依存ゼロ HTTP サーバー。
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from './api.js';
import { serveStatic } from './static.js';
import { respondStaticError } from './domain/errorLog.js';
import { resolveViewGate } from './config.js';
import { openRepo } from './repos/openRepo.js';
import { createAccountsRepo } from './repos/accountsRepo.js';
import { createMailer, mailProviderWarning } from './mail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const TOKEN = process.env.SAILVIZ_WRITE_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const STORAGE = process.env.STORAGE || 'file'; // file | db
// 閲覧ログインの資格情報は env から解決する(既定値の埋め込みは廃止)。
// 本番で未設定なら resolveViewGate が throw し、起動を止める。
const { viewUser: VIEW_USER, viewPassword: VIEW_PASSWORD } = resolveViewGate(process.env);

// 保存先(ファイル／DB)を STORAGE で切替。db なら sqlite を開いてマイグレーションを当てる。
const { repo, db } = openRepo({ storage: STORAGE, dataDir: DATA_DIR });

// アカウント(§10.2)は SQLite の表を使うので STORAGE=db のときだけ有効。
const accounts = db ? createAccountsRepo({ db }) : null;
// メール送信のアダプタ。MAIL_PROVIDER 未設定は log(確認リンクをログに出すだけ)。brevo は 2026-10-19 に実キーで送受信確認済み。
const MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'log';
// 本番で log のままだとメールが届かない。起動は止めず WARN を1行出す(スモークが拾う)。
const mailWarn = mailProviderWarning({ nodeEnv: process.env.NODE_ENV, provider: process.env.MAIL_PROVIDER, accountsEnabled: !!accounts });
if (mailWarn) console.warn(mailWarn);
const mailer = createMailer({
  provider: MAIL_PROVIDER, redactToken: process.env.NODE_ENV === 'production',
  apiKey: process.env.BREVO_API_KEY, from: process.env.MAIL_FROM,
});
// メールのリンク先(Web の URL)。未設定ならローカル。本番の値の設定は S2.8 のデプロイ手順で扱う。
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 旧共有ログイン(閲覧ゲート・書込トークン)が属する組織(S2.5-P2)。取込み(importFromFiles)と同じ値。
// STORAGE=db では必須。未設定でも起動は止めず(起動停止は本番 502 の原因になる)、共有ログインが
// 何も読めない・書けない状態になるので WARN を出す。STORAGE=file では使わない。
const MIGRATION_ORG_ID = process.env.MIGRATION_ORG_ID || '';
if (STORAGE === 'db') {
  if (!MIGRATION_ORG_ID) {
    console.warn('[warn] MIGRATION_ORG_ID が未設定です: 共有ログイン(閲覧ゲート・書込トークン)は練習・反省・オーバーレイを何も読めない・書けません。fly secrets set MIGRATION_ORG_ID=<組織ID> を設定してください');
  } else if (accounts) {
    let exists = false;
    let checked = true;
    try { exists = !!accounts.getOrg(MIGRATION_ORG_ID); } catch { checked = false; }
    if (!checked) console.warn('[warn] MIGRATION_ORG_ID の組織を確認できませんでした(起動は続けます): 組織が存在するか確認してください');
    else if (!exists) console.warn('[warn] MIGRATION_ORG_ID の組織が存在しません: 共有ログインは組織のデータに一致しません(組織を作成してから設定してください)');
  }
}

const api = createApi({
  dataDir: DATA_DIR, repo, token: TOKEN, geminiKey: GEMINI_KEY,
  viewUser: VIEW_USER, viewPassword: VIEW_PASSWORD,
  accounts, mailer, baseUrl: PUBLIC_BASE_URL, migrationOrgId: MIGRATION_ORG_ID,
});

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    await serveStatic(req, res, ROOT);
  } catch (e) {
    respondStaticError(res, e, `${req.method} ${String(req.url || '').split('?')[0]}`);
  }
});

server.listen(PORT, () => {
  console.log(`SailViz on http://localhost:${PORT}  data=${DATA_DIR}  storage=${STORAGE}  accounts=${accounts ? `on mail=${MAIL_PROVIDER}` : 'OFF'}  write=${TOKEN ? 'on' : 'OFF'}  ai=${GEMINI_KEY ? 'on' : 'OFF'}  view-gate=${VIEW_USER && VIEW_PASSWORD ? 'on' : 'OFF'}${STORAGE === 'db' ? `  migration-org=${MIGRATION_ORG_ID ? 'set' : 'OFF'}` : ''}`);
});

// 終了時に DB を閉じる(WAL をチェックポイント)。
function shutdown() {
  server.close(() => {
    if (db) { try { db.close(); } catch { /* already closed */ } }
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
