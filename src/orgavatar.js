// サイドバーのアカウント欄に出す組織アバター。
// 色・模様は組織 ID のハッシュから決める(ランダムに見えるが同じ組織なら毎回同じ。改名しても変わらない)。
// 純関数。DOM には触れない。

// FNV-1a(32bit)。見た目を散らすだけなので暗号強度は不要。
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// 2 色グラデーションの上に重ねる模様(白の半透明)。
const PATTERNS = [
  null,
  'radial-gradient(circle at 30% 25%, rgba(255,255,255,.35) 0 22%, transparent 23%)',
  'repeating-linear-gradient(45deg, rgba(255,255,255,.18) 0 4px, transparent 4px 8px)',
  'radial-gradient(circle at 50% 50%, transparent 0 34%, rgba(255,255,255,.22) 35% 44%, transparent 45%)',
  'radial-gradient(rgba(255,255,255,.28) 1.5px, transparent 2px) 0 0 / 7px 7px',
  'linear-gradient(135deg, rgba(255,255,255,.22) 0 50%, transparent 50%)',
];
const ANGLES = [45, 90, 135, 180, 225, 315];

export function orgAvatar(org) {
  const h = hash(org?.id);
  const hue = h % 360;
  const hue2 = (hue + 25 + ((h >>> 9) % 50)) % 360; // 隣り合う色相で濁らせない
  const angle = ANGLES[(h >>> 15) % ANGLES.length];
  const pattern = PATTERNS[(h >>> 19) % PATTERNS.length];
  const gradient = `linear-gradient(${angle}deg, hsl(${hue} 65% 45%) 0%, hsl(${hue2} 70% 58%) 100%)`;
  const first = [...String(org?.name ?? '').trim()][0];
  return {
    initial: first ? first.toUpperCase() : '?',
    background: pattern ? `${pattern}, ${gradient}` : gradient,
  };
}
