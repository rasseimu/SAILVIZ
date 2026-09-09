// スマホ議事録 commit の純ロジック(HTTP 非依存)。node --test 可能。
import { memberList } from '../src/members.js';
import { createReflection } from '../src/reflections.js';
import { PROJECT_VERSION } from '../src/project.js';

// commit 行のバリデーション。問題があれば理由文字列、無ければ null。
export function validateCommitRows(rows, practiceDate, roster = memberList()) {
  if (!Number.isFinite(practiceDate)) return 'practiceDate が数値でない';
  if (!Array.isArray(rows) || rows.length === 0) return 'rows が空';
  const names = new Set(roster.map((m) => m.fullName));
  for (const r of rows) {
    if (!r || typeof r.fullName !== 'string' || !names.has(r.fullName)) {
      return `名簿外の fullName: ${r && r.fullName}`;
    }
  }
  return null;
}

// 同一 fullName の複数行を1行にマージ(初出順、goal/issue/discovery/raw を改行連結)。
export function mergeRowsByMember(rows) {
  const order = [];
  const byName = new Map();
  const join = (a, b) => (a && b ? `${a}\n${b}` : a || b || '');
  for (const r of rows) {
    if (!byName.has(r.fullName)) {
      byName.set(r.fullName, {
        fullName: r.fullName, goal: r.goal || '', issue: r.issue || '',
        discovery: r.discovery || '', raw: r.raw || '',
      });
      order.push(r.fullName);
      continue;
    }
    const cur = byName.get(r.fullName);
    cur.goal = join(cur.goal, r.goal || '');
    cur.issue = join(cur.issue, r.issue || '');
    cur.discovery = join(cur.discovery, r.discovery || '');
    cur.raw = join(cur.raw, r.raw || '');
  }
  return order.map((n) => byName.get(n));
}

// マージ済み行 → Reflection 配列。id/createdAt は now から決定的に採番(デスクトップと同じ timestamp+seq 方式)。
export function reflectionsFromRows({ rows, now }) {
  return rows.map((r, i) => createReflection({
    id: `refl${now}_${i}`,
    createdAt: now,
    text: r.raw,
    people: [r.fullName],
    notes: { goal: r.goal, issue: r.issue, discovery: r.discovery },
    wind: null,
    practice: null,
  }));
}

// deserializeProject を通る空プロジェクト骨組み。
export function emptyProject(practiceDate, savedAt = null) {
  return {
    version: PROJECT_VERSION,
    savedAt,
    mode: 'absolute',
    accuracyFilter: true,
    crop: { start: 0, end: 0 },
    tracks: [], events: [], marks: [], pins: [], videos: [],
    reflections: [],
    practiceDate,
    basemap: null,
  };
}
