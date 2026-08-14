// 単純なCSV（引用符・カンマ埋め込み非対応）を {header, rows} に分解。
// Sensor Logger / タグCSV はいずれも素直なカンマ区切りのため十分。
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(',').map((c) => c.trim());
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
  return { header, rows };
}
