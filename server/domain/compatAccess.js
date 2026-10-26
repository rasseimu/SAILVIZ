// server/domain/compatAccess.js
// 互換 API(旧 JSON の GET/PUT)に policy.js の判定を当てる純関数(DB・HTTP に触れない)。S2.5-P2。
// 設計書 v2 §10.8「互換 GET は §5.8 で絞る」「PUT は見えない項目を消さない」。
//
// アクセス情報(access)は repo が練習日の器ごとに返す:
//   { orgId, tracks:[{kind,visibility,ownerId,crewIds}], reflections:[{id,visibility,ownerId}] }
//   tracks / reflections は assembleProject が組み立てる旧 JSON の配列と同じ順(インデックスが対応する)。
import {
  canRead as policyCanRead, canWrite as policyCanWrite, canComment as policyCanComment,
  canUpdateProgress as policyCanUpdateProgress, isMemberOfOrg as policyIsMemberOfOrg, activeOrgOf,
} from './policy.js';

// 互換 API で書けるのは「組織設定済みで書込権限のある共有ログイン」と
// 「表示中の組織があるログインユーザー」(設計書 §5.4。所属外ヘッダーの orgForbidden は除く)。
export const isCompatWriter = (s) => !!s && (
  (s.kind === 'legacy' && s.shared === true && s.canWrite === true && s.orgId != null)
  || (s.kind === 'user' && s.activeOrgId != null && !s.orgForbidden));

// 対象の組織が主体の表示中の組織か(設計書 §5.3・§5.4)。
//   user:   表示中の組織の対象だけ(他組織の public も含めて外は読み書きしない)。表示中の組織が無ければ何も無い。
//   それ以外(共有ログイン・未ログイン): 常に真(今の動きを保つ)。
export const inScope = (subject, orgId) => {
  if (!subject || subject.kind !== 'user') return true;
  const active = activeOrgOf(subject);
  return active != null && orgId === active;
};

// 以下の判定は、表示中の組織の外の対象を「読めない」として扱う(読み取りでは出さず、書き込みでは既存のまま残す)。
const canRead = (s, t) => !!t && inScope(s, t.orgId) && policyCanRead(s, t);
const canWrite = (s, t) => !!t && inScope(s, t.orgId) && policyCanWrite(s, t);
const canComment = (s, t) => !!t && inScope(s, t.orgId) && policyCanComment(s, t);
const canUpdateProgress = (s, t) => !!t && inScope(s, t.orgId) && policyCanUpdateProgress(s, t);
const isMemberOfOrg = (s, orgId) => inScope(s, orgId) && policyIsMemberOfOrg(s, orgId);
const canSeeDayContainer = (s, items) => (items || []).some((t) => canRead(s, t));

export const sessionTarget = (t, orgId) => ({
  kind: t.kind === 'race' ? 'race' : 'session',
  visibility: t.visibility, ownerId: t.ownerId ?? null, crewIds: t.crewIds || [], orgId: orgId ?? null,
});
export const reflectionTarget = (r, orgId) => ({
  kind: 'reflection', visibility: r.visibility, ownerId: r.ownerId ?? null, orgId: orgId ?? null,
});

// 器が見えるか(一覧用。中身を読まずに access だけで判定する)。
// 器そのものは公開範囲を持たない: 中身を1つでも見られれば見える。中身が空の器は組織メンバーに見える。
export function canSeeProject(subject, access) {
  if (!access) return false;
  const items = [
    ...(access.tracks || []).map((t) => sessionTarget(t, access.orgId)),
    ...(access.reflections || []).map((r) => reflectionTarget(r, access.orgId)),
  ];
  return items.length === 0 ? isMemberOfOrg(subject, access.orgId) : canSeeDayContainer(subject, items);
}

// 練習日の JSON を主体に見えるものだけに絞る。器が見えなければ null。
export function filterProject(subject, proj, access) {
  if (!canSeeProject(subject, access)) return null;
  const tTargets = (access.tracks || []).map((t) => sessionTarget(t, access.orgId));
  const rTargets = (access.reflections || []).map((r) => reflectionTarget(r, access.orgId));
  const tracks = Array.isArray(proj.tracks) ? proj.tracks : [];
  const reflections = Array.isArray(proj.reflections) ? proj.reflections : [];
  // access に無い項目(通常は無い)は見せない。
  const keepT = tracks.filter((_, i) => i < tTargets.length && canRead(subject, tTargets[i]));
  const keepR = reflections.filter((_, i) => i < rTargets.length && canRead(subject, rTargets[i]));
  return { ...proj, tracks: keepT, reflections: keepR };
}

