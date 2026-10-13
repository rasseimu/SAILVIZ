// server/repos/accountsRepo.js
// アカウント・組織・名簿・トークンの表(002_accounts.sql / 設計書 v2 §5.1)の読み書き。
// ここは永続化だけ。scrypt・トークン生成・Bearer 抽出・HTTP は S2.2 以降。
// トークンは呼び出し側がハッシュにした値(tokenHash)だけを受け取り、平文は扱わない。
import { randomBytes } from 'node:crypto';

const genId = (prefix) => `${prefix}${randomBytes(5).toString('hex')}`;
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : e);
const nul = (v) => (v === undefined ? null : v);

export function createAccountsRepo({ db }) {
  return {
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
      db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
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
      db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, id);
    },

    // ---- orgs / org_admins ----
    createOrg({ name, adminUserIds = [], now = Date.now() }) {
      const id = genId('o_');
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
        for (const uid of adminUserIds) {
          db.prepare('INSERT OR IGNORE INTO org_admins (org_id, user_id) VALUES (?, ?)').run(id, uid);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
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
    replaceRoster(orgId, rows, now = Date.now()) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM org_roster WHERE org_id = ?').run(orgId);
        const ins = db.prepare(
          'INSERT INTO org_roster (id, org_id, name, email, legacy_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const r of rows) {
          ins.run(genId('r_'), orgId, nul(r.name), normEmail(nul(r.email)), nul(r.legacyName), now);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
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
