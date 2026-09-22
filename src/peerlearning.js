// 進捗の解決履歴(解決済み課題・達成済み目標)に、同一部員がその後に書いた反省
// (発見・目標/課題の変化)を「解決の手がかり」として添え、未解決アイテムへ実名引用の
// 助言コメントを Gemini で生成する。参考文献ベースの aicomment.js と対の、チーム内
// ピア学習ベースのコメント源。純ロジック(プール構築・プロンプト・検証)は API 呼び出しから
// 分離してテスト可能にする。
import { summarize, windBinKey } from './progressstore.js';

const FIELD_LABEL = { goal: '目標', issue: '課題', discovery: '発見' };

// 解決アイテムごとに、同一部員が"以降"に書いた発見・課題/目標の変化を最大 maxEvidence 件添える。
// reflections=全反省, progress=sailviz.progress。
export function buildHistoryPool(reflections, progress, { maxEvidence = 5 } = {}) {
  const sum = summarize(reflections, progress);
  const speedById = new Map();
  for (const r of reflections) if (r?.id != null) speedById.set(r.id, r.wind?.speed ?? null);

  const pool = [];
  let seq = 0;
  for (const [member, b] of Object.entries(sum.byMember)) {
    // その部員の発見(全風速ビンを平坦化)と、目標/課題テキストの時系列(手がかり候補)。
    const discoveries = Object.values(b.discoveriesByBin).flat().map((d) =>
      ({ dateMs: d.dateMs, field: 'discovery', text: d.text, windBin: windBinKey(d.speed) }));
    const changes = [
      ...b.issues.map((it) => ({ dateMs: it.dateMs, field: 'issue', text: it.text })),
      ...b.goals.map((g) => ({ dateMs: g.dateMs, field: 'goal', text: g.text })),
    ];
    const resolved = [
      ...b.issues.filter((it) => it.stage === 2)
        .map((it) => ({ reflId: it.reflId, field: 'issue', text: it.text, dateMs: it.dateMs })),
      ...b.goals.filter((g) => g.done)
        .map((g) => ({ reflId: g.reflId, field: 'goal', text: g.text, dateMs: g.dateMs })),
    ];
    for (const item of resolved) {
      const wb = windBinKey(speedById.get(item.reflId));
      // 手がかり = 解決日時"以降"の発見(主)+ 後続の課題/目標の変化。
      const cand = [
        ...discoveries.filter((d) => d.dateMs >= item.dateMs),
        ...changes.filter((c) => c.dateMs > item.dateMs),
      ];
      // 風速帯が近い発見を優先し、次に新しい順。最大 maxEvidence 件。
      cand.sort((a, c) => {
        const am = a.windBin && a.windBin === wb ? 0 : 1;
        const cm = c.windBin && c.windBin === wb ? 0 : 1;
        if (am !== cm) return am - cm;
        return c.dateMs - a.dateMs;
      });
      const evidence = cand.slice(0, maxEvidence)
        .map((e) => ({ dateMs: e.dateMs, field: e.field, text: e.text }));
      pool.push({ poolId: `p${seq++}`, member, field: item.field, text: item.text, dateMs: item.dateMs, windBin: wb, evidence });
    }
  }
  return pool;
}
