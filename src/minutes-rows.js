// モバイル議事録プレビューの行モデル(DOM 非依存・純)。
// Row = { fullName: string|null, include: boolean, goal, issue, discovery, raw }
import { matchMember } from './minutes.js';
import { memberList } from './members.js';

// parseAiMinutes の出力 → プレビュー行。未割当(null)は既定で取込オフ。
export function aiToRows(items, roster = memberList()) {
  return items.map((it) => ({
    fullName: it.fullName ?? null,
    include: !!it.fullName,
    goal: it.goal || '', issue: it.issue || '', discovery: it.discovery || '', raw: it.raw || '',
  }));
}

// parseMinutes のブロック → プレビュー行(AIなしフォールバック)。matchMember で名簿照合。
export function blocksToRows(blocks, roster = memberList()) {
  return blocks.map((b) => {
    const { member } = matchMember(b.headerName, b.fullNameHint, roster);
    const fullName = member ? member.fullName : null;
    return {
      fullName, include: !!fullName,
      goal: b.goal || '', issue: b.issue || '', discovery: b.discovery || '', raw: b.raw || '',
    };
  });
}

// 取込対象(採用かつ部員割当済み)のみ commit ペイロード行へ。
export function toCommitRows(rows) {
  return rows
    .filter((r) => r.include && r.fullName)
    .map((r) => ({ fullName: r.fullName, goal: r.goal, issue: r.issue, discovery: r.discovery, raw: r.raw }));
}
