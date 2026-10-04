// server/domain/overlayRows.js
// 旧オーバーレイ(progress.json / roadmap.json)⇄ DB の行。純関数。
// progress: 反省ID→{issueStage, goalDone, text, comments:{field:[{text,ts,...}]}}
// roadmap : 人名→{goal, milestones:[{id,title,done,doneAt}]}
// 往復保証: 未マップキーは extra(JSON)に保持。列は検索用の非正規化コピー。

const col = (obj, key) => (key in obj ? JSON.stringify(obj[key]) : null);
const addCol = (target, key, value) => { if (value !== null && value !== undefined) target[key] = JSON.parse(value); };
const extraOf = (obj, known) => {
  const e = {};
  for (const k of Object.keys(obj)) if (!known.includes(k)) e[k] = obj[k];
  return Object.keys(e).length ? JSON.stringify(e) : null;
};

export function decomposeProgress(progress, { now = 0 } = {}) {
  const progressRows = [];
  const commentRows = [];
  for (const [reflId, entry] of Object.entries(progress || {})) {
    progressRows.push({
      reflection_id: reflId,
      issue_stage: 'issueStage' in entry ? entry.issueStage : null,
      goal_done: 'goalDone' in entry ? (entry.goalDone ? 1 : 0) : null,
      text: col(entry, 'text'),
      extra: extraOf(entry, ['issueStage', 'goalDone', 'text', 'comments']),
      updated_at: now,
    });
    const comments = entry.comments || {};
    for (const field of Object.keys(comments)) {
      (comments[field] || []).forEach((c, j) => {
        commentRows.push({
          id: `${reflId}#${field}#${j}`,
          reflection_id: reflId,
          field,
          text: 'text' in c ? c.text : null,
          ts: 'ts' in c ? c.ts : null,
          author_user_id: c.authorUserId ?? null,
          extra: extraOf(c, ['text', 'ts']),
        });
      });
    }
  }
  return { progress: progressRows, comments: commentRows };
}

export function assembleProgress({ progress = [], comments = [] }) {
  // field/index 順でコメントをグループ化
  const byRefl = new Map();
  for (const c of [...comments].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))) {
    if (!byRefl.has(c.reflection_id)) byRefl.set(c.reflection_id, {});
    const fields = byRefl.get(c.reflection_id);
    if (!fields[c.field]) fields[c.field] = [];
    const comment = {};
    if (c.text !== null && c.text !== undefined) comment.text = c.text;
    if (c.ts !== null && c.ts !== undefined) comment.ts = c.ts;
    if (c.extra) Object.assign(comment, JSON.parse(c.extra));
    fields[c.field].push(comment);
  }
  const out = {};
  for (const row of progress) {
    const entry = row.extra ? JSON.parse(row.extra) : {};
    if (row.issue_stage !== null && row.issue_stage !== undefined) entry.issueStage = row.issue_stage;
    if (row.goal_done !== null && row.goal_done !== undefined) entry.goalDone = !!row.goal_done;
    addCol(entry, 'text', row.text);
    // comments はコメント行がある場合のみ復元する(行が無い=元に comments キーが無かった)。
    // 「comments:{} が存在する」ケースは表現できないが、実データには存在しない(ledger)。
    if (byRefl.has(row.reflection_id)) entry.comments = byRefl.get(row.reflection_id);
    out[row.reflection_id] = entry;
  }
  return out;
}

export function decomposeRoadmap(roadmap, { now = 0 } = {}) {
  const rows = [];
  for (const [name, entry] of Object.entries(roadmap || {})) {
    rows.push({
      id: `rm_legacy_${rows.length}`,
      user_id: null,
      org_id: null,
      legacy_name: name,
      goal: 'goal' in entry ? entry.goal : null,
      milestones: col(entry, 'milestones'),
      extra: extraOf(entry, ['goal', 'milestones']),
      updated_at: now,
    });
  }
  return { roadmaps: rows };
}

export function assembleRoadmap({ roadmaps = [] }) {
  const out = {};
  for (const row of roadmaps) {
    const entry = row.extra ? JSON.parse(row.extra) : {};
    if (row.goal !== null && row.goal !== undefined) entry.goal = row.goal;
    addCol(entry, 'milestones', row.milestones);
    out[row.legacy_name] = entry;
  }
  return out;
}
