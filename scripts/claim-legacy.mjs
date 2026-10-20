#!/usr/bin/env node
// 旧氏名の付け替え(1回限りの CLI)。使い方:
//   node scripts/claim-legacy.mjs <対応表.csv> --org <orgId> [--apply] [--db <sailviz.db のパス>]
// CSV は「旧氏名,メール」。既定は dry-run(何も書かない)。--apply で1トランザクションで付け替える。
// DB は DATA_DIR(既定 ./data)の sailviz.db(サーバと同じ)。Node 24 が要る。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepo } from '../server/repos/openRepo.js';
import { createAccountsRepo } from '../server/repos/accountsRepo.js';
import { parseCsv, planClaims, applyClaims } from '../server/claimLegacy.js';

const LABEL = {
  invalid: '行が不完全(旧氏名またはメールが空)',
  duplicate: 'CSV 内で重複(旧氏名またはメール)→ 付け替えない',
  legacy_not_found: '旧氏名がこの組織の旧データに無い',
  user_not_found: 'そのメールのユーザーがいない',
  not_member: '組織のメンバーではない → 拒否(付け替えない)',
};

export function run(argv, env = process.env, out = (s) => console.log(s)) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const orgId = val('--org');
  const dbPath = val('--db');
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--org' && args[i - 1] !== '--db');
  if (!file || !orgId) {
    out('使い方: node scripts/claim-legacy.mjs <対応表.csv> --org <orgId> [--apply] [--db <path>]');
    return 2;
  }
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = env.DATA_DIR || join(here, '..', 'data');
  const { db } = openRepo({ storage: 'db', dataDir, dbPath });
  try {
    const ctx = { db, accounts: createAccountsRepo({ db }) };
    out(`${apply ? '[APPLY]' : '[dry-run]'} 組織 ${orgId} / ${rows.length} 行`);
    const result = apply ? applyClaims(ctx, orgId, rows) : { plan: planClaims(ctx, orgId, rows) };
    for (const it of result.plan) {
      const head = `  ${it.line}: ${it.legacyName} <${it.email}>`;
      if (it.status !== 'ok') { out(`${head} -> ${LABEL[it.status]}`); continue; }
      const c = apply ? it.moved : it.counts;
      out(`${head} -> ${it.userId} 反省 ${c.reflections} / ロードマップ ${c.roadmaps} / 軌跡 ${c.sessions}${apply ? ' 件を付け替えた' : ' 件を付け替える予定'}`);
    }
    if (apply) {
      const t = result.total;
      out(`付け替え合計: 反省 ${t.reflections} / ロードマップ ${t.roadmaps} / 軌跡 ${t.sessions}`);
    } else {
      out('dry-run のため何も書いていません。反映するには --apply を付けて再実行してください。');
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = run(process.argv); } catch (e) { console.error(`エラー: ${e.message}`); process.exitCode = 1; }
}
