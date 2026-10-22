// server/db/roadmapSync.js
// roadmaps を legacy_name で突き合わせて同期する(互換 PUT と取込み再実行で共用)。
// 全消し→入れ直しだと、名簿照合で付け替え済みの user_id・org_id が消える(S2.6-P5)。
//  - 既存行(legacy_name 一致): id・user_id・org_id を保ち、goal/milestones/extra/updated_at だけ更新。
//    org_id が未設定で orgId が渡されたときだけ補う。
//  - 新規: 挿入(id は既存と衝突しないものにする)。
//  - 入力に無い行: user_id が NULL(未付け替え)のものだけ消す。付け替え済み(本人のデータ)は消さない。
// scopeOrgId を渡すと、突き合わせ・削除の対象を org_id = scopeOrgId の行に限る(設計書 §5.6)。
//  組織 A の __team__ と組織 B の __team__ は別の行になり、他組織の行には触らない。
//  undefined なら従来どおり組織をまたいで legacy_name だけで突き合わせる(取込みが使う)。
// 呼び出し側がトランザクションを張る。
import { randomBytes } from 'node:crypto';

export function syncRoadmaps(db, rows, { orgId = null, scopeOrgId } = {}) {
  const scoped = scopeOrgId !== undefined;
  // org_id IS ? は null も一致させる(組織なしの行を範囲にするとき)。
  const scopeSql = scoped ? ' AND org_id IS ?' : '';
  const scopeArgs = scoped ? [scopeOrgId] : [];
  const names = new Set(rows.map((r) => r.legacy_name));
  const del = db.prepare('DELETE FROM roadmaps WHERE id = ?');
  for (const ex of db.prepare(`SELECT id, legacy_name, user_id FROM roadmaps WHERE 1 = 1${scopeSql}`).all(...scopeArgs)) {
    if (ex.user_id === null && !names.has(ex.legacy_name)) del.run(ex.id);
  }
  const find = db.prepare(`SELECT id FROM roadmaps WHERE legacy_name = ?${scopeSql} ORDER BY (user_id IS NULL), id LIMIT 1`);
  const idTaken = db.prepare('SELECT 1 FROM roadmaps WHERE id = ?');
  const upd = db.prepare(
    `UPDATE roadmaps SET goal = ?, milestones = ?, extra = ?, updated_at = ?,
            org_id = COALESCE(org_id, ?) WHERE id = ?`,
  );
  const ins = db.prepare(
    `INSERT INTO roadmaps (id, user_id, org_id, legacy_name, goal, milestones, extra, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const v = (x) => (x === undefined ? null : x);
  for (const r of rows) {
    const ex = find.get(r.legacy_name, ...scopeArgs);
    if (ex) {
      // 範囲内の既存行は組織を付け替えない(org_id は範囲の組織のまま)。
      upd.run(v(r.goal), v(r.milestones), v(r.extra), v(r.updated_at), scoped ? v(scopeOrgId) : v(orgId ?? r.org_id), ex.id);
    } else {
      let id = r.id;
      while (idTaken.get(id)) id = `rm_${randomBytes(5).toString('hex')}`;
      ins.run(id, v(r.org_id), r.legacy_name, v(r.goal), v(r.milestones), v(r.extra), v(r.updated_at));
    }
  }
}
