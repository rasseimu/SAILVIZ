// src/daysummaryschema.js
// 今日の練習サマリ(daySummary)の保存形式の定義。計算(daysummary.js)・保存(project.js)・一覧(summary.js)が共有する。
// 保存形式のバージョン。フィールドの意味を変えたら上げる(古い版は読込時に null → 黙って再計算)。
export const DAY_SUMMARY_VERSION = 1;
