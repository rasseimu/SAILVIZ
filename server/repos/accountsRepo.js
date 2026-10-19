// server/repos/accountsRepo.js
// アカウント・組織・名簿・トークンの表(002_accounts.sql / 設計書 v2 §5.1)の読み書き。
// ここは永続化だけ。scrypt・トークン生成・Bearer 抽出・HTTP は S2.2 以降。
// トークンは呼び出し側がハッシュにした値(tokenHash)だけを受け取り、平文は扱わない。
import { randomBytes } from 'node:crypto';
import { inviteStatus, generateInviteCode } from '../domain/invites.js';

const genId = (prefix) => `${prefix}${randomBytes(5).toString('hex')}`;
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : e);
const nul = (v) => (v === undefined ? null : v);

export function createAccountsRepo({ db }) {
  // 入れ子可のトランザクション。最外は BEGIN/COMMIT、内側(または呼び出し側が既に BEGIN 済み)は SAVEPOINT。
  let depth = 0;
  // 注意: fn は同期関数だけ(Promise を返す関数は不可。await をまたぐとトランザクションが崩れる)。
  const withTx = (fn) => {
    const nested = depth > 0 || db.isTransaction === true;
    const sp = `sp_${depth}`;
    db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
    depth += 1;
    try {
      const out = fn();
      db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (e) {
      // ROLLBACK 自体が失敗しても元の例外 e を投げ直す。
      try {
        if (nested) db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        else if (db.isTransaction) db.exec('ROLLBACK');
      } catch { /* 元の例外を優先 */ }
      throw e;
    } finally {
      depth -= 1;
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
    // そのユーザーが管理者になっている組織の数(組織作成の上限判定用)。
    countOrgsAdministeredBy(userId) {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM org_admins WHERE user_id = ?').get(userId).n);
    },
    // そのユーザーが管理者になっている組織の ID(退会時の後任引き継ぎ用)。
    listOrgIdsAdministeredBy(userId) {
      return db.prepare('SELECT org_id FROM org_admins WHERE user_id = ? ORDER BY org_id').all(userId).map((r) => r.org_id);
    },
    // そのユーザーの org_admins 行を全組織ぶん消す(§4.3 退会)。消した行数を返す。
    // 唯一の管理者でも組織は残る(管理者不在になる)。正本に定めが無いため拒否・移譲はしない。
    removeOrgAdminsOfUser(userId) {
      return Number(db.prepare('DELETE FROM org_admins WHERE user_id = ?').run(userId).changes);
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
    // 戻り値は { rows, detached }。detached は今回 roster_id を NULL にした会員 [{userId, rosterId}]
    // (最初から roster_id=NULL の会員は含まない。S2.6 の {linked, unlinked} 用)。
    // detached は roster_id を NULL にするだけ。会員の解除(unlinkMember)は S2.6 の責務で、ここでは行わない。
    // メールの無い名簿行は照合キーが無いので、置き換えのたびに ID が変わる(会員の roster_id も NULL になる)。
    // 既存に同じメールの重複行がある場合、2行目以降を指す会員は残る行へ付け替える。
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
      const detached = [];
      withTx(() => {
        const existing = new Map();
        // 既存 DB に同じメールの行が複数ある場合: 2行目以降 → 残す行(最初の行)への付け替え先
        const dupTo = new Map();
        for (const row of this.listRoster(orgId)) {
          if (row.email === null || row.email === undefined) continue;
          if (!existing.has(row.email)) existing.set(row.email, row.id);
          else dupTo.set(row.id, existing.get(row.email));
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
          const target = dupTo.get(row.id);
          if (target && keep.has(target)) {
            // 同じメールの残る行へ付け替える(外れた扱いにしない)
            db.prepare('UPDATE org_members SET roster_id = ? WHERE org_id = ? AND roster_id = ?')
              .run(target, orgId, row.id);
            continue;
          }
          const gone = db.prepare('SELECT user_id FROM org_members WHERE org_id = ? AND roster_id = ? ORDER BY user_id')
            .all(orgId, row.id);
          db.prepare('UPDATE org_members SET roster_id = NULL WHERE org_id = ? AND roster_id = ?')
            .run(orgId, row.id);
          for (const g of gone) detached.push({ userId: g.user_id, rosterId: row.id });
        }
      });
      return { rows: this.listRoster(orgId), detached };
    },
    // 並びは挿入順(rowid)。ID はランダムなので ID 順にはしない。
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
    // ---- legacy_* の本人への付け替え(§4.4・移行計画 Phase 2)----
    // 旧名簿の氏名(legacyName)と一致する、その組織の練習日の器に属する legacy データを userId に付け替える。
    //  - 反省: legacy_author_name 一致 かつ author_user_id が NULL
    //  - 軌跡: legacy_owner_name 一致 かつ owner_user_id が NULL
    //  - ロードマップ: legacy_name 一致 かつ org_id がその組織 かつ user_id が NULL。
    //    roadmaps.user_id は UNIQUE なので、本人が既にロードマップを持っていれば付け替えない。
    // 他組織の器・既に所有者がいる行は触らない(奪わない)。legacy_* 列は来歴として残す。冪等。
    // 戻り値は付け替えた件数。
    reattachLegacy({ orgId, userId, legacyName }) {
      const name = typeof legacyName === 'string' ? legacyName.trim() : '';
      if (!name) return { reflections: 0, sessions: 0, roadmaps: 0 };
      const n = (r) => Number(r.changes);
      return withTx(() => ({
        reflections: n(db.prepare(
          `UPDATE reflections SET author_user_id = ? WHERE legacy_author_name = ? AND author_user_id IS NULL
             AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`,
        ).run(userId, name, orgId)),
        sessions: n(db.prepare(
          `UPDATE rec_sessions SET owner_user_id = ? WHERE legacy_owner_name = ? AND owner_user_id IS NULL
             AND practice_day_id IN (SELECT id FROM practice_days WHERE org_id = ?)`,
        ).run(userId, name, orgId)),
        roadmaps: n(db.prepare(
          `UPDATE roadmaps SET user_id = ? WHERE legacy_name = ? AND org_id = ? AND user_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM roadmaps WHERE user_id = ?)`,
        ).run(userId, name, orgId, userId)),
      }));
    },
    listMembershipsOfUser(userId) {
      return db.prepare('SELECT * FROM org_members WHERE user_id = ? ORDER BY linked_at').all(userId);
    },

    // ---- org_invites(004_invites.sql / S2.9)----
    createInvite({ orgId, createdByUserId, expiresAt, maxUses, now = Date.now() }) {
      const id = genId('inv_');
      const code = generateInviteCode();
      db.prepare(
        `INSERT INTO org_invites (id, org_id, code, created_by_user_id, role, expires_at, max_uses, use_count, created_at)
         VALUES (?, ?, ?, ?, 'member', ?, ?, 0, ?)`,
      ).run(id, orgId, code, nul(createdByUserId), nul(expiresAt), nul(maxUses), now);
      return this.getInvite(id);
    },
    getInvite(id) {
      return db.prepare('SELECT * FROM org_invites WHERE id = ?').get(id) || null;
    },
    getInviteByCode(code) {
      return db.prepare('SELECT * FROM org_invites WHERE code = ?').get(String(code)) || null;
    },
    // 有効(未失効・期限内・上限未満)な招待だけ。新しい順。
    listActiveInvites(orgId, now = Date.now()) {
      return db.prepare(
        `SELECT * FROM org_invites WHERE org_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR use_count < max_uses)
         ORDER BY created_at DESC, rowid DESC`,
      ).all(orgId, now);
    },
    // 組織を縛って失効させる(他組織の招待 ID では何も起きない)。初回だけ true。
    revokeInvite(orgId, inviteId, now = Date.now()) {
      return Number(db.prepare('UPDATE org_invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL')
        .run(now, inviteId, orgId).changes) > 0;
    },
    // 招待コードで参加する。use_count の加算と参加は1トランザクション。
    // 上限は条件付き UPDATE で守る(同時利用でも max_uses を超えない)。
    // 戻り値: { status:'joined'|'already', orgId } | { status:'revoked'|'expired'|'exhausted', orgId } | { status:'not_found' }
    // 既参加は(招待の状態に関わらず)'already'。加算しない。
    acceptInvite({ code, userId, now = Date.now() }) {
      return withTx(() => {
        const inv = this.getInviteByCode(code);
        if (!inv) return { status: 'not_found' };
        if (this.isMember(inv.org_id, userId)) return { status: 'already', orgId: inv.org_id };
        const bump = () => Number(db.prepare(
          `UPDATE org_invites SET use_count = use_count + 1
             WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
               AND (max_uses IS NULL OR use_count < max_uses)`,
        ).run(inv.id, now).changes) > 0;
        if (!bump()) {
          const st = inviteStatus(this.getInvite(inv.id), now);
          // 通常は到達しない(UPDATE の条件と inviteStatus は同じ判定で、トランザクション内)。
          // 'valid' なら 410 invite_valid にせず、もう一度だけ加算を試す。それでも失敗なら例外(500)。
          if (st !== 'valid') return { status: st, orgId: inv.org_id };
          if (!bump()) throw new Error('acceptInvite: 招待は有効なのに use_count を加算できません');
        }
        db.prepare('INSERT OR IGNORE INTO org_members (org_id, user_id, roster_id, linked_at) VALUES (?, ?, NULL, ?)')
          .run(inv.org_id, userId, now);
        return { status: 'joined', orgId: inv.org_id };
      });
    },
  };
}
