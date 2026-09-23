// 風速帯の単一語彙。語優先→数値フォールバックで反省を4帯に分類する。純ロジック。
export const WIND_BANDS = [
  { key: 'bihuu', label: '微風 (〜3 m/s)',      max: 3,        words: ['微風', '無風'] },
  { key: 'chuu',  label: '中風・順風 (3〜6 m/s)', max: 6,        words: ['中風', '順風'] },
  { key: 'kyou',  label: '強風 (6〜10 m/s)',     max: 10,       words: ['強風'] },
  { key: 'baku',  label: '爆風 (10 m/s〜)',      max: Infinity, words: ['爆風'] },
];

// 文中の風速語を走査。複数帯の語があれば最も強い帯(配列後方)を返す。無ければ null。
export function detectBandWord(text) {
  const s = String(text ?? '');
  let found = null;
  for (let i = 0; i < WIND_BANDS.length; i++) {
    if (WIND_BANDS[i].words.some((w) => s.includes(w))) found = WIND_BANDS[i].key;
  }
  return found;
}

// 語優先→数値フォールバック。分類不能は 'unknown'。境界は max 未満(排他)。
export function classifyWindBand(text, speed) {
  const w = detectBandWord(text);
  if (w) return w;
  const n = Number(speed);
  if (speed == null || !Number.isFinite(n)) return 'unknown';
  for (const b of WIND_BANDS) if (n < b.max) return b.key;
  return WIND_BANDS[WIND_BANDS.length - 1].key;
}

const KEYS = WIND_BANDS.map((b) => b.key);

export function adjacentBands(key) {
  const i = KEYS.indexOf(key);
  if (i === -1) return [];
  const out = [];
  if (i - 1 >= 0) out.push(KEYS[i - 1]);
  if (i + 1 < KEYS.length) out.push(KEYS[i + 1]);
  return out;
}

export function bandLabel(key) {
  return WIND_BANDS.find((b) => b.key === key)?.label ?? key;
}

// 同帯優先→不足で隣接→なお不足で全帯。general は常に対象。元の順序を保つ。
export function filterByBand(candidates, targetBand, { min = 2, getBand } = {}) {
  const general = candidates.filter((c) => getBand(c) === 'general');
  const banded = candidates.filter((c) => getBand(c) !== 'general');
  let pick = banded.filter((c) => getBand(c) === targetBand);
  if (pick.length < min) {
    const adj = new Set(adjacentBands(targetBand));
    pick = banded.filter((c) => getBand(c) === targetBand || adj.has(getBand(c)));
  }
  if (pick.length < min) pick = banded;
  const keep = new Set([...general, ...pick]);
  return candidates.filter((c) => keep.has(c));
}

export function bandSectionFromDigest(bandBullets, bandKey) {
  const arr = bandBullets && bandBullets[bandKey];
  return Array.isArray(arr) ? arr : [];
}
