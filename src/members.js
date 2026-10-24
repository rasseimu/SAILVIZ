// ヨット部の学生部員名簿(@メンション候補)。個人アカウントでログインしていない時に使う従来の名簿(下の「名簿の出どころ」)。
// 出典: 【ヨット部】部員名簿2026 の学生本人行(保護者/OB除く)。
// kana = 下の名前のひらがな読み(@メンションの絞り込みキー)。
// ※ ✅ は名簿にフリガナ記載あり。⚠ は名簿にフリガナが無く読みが未確定(要確認)。
export const MEMBERS = [
  { family: '村瀬', given: '礼',   kana: 'れい' },     // ✅
  { family: '高田', given: '咲',   kana: 'さき' },     // ✅
  { family: '木下', given: '佳穂', kana: 'かほ' },     // ✅
  { family: '本間', given: '由真', kana: 'ゆま' },     // ✅
  { family: '高原', given: '直翔', kana: 'なおと' },   // ✅
  { family: '小川', given: '勇希', kana: 'ゆうき' },   // ✅
  { family: '西本', given: '亜美', kana: 'あみ' },     // ✅
  { family: '風間', given: '大煕', kana: 'だいき' },   // ⚠ 未確認
  { family: '伊藤', given: '理々子', kana: 'りりこ' }, // ⚠ 未確認
  { family: '佐藤', given: '妙',   kana: 'たえ' },     // ⚠ 未確認
  { family: '大澤', given: '希',   kana: 'のぞみ' },   // ⚠ 未確認
  { family: '押尾', given: '明汰', kana: 'あらた' },   // ⚠ 未確認
  { family: '上島', given: '滉起', kana: 'ひろき' },   // ⚠ 未確認
  { family: '吉田', given: '悠翔', kana: 'ゆうと' },   // ⚠ 未確認
  { family: '宮田', given: '櫂澄', kana: 'かいと' },   // ⚠ 未確認
  { family: '引池', given: '匠',   kana: 'たくみ' },   // ⚠ 未確認
  { family: '緒方', given: '菜那子', kana: 'ななこ' }, // ⚠ 未確認
  { family: '田巻', given: '隆雅', kana: 'りゅうが' },
  { family: '原田', given: '修有', kana: 'しゅゆ' },
  { family: '星川', given: '桃香', kana: 'ももか' },
];

// ===== 名簿の出どころ =====
// 個人アカウントでログインしていれば、表示中の組織に所属するアカウント(GET /api/orgs/:orgId/members)が名簿。
// 共有パスワードでのログイン・アカウント機能が無い版(ファイル保存)では、上の MEMBERS(従来の名簿)を使う。
// 名簿の1人は { id, fullName, displayName, family, given, kana }。
//   fullName    = 記録(反省の people・進捗・ロードマップ)のキー。組織の名簿で「旧名簿の氏名」を設定した人は
//                 その名前を使い続け、既存の記録を引き継ぐ。それ以外はアカウント名
//   displayName = 画面に出す名前(アカウント名)
//   given       = @メンションで本文に書く名前、kana = 読み(従来の名簿と結び付いた人だけ。無ければ '')

// 従来の名簿(MEMBERS)。id と fullName を付与する。
export function legacyMemberList() {
  return MEMBERS.map((m, i) => {
    const fullName = `${m.family} ${m.given}`;
    return { id: `m${i}`, fullName, displayName: fullName, ...m };
  });
}

// 組織のメンバー [{userId, name, legacyName}] → 名簿。名前の無い人は除き、同じキーは先の人を残す。
// 旧名簿の氏名が従来の名簿(MEMBERS)の人と一致すれば、その姓・名・読みを使う(@メンション・議事録の照合用)。
// それ以外はアカウント名を空白で姓と名に分ける(空白が無ければ全体を名とし、姓は '')。
export function orgRoster(members) {
  const legacy = new Map(legacyMemberList().map((m) => [m.fullName, m]));
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    const name = typeof m?.name === 'string' ? m.name.trim() : '';
    const legacyName = typeof m?.legacyName === 'string' ? m.legacyName.trim() : '';
    const fullName = legacyName || name;
    if (!fullName || seen.has(fullName)) continue;
    seen.add(fullName);
    const old = legacyName ? legacy.get(legacyName) : null;
    const parts = (name || fullName).split(/\s+/);
    out.push({
      id: String(m.userId ?? fullName),
      fullName,
      displayName: name || fullName,
      family: old ? old.family : (parts.length > 1 ? parts[0] : ''),
      given: old ? old.given : (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]),
      kana: old ? old.kana : '',
    });
  }
  return out;
}

// 今の名簿。setMemberRoster で組織の名簿にするまでは従来の名簿。
let currentRoster = null;
export function setMemberRoster(list) {
  currentRoster = Array.isArray(list) && list.length ? list : null;
}
export function memberList() {
  return currentRoster ? currentRoster.map((m) => ({ ...m })) : legacyMemberList();
}

// 記録のキー(fullName)を画面に出す名前にする。名簿に無ければキーのまま。
export function memberLabel(fullName, list = memberList()) {
  return list.find((m) => m.fullName === fullName)?.displayName ?? fullName;
}

// カタカナ→ひらがな(名簿由来の読みを正規化する保険)。
export function toHiragana(s) {
  return String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// @に続く入力(query)で部員を絞り込む。ひらがな読み・下の名前・姓・フルネーム・表示名の前方一致。
// query が空なら全員。大文字カタカナ入力もひらがなに寄せて一致させる。読み・姓が無い人('')はその項目では一致しない。
export function filterMembers(query, list = memberList()) {
  const q = toHiragana(String(query || '').trim());
  if (!q) return list;
  const starts = (s) => !!s && toHiragana(s).startsWith(q);
  // 表示名(アカウント名)の名の部分でも一致させる(旧名簿の氏名で結び付いた人は given が旧名簿のもの)
  const words = (s) => String(s || '').trim().split(/\s+/);
  return list.filter((m) => starts(m.kana) || starts(m.given) || starts(m.family)
    || starts(m.fullName) || starts(m.displayName) || words(m.displayName).some(starts));
}