// PUT で incoming が管理してよい反省の行か(見えて書ける行だけ。それ以外は触らない)。
export const managedReflectionPredicate = (subject, orgId) => (row) => canWrite(subject, reflectionTarget(row, orgId));

// PUT してよいか。器が既にあればその組織のメンバーであること。
export function canPutDay(subject, access) {
  if (!isCompatWriter(subject)) return false;
  return !access || isMemberOfOrg(subject, access.orgId);
}

// DELETE してよいか。器の中身を全部書けるときだけ(見えない項目を巻き込んで消さない)。
export function canDeleteDay(subject, access) {
  if (!access || !isCompatWriter(subject) || !isMemberOfOrg(subject, access.orgId)) return false;
  return (access.tracks || []).every((t) => canWrite(subject, sessionTarget(t, access.orgId)))
    && (access.reflections || []).every((r) => canWrite(subject, reflectionTarget(r, access.orgId)));
}

// ---- progress(反省ID → 進捗)----
// reflIndex: Map(反省ID → [反省の target,…])。同じ ID が複数の器にある旧データでは全部が条件を満たすときだけ許す。
export function buildReflectionIndex(list) {
  const m = new Map();
  for (const r of list || []) {
    if (!m.has(r.id)) m.set(r.id, []);
    m.get(r.id).push(reflectionTarget(r, r.orgId));
  }
  return m;
}
// 反省に対応しない(孤立した)進捗: 共有ログインにだけ見せる(従来どおり)。ユーザーには見せない。
const orphanOpen = (s) => !!s && s.kind === 'legacy' && s.shared === true && s.orgId != null;

export function filterProgressRead(subject, progress, reflIndex) {
  const out = {};
  for (const [id, entry] of Object.entries(progress || {})) {
    const ts = reflIndex.get(id);
    const ok = ts && ts.length ? ts.every((t) => canRead(subject, t)) : orphanOpen(subject);
    if (ok) out[id] = entry;
  }
  return out;
}

const withoutComments = (e) => { const { comments, ...rest } = e; return rest; };

// 新 API(/api/reflections/:id/comments)で足したコメント(via: 'api')を、Web の古い画面の全置き換えで消さない(設計書 Phase 4 §6)。
// 既存のコメントのうち via が 'api' で、incoming の同じ field に ts と text が同じものが無いものを、incoming の field の末尾に足す。
// readAt(Web が進捗を読んだサーバの時刻)があれば、それより前からあるコメントは Web が消したものとして足さない
// (新 API のコメントの ts はサーバの時刻)。readAt が無い(古い Web の画面)ときは全部足す。
// Web で書いたコメント(名前付き)は従来どおり incoming に従う。incoming は書き換えない。
export function keepNewApiComments(existingEntry, incomingEntry, readAt) {
  const exC = existingEntry?.comments;
  if (!exC || typeof exC !== 'object') return incomingEntry;
  const incC = incomingEntry?.comments && typeof incomingEntry.comments === 'object' ? incomingEntry.comments : {};
  const knownBefore = (c) => Number.isFinite(readAt) && Number.isFinite(c.ts) && c.ts < readAt;
  let comments = null;
  for (const [field, list] of Object.entries(exC)) {
    if (!Array.isArray(list)) continue;
    const cur = Array.isArray(incC[field]) ? incC[field] : [];
    const keep = list.filter((c) => c && c.via === 'api' && !knownBefore(c)
      && !cur.some((d) => d && d.ts === c.ts && d.text === c.text));
    if (!keep.length) continue;
    comments ??= { ...incC };
    comments[field] = [...cur, ...keep];
  }
  return comments ? { ...incomingEntry, comments } : incomingEntry;
}

// Web が新しく足したコメント(existing の同じ field に ts と text が同じものが無いもの)は、名簿(roster の fullName)の
// 名前(author)が要る。議事録の取込(validateCommitRows の「名簿外の fullName」)と同じ扱い。AI コメント(ai: true)は問わない。
// 前からあるコメント(旧データの名前なしを含む)はそのまま送り返してよい。問題が無ければ null、あれば理由の文字列。
export function commentAuthorError(existing, incoming, roster) {
  const names = new Set((roster || []).map((m) => m.fullName));
  for (const [id, entry] of Object.entries(incoming || {})) {
    const comments = entry && typeof entry === 'object' ? entry.comments : null;
    if (!comments || typeof comments !== 'object') continue;
    for (const [field, list] of Object.entries(comments)) {
      if (!Array.isArray(list)) continue;
      const prev = existing?.[id]?.comments?.[field];
      const before = Array.isArray(prev) ? prev : [];
      for (const c of list) {
        if (!c || typeof c !== 'object' || c.ai) continue;
        if (before.some((d) => d && d.ts === c.ts && d.text === c.text)) continue;
        const author = typeof c.author === 'string' ? c.author.trim() : '';
        if (!author) return 'コメントに名前がありません';
        if (!names.has(author)) return `名簿外のコメントの名前: ${author}`;
      }
    }
  }
  return null;
}

