// server/domain/policy.js
// 誰が何を読める・書けるか。純関数(DB・HTTP・時刻に触れない)。設計書 v2 §5.8 が正本。
//
// 主体(subject):
//   anonymous()                              未ログイン
//   user(userId, orgIds)                     ログインユーザー + 所属(紐付け済み)組織
//   legacySharedPrincipal({orgId, canWrite}) 旧共有ログイン = MIGRATION_ORG_ID の組織メンバー(userId なし)
// 対象(target):
//   { kind, visibility?, ownerId?, crewIds?, orgId? }
//   kind: 'session' | 'reflection' | 'race' | 'voice' | 'minutes' | 'roadmap'
//   ownerId = 作成者の userId / crewIds = 乗員の userId / orgId = 対象が属する組織
// 未知の kind・未知の公開範囲は拒否(deny by default)。

export const anonymous = () => ({ kind: 'anonymous' });
export const user = (userId, orgIds = []) => ({ kind: 'user', userId, orgIds: [...orgIds] });

// 旧共有ログイン(閲覧ゲート + 書込トークン)の主体。S2.5 / S2.5-P2。
//   orgId    芝浦の組織 ID(取込みと同じ MIGRATION_ORG_ID)。未設定なら null(空文字も null 扱い)。
//            2026-10-19 利用者決定: orgId が null の共有ログインは何も読めない・書けない
//            (組織なしの旧データにも一致させない。public も含めて全拒否)。
//   canWrite 共有の書込トークン(または閲覧ログイン。閲覧ゲート有効時)で書けるか。
// トークンがあれば自組織のセッション・反省・レース・ロードマップ・議事録を書ける
// (現行の互換 API の書き込みを壊さない)。声の反省(voice)は互換 API に無く private なので、作成者だけのまま。
export const legacySharedPrincipal = ({ orgId = null, canWrite = false } = {}) => ({
  kind: 'legacy', shared: true, orgId: orgId || null, canWrite: !!canWrite,
});

const isLoggedIn = (s) => !!s && (s.kind === 'user' || s.kind === 'legacy');
const orgIdsOf = (s) => {
  if (!s) return [];
  if (s.kind === 'legacy') return s.shared && s.orgId != null ? [s.orgId] : [];
  if (s.kind === 'user') return s.orgIds || [];
  return [];
};
const isSharedLegacy = (s) => !!s && s.kind === 'legacy' && s.shared === true;
// 組織未設定の共有ログイン: 何も読めない・書けない。
const isUnscopedLegacy = (s) => isSharedLegacy(s) && s.orgId == null;
const isOrgMember = (s, t) => !!t && t.orgId != null && orgIdsOf(s).includes(t.orgId);
const isOwner = (s, t) => !!s && s.kind === 'user' && s.userId != null && t.ownerId != null && s.userId === t.ownerId;
const isCrew = (s, t) => !!s && s.kind === 'user' && s.userId != null && Array.isArray(t.crewIds) && t.crewIds.includes(s.userId);

// 主体が組織(orgId)のメンバーか(対象を持たない空の器の判定などに使う)。
export const isMemberOfOrg = (subject, orgId) => !isUnscopedLegacy(subject) && isOrgMember(subject, { orgId });

const VIS = ['private', 'org', 'public'];

export function canRead(subject, target) {
  if (!target) return false;
  if (isUnscopedLegacy(subject)) return false;
  switch (target.kind) {
    case 'session':
      if (!VIS.includes(target.visibility)) return false;
      if (isOwner(subject, target) || isCrew(subject, target)) return true;
      if (target.visibility === 'public') return true;
      if (target.visibility === 'org') return isOrgMember(subject, target);
      return false;
    case 'reflection':
      if (!VIS.includes(target.visibility)) return false;
      if (isOwner(subject, target)) return true;
      if (target.visibility === 'public') return true;
      if (target.visibility === 'org') return isOrgMember(subject, target);
      return false;
    case 'race':
      return true;
    case 'voice':
      return isOwner(subject, target);
    case 'minutes':
      return isOwner(subject, target) || isOrgMember(subject, target);
    case 'roadmap':
      // 2026-10-19 利用者決定: ロードマップの読み取りは本人と組織メンバーだけ(§5.8 の表には行が無い)。
      return isOwner(subject, target) || isOrgMember(subject, target);
    default:
      return false;
  }
}

// 書き込みは作成者だけ。例外: 練習日の議事録は組織メンバーなら誰でも作り直せる。
export function canWrite(subject, target) {
  if (!target) return false;
  if (isUnscopedLegacy(subject)) return false;
  if (isSharedLegacy(subject)) {
    switch (target.kind) {
      case 'session': case 'reflection':
        // 自組織の対象で、かつ読めるもの(org・public)だけ。他組織の public は読めても書けない。
        return subject.canWrite && isOrgMember(subject, target) && canRead(subject, target);
      case 'race': case 'roadmap': case 'minutes':
        return subject.canWrite && isOrgMember(subject, target);
      default:
        return false;
    }
  }
  switch (target.kind) {
    case 'session':
    case 'reflection':
    case 'race':
    case 'voice':
    case 'roadmap':
      return isOwner(subject, target);
    case 'minutes':
      return isOwner(subject, target) || isOrgMember(subject, target);
    default:
      return false;
  }
}

// 反省の進捗・コメントは、その反省を見られる人が見られる。
export function canReadReflectionExtras(subject, reflection) {
  return !!reflection && reflection.kind === 'reflection' && canRead(subject, reflection);
}

// コメントは、見られるログインユーザーが書ける。
// 2026-10-19 利用者決定: 共有ログインのコメントは自分の組織の反省だけ(他組織の public には書けない)。
export function canComment(subject, reflection) {
  if (isSharedLegacy(subject) && (!subject.canWrite || !isOrgMember(subject, reflection))) return false;
  return isLoggedIn(subject) && canReadReflectionExtras(subject, reflection);
}

// 進捗の更新は作成者と組織メンバー(現行どおり)。
// 2026-10-19 利用者決定: ただし読めない反省(例: 他人の private)の進捗は更新できない。
export function canUpdateProgress(subject, reflection) {
  if (isSharedLegacy(subject) && !subject.canWrite) return false;
  return !!reflection && reflection.kind === 'reflection'
    && (isOwner(subject, reflection) || isOrgMember(subject, reflection))
    && canRead(subject, reflection);
}

// 練習日の器: 見てよい中身だけを返す。1つでも見られれば器も見える。
export function visibleDayItems(subject, items) {
  return (items || []).filter((t) => canRead(subject, t));
}
export function canSeeDayContainer(subject, items) {
  return visibleDayItems(subject, items).length > 0;
}
