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