// PUT /api/overlays/progress は全置き換えだが、主体が見えない・更新できない項目は元のまま残す。
//  - 読めない反省の進捗: 既存のまま(incoming は無視)
//  - 読めるが進捗を更新できない: 進捗の値は既存のまま
//  - コメントを書けない: コメントは既存のまま
//  - incoming に無い項目: 更新できるなら消す(従来の全置き換え)、できなければ残す
// opts.readAt: Web が進捗を読んだサーバの時刻(keepNewApiComments)。
export function mergeProgressWrite(subject, existing, incoming, reflIndex, { readAt } = {}) {
  const out = {};
  const ex = existing || {};
  const inc = {}; // オブジェクトでない項目は無視する
  for (const [k, v] of Object.entries(incoming || {})) if (v && typeof v === 'object' && !Array.isArray(v)) inc[k] = v;
  for (const id of new Set([...Object.keys(ex), ...Object.keys(inc)])) {
    const ts = reflIndex.get(id);
    let canProg; let canCom; let readable;
    if (ts && ts.length) {
      readable = ts.every((t) => canRead(subject, t));
      canProg = readable && ts.every((t) => canUpdateProgress(subject, t));
      canCom = readable && ts.every((t) => canComment(subject, t));
    } else {
      readable = orphanOpen(subject) && subject.canWrite === true;
      canProg = readable; canCom = readable;
    }
    if (!readable) { if (id in ex) out[id] = ex[id]; continue; }
    const e = ex[id]; const n = inc[id];
    if (n === undefined) { // incoming に無い
      if (!canProg && e !== undefined) out[id] = e;
      else if (e !== undefined) {
        // Web が進捗行の無いうちに読んだ古い一覧でも、読んだ後に新 API で足したコメントだけは残す。
        // 進捗の値(Web が消したもの)は戻さない。
        const kept = keepNewApiComments(e, {}, readAt);
        if (kept.comments) out[id] = kept;
      }
      continue;
    }
    if (e === undefined) { // 新規
      if (canProg) {
        const entry = canCom ? n : withoutComments(n);
        out[id] = entry;
      } else if (canCom && n.comments !== undefined) {
        out[id] = { comments: n.comments };
      }
      continue;
    }
    const base = canProg ? withoutComments(n) : withoutComments(e);
    const comments = canCom ? keepNewApiComments(e, n, readAt).comments : e.comments;
    out[id] = comments === undefined ? base : { ...base, comments };
  }
  return out;
}

// ---- roadmap(人名 → ロードマップ)----
// access: [{legacyName, orgId, userId}]
const roadmapTarget = (a) => ({ kind: 'roadmap', ownerId: a.userId ?? null, orgId: a.orgId ?? null });
const roadmapMap = (access) => new Map((access || []).map((a) => [a.legacyName, roadmapTarget(a)]));

export function filterRoadmapRead(subject, roadmap, access) {
  const m = roadmapMap(access);
  const out = {};
  for (const [name, entry] of Object.entries(roadmap || {})) {
    const t = m.get(name);
    if (t && canRead(subject, t)) out[name] = entry;
  }
  return out;
}

// 全置き換えのうち、読めない行・書けない行は元のまま。新しい名前は自組織の行として作られる。
export function mergeRoadmapWrite(subject, existing, incoming, access) {
  const m = roadmapMap(access);
  const out = {};
  const ex = existing || {}; const inc = incoming || {};
  for (const name of new Set([...Object.keys(ex), ...Object.keys(inc)])) {
    const t = m.get(name);
    if (!t) { // 既存に無い名前 = 新規
      if (name in inc && isCompatWriter(subject)) out[name] = inc[name];
      continue;
    }
    if (canRead(subject, t) && canWrite(subject, t)) {
      if (name in inc) out[name] = inc[name]; // incoming に無ければ消す(従来どおり)
    } else if (name in ex) out[name] = ex[name];
  }
  return out;
}
