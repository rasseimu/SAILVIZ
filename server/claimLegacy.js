// server/claimLegacy.js
// 旧氏名(legacy_*)の本人への付け替えを、対応表(旧氏名,メール)から1回限りで行う(FZ3-C)。
// 付け替えの実処理は名簿照合と同じ accounts.reattachLegacy(S2.6)を使い回す。新しい表・API は作らない。
// planClaims は読み取りだけ(dry-run)。applyClaims は1トランザクション。どちらも同期関数。

// 最小の CSV 読み取り(ダブルクォート・BOM・CRLF 対応)。空行は捨てる。
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  // 見出し行(旧氏名,メール)があれば読み飛ばす
  if (rows.length && rows[0][0].trim() === '旧氏名') rows.shift();
  return rows.map((r) => ({ legacyName: (r[0] ?? '').trim(), email: (r[1] ?? '').trim().toLowerCase() }));
}

const one = (db, sql, ...args) => Number(db.prepare(sql).get(...args).n);

// 組織の旧データに、その旧氏名が(付け替え済みも含め)存在するか。
function legacyNameExists(db, orgId, name) {
  return one(db, `SELECT COUNT(*) AS n FROM reflections WHERE legacy_author_name = ?
      AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`, name, orgId) > 0
    || one(db, `SELECT COUNT(*) AS n FROM rec_sessions WHERE legacy_owner_name = ?
      AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`, name, orgId) > 0
    || one(db, 'SELECT COUNT(*) AS n FROM roadmaps WHERE legacy_name = ? AND org_id = ?', name, orgId) > 0;
}

// まだ付け替わっていない件数(reattachLegacy が動かす対象と同じ条件)。
function pendingCounts(db, orgId, userId, name) {
  return {
    reflections: one(db, `SELECT COUNT(*) AS n FROM reflections WHERE legacy_author_name = ? AND author_user_id IS NULL
      AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`, name, orgId),
    sessions: one(db, `SELECT COUNT(*) AS n FROM rec_sessions WHERE legacy_owner_name = ? AND owner_user_id IS NULL
      AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`, name, orgId),
    roadmaps: one(db, `SELECT COUNT(*) AS n FROM roadmaps WHERE legacy_name = ? AND org_id = ? AND user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM roadmaps WHERE user_id = ?)`, name, orgId, userId) > 0 ? 1 : 0,
  };
}

// 対応表の各行を判定する。何も書かない。
// 各 item: { line, legacyName, email, status, userId?, counts? }
//   status: 'ok'(付け替え対象 or 付け替え済みで 0 件) | 'invalid' | 'duplicate' | 'legacy_not_found' | 'user_not_found' | 'not_member'
// 重複(同じ旧氏名または同じメールが複数行)は、該当する全行を 'duplicate' にして付け替えない。
export function planClaims({ db, accounts }, orgId, rows) {
  if (!accounts.getOrg(orgId)) throw new Error(`組織が見つかりません: ${orgId}`);
  const cnt = (key, fn) => rows.reduce((m, r) => { const k = fn(r); if (k) m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());
  const byName = cnt('n', (r) => r.legacyName);
  const byMail = cnt('e', (r) => r.email);
  return rows.map((r, i) => {
    const item = { line: i + 1, legacyName: r.legacyName, email: r.email };
    if (!r.legacyName || !r.email) return { ...item, status: 'invalid' };
    if (byName.get(r.legacyName) > 1 || byMail.get(r.email) > 1) return { ...item, status: 'duplicate' };
    if (!legacyNameExists(db, orgId, r.legacyName)) return { ...item, status: 'legacy_not_found' };
    const user = accounts.getUserByEmail(r.email);
    if (!user || user.deleted_at != null) return { ...item, status: 'user_not_found' };
    if (!accounts.isMember(orgId, user.id)) return { ...item, status: 'not_member', userId: user.id };
    return { ...item, status: 'ok', userId: user.id, counts: pendingCounts(db, orgId, user.id, r.legacyName) };
  });
}

// 'ok' の行だけを1トランザクションで付け替える。失敗したら全部戻る。付け替えた件数の合計を返す。
export function applyClaims({ db, accounts }, orgId, rows) {
  const plan = planClaims({ db, accounts }, orgId, rows);
  const total = { reflections: 0, sessions: 0, roadmaps: 0 };
  accounts.withTx(() => {
    for (const it of plan) {
      if (it.status !== 'ok') continue;
      const m = accounts.reattachLegacy({ orgId, userId: it.userId, legacyName: it.legacyName });
      it.moved = m;
      total.reflections += m.reflections; total.sessions += m.sessions; total.roadmaps += m.roadmaps;
    }
  });
  return { plan, total };
}
