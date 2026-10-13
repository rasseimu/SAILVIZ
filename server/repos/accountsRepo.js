// server/repos/accountsRepo.js
// アカウント・組織・名簿・トークンの表(002_accounts.sql / 設計書 v2 §5.1)の読み書き。
// ここは永続化だけ。scrypt・トークン生成・Bearer 抽出・HTTP は S2.2 以降。
// トークンは呼び出し側がハッシュにした値(tokenHash)だけを受け取り、平文は扱わない。
import { randomBytes } from 'node:crypto';

const genId = (prefix) => `${prefix}${randomBytes(5).toString('hex')}`;
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : e);
const nul = (v) => (v === undefined ? null : v);

export function createAccountsRepo({ db }) {
  // 入れ子可のトランザクション。最外は BEGIN/COMMIT、内側(または呼び出し側が既に BEGIN 済み)は SAVEPOINT。
  let depth = 0;
  const withTx = (fn) => {
    const nested = depth > 0 || db.isTransaction === true;
    const sp = `sp_${depth}`;
    db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
    depth += 1;
    try {
      const out = fn();
      depth -= 1;
      db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (e) {
      depth -= 1;
      db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      throw e;
    }
  };

  return {
    withTx,
    // ---- users ----
    createUser({
      email, name, affiliationText, passwordHash, defaultVisibility, agreedAt, now = Date.now(),
    }) {
      const id = genId('u_');
      db.prepare(
        `INSERT INTO users (id, email, password_hash, name, affiliation_text, default_visibility, agreed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, normEmail(email), nul(passwordHash), nul(name), nul(affiliationText),
        nul(defaultVisibility), nul(agreedAt), now);
      return this.getUser(id);
    },
    getUser(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    },
    getUserByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail(email)) || null;
    },
    markEmailVerified(userId, now = Date.now()) {
      db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, userId);
    },
    // 指定した列だけ更新する(許可列のみ)。email を変えたら確認済みを外す(§4.2)。
    // 注意: メール変更時の org_members の解除・再照合は呼び出し側の責務(ここでは触らない)。
    updateUser(userId, patch) {
      const map = {
        name: 'name', affiliationText: 'affiliation_text', defaultVisibility: 'default_visibility',
        passwordHash: 'password_hash',
      };
      const sets = []; const vals = [];
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]); }
      }
      if (patch.email !== undefined) {
        sets.push('email = ?', 'email_verified_at = NULL');
        vals.push(normEmail(patch.email));
      }
      if (!sets.length) return;
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, userId);
    },
    markUserDeleted(userId, now = Date.now()) {
      db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(now, userId);
    },

    // ---- auth_tokens(token_hash のみ保存)----
    createAuthToken({ userId, tokenHash, expiresAt, now = Date.now() }) {
      const id = genId('at_');
      db.prepare(
        `INSERT INTO auth_tokens (id, user_id, token_hash, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, tokenHash, now, now, nul(expiresAt));
      return id;
    },
    getAuthTokenByHash(tokenHash) {
      return db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(tokenHash) || null;
    },
    touchAuthToken(id, { lastUsedAt, expiresAt }) {
      db.prepare('UPDATE auth_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?')
        .run(lastUsedAt, nul(expiresAt), id);
    },
    revokeAuthToken(id, now = Date.now()) {
      return Number(db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now, id).changes) > 0;
    },
    // 全端末ログアウト/パスワード変更時。失効させた件数を返す。
    revokeAllAuthTokens(userId, now = Date.now()) {
      return Number(db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now, userId).changes);
    },

    // ---- email_tokens ----
    createEmailToken({ userId, purpose, tokenHash, newEmail, expiresAt }) {
      if (!['verify', 'reset', 'change'].includes(purpose)) throw new Error(`invalid purpose: ${purpose}`);
      const id = genId('et_');
      db.prepare(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, new_email, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, purpose, tokenHash, nul(newEmail), nul(expiresAt));
      return id;
    },
    getEmailTokenByHash(tokenHash) {
      return db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(tokenHash) || null;
    },
    markEmailTokenUsed(id, now = Date.now()) {
      // 初回だけ true。2回目(使用済み)・存在しない id は false(ワンタイムリンクの二重使用の判別用)。
      return Number(db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(now, id).changes) > 0;
    },

    // ---- orgs / org_admins ----
    createOrg({ name, adminUserIds = [], now = Date.now() }) {
      const id = genId('o_');
      withTx(() => {
        db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
        for (const uid of adminUserIds) {
          db.prepare('INSERT OR IGNORE INTO org_admins (org_id, user_id) VALUES (?, ?)').run(id, uid);
        }
      });
      return this.getOrg(id);
    },
    getOrg(id) {
      return db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) || null;
    },
    addOrgAdmin(orgId, userId) {
      db.prepare('INSERT OR IGNORE INTO org_admins (org_id, user_id) VALUES (?, ?)').run(orgId, userId);
    },
    isOrgAdmin(orgId, userId) {
      return !!db.prepare('SELECT 1 FROM org_admins WHERE org_id = ? AND user_id = ?').get(orgId, userId);
    },
    listOrgAdmins(orgId) {
      return db.prepare('SELECT user_id FROM org_admins WHERE org_id = ? ORDER BY user_id').all(orgId)
        .map((r) => r.user_id);
    },

    // ---- org_roster ----
    // 名簿全体を置き換える(§10.3 PUT roster)。rows: [{name,email,legacyName}]。
    // 同じ組織でメールが一致する行は ID を引き継ぐ(org_members.roster_id を宙に浮かせない)。
    // 消えた行を指していた org_members.roster_id は同じトランザクションで NULL にする
    // (会員資格そのものは残す。再照合・解除の判断は呼び出し側)。
    // 正規化(trim + 小文字)後にメールが重複する行があれば Error(code='ROSTER_DUPLICATE_EMAIL')。
    // API での 422 化は S2.6。メールの無い行は重複検査の対象外。
    replaceRoster(orgId, rows, now = Date.now()) {
      const prepared = rows.map((r) => {
        const e = normEmail(nul(r.email));
        return { r, email: e === '' ? null : e };
      });
      const seen = new Set();
      for (const { email } of prepared) {
        if (email === null) continue;
        if (seen.has(email)) {
          const err = new Error(`duplicate roster email: ${email}`);
          err.code = 'ROSTER_DUPLICATE_EMAIL';
          throw err;
        }
        seen.add(email);
      }
      withTx(() => {
        const existing = new Map();
        for (const row of this.listRoster(orgId)) {
          if (row.email !== null && row.email !== undefined && !existing.has(row.email)) existing.set(row.email, row.id);
        }
        const keep = new Set();
        const ins = db.prepare(
          'INSERT INTO org_roster (id, org_id, name, email, legacy_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        const upd = db.prepare(
          'UPDATE org_roster SET name = ?, legacy_name = ?, updated_at = ? WHERE id = ?',
        );
        for (const { r, email } of prepared) {
          const id = email !== null ? existing.get(email) : undefined;
          if (id) {
            upd.run(nul(r.name), nul(r.legacyName), now, id);
            keep.add(id);
          } else {
            const nid = genId('r_');
            ins.run(nid, orgId, nul(r.name), email, nul(r.legacyName), now);
            keep.add(nid);
          }
        }
        for (const row of this.listRoster(orgId)) {
          if (keep.has(row.id)) continue;
          db.prepare('DELETE FROM org_roster WHERE id = ?').run(row.id);
          db.prepare('UPDATE org_members SET roster_id = NULL WHERE org_id = ? AND roster_id = ?')
            .run(orgId, row.id);
        }
      });
      return this.listRoster(orgId);
    },
    listRoster(orgId) {
      return db.prepare('SELECT * FROM org_roster WHERE org_id = ? ORDER BY rowid').all(orgId);
    },
    findRosterByEmail(orgId, email) {
      return db.prepare('SELECT * FROM org_roster WHERE org_id = ? AND email = ?').get(orgId, normEmail(email)) || null;
    },
    // メールが一致する全組織の名簿行(メール確認時の照合用)。
    findRosterRowsByEmail(email) {
      return db.prepare('SELECT * FROM org_roster WHERE email = ? ORDER BY rowid').all(normEmail(email));
    },

    // ---- org_members ----
    linkMember({ orgId, userId, rosterId, now = Date.now() }) {
      db.prepare(
        `INSERT INTO org_members (org_id, user_id, roster_id, linked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET roster_id = excluded.roster_id, linked_at = excluded.linked_at`,
      ).run(orgId, userId, nul(rosterId), now);
    },
    unlinkMember(orgId, userId) {
      db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(orgId, userId);
    },
    isMember(orgId, userId) {
      return !!db.prepare('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, userId);
    },
    listMembers(orgId) {
      return db.prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY linked_at, user_id').all(orgId);
    },
    listMembershipsOfUser(userId) {
      return db.prepare('SELECT * FROM org_members WHERE user_id = ? ORDER BY linked_at').all(userId);
    },
  };
}
