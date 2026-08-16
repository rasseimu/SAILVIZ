// ヨット部の学生部員名簿(@メンション候補)。
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
  { family: '上島', given: '滉起', kana: 'こうき' },   // ⚠ 未確認
  { family: '吉田', given: '悠翔', kana: 'はると' },   // ⚠ 未確認
  { family: '宮田', given: '櫂澄', kana: 'かいと' },   // ⚠ 未確認
  { family: '引池', given: '匠',   kana: 'たくみ' },   // ⚠ 未確認
  { family: '緒方', given: '菜那子', kana: 'ななこ' }, // ⚠ 未確認
  { family: '田巻', given: '隆雅', kana: 'りゅうが' },
];

// 各部員に安定IDとフルネームを付与(メンションの一意識別に使う)。
export function memberList() {
  return MEMBERS.map((m, i) => ({
    id: `m${i}`,
    fullName: `${m.family} ${m.given}`,
    ...m,
  }));
}

// カタカナ→ひらがな(名簿由来の読みを正規化する保険)。
export function toHiragana(s) {
  return String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// @に続く入力(query)で部員を絞り込む。ひらがな読み or 漢字の下の名前 前方一致。
// query が空なら全員。大文字カタカナ入力もひらがなに寄せて一致させる。
export function filterMembers(query, list = memberList()) {
  const q = toHiragana(String(query || '').trim());
  if (!q) return list;
  return list.filter((m) => m.kana.startsWith(q) || m.given.startsWith(q) || m.fullName.startsWith(q));
}
