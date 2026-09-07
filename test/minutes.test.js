import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMinutes, matchMember, parseMinutesDate } from '../src/minutes.js';
import { memberList } from '../src/members.js';

const SAMPLE = `# 練習振り返り 議事録

## ゆま（本間ゆま）
- **今日の目標**：ジャイブ。加えてクローズ・ランニングの艇速を安定させる。
- **課題**：強風クローズで起こしきれず、あまり何もせず走ってしまった。
- **発見**：北に強く吹いた時のランニングは何もしない方が速いのではと感じた。

## だいき（風間）
- **今日の目標**：リーチの閉じ具合の誤差をなくす。
- **課題**：閉じ過ぎていることが多かった。
- **発見**：特になし。

## しゅゆ
- **今日の目標**：追風のクルーワークを行うこと。
- **課題**：スピンが貼れず、原因を詰めたい。
- **取り組み**：午前・午後とも動画を撮影し学んだ。

## ゆうと（吉田）
- **今日の目標**：タックのタイミングを早く。
- **課題**：うねりの処理ができなかった。
- **今後**：ジャイブでロールをかけたい。`;

test('parseMinutes は ## 見出しごとにブロック分割し括弧内をヒントにする', () => {
  const blocks = parseMinutes(SAMPLE);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].headerName, 'ゆま');
  assert.equal(blocks[0].fullNameHint, '本間ゆま');
  assert.equal(blocks[2].headerName, 'しゅゆ');
  assert.equal(blocks[2].fullNameHint, null);
});

test('parseMinutes は目標/課題/発見ラベルを吸収する', () => {
  const b = parseMinutes(SAMPLE)[0];
  assert.match(b.goal, /ジャイブ/);
  assert.match(b.issue, /強風クローズ/);
  assert.match(b.discovery, /北に強く吹いた/);
});

test('parseMinutes は 今後/取り組み を discovery に集約する', () => {
  const blocks = parseMinutes(SAMPLE);
  const shuyu = blocks[2];
  const yuto = blocks[3];
  assert.match(shuyu.discovery, /動画を撮影/);   // 取り組み → discovery
  assert.match(yuto.discovery, /ロールをかけたい/); // 今後 → discovery
});

test('matchMember: 括弧フルネーム→姓→kana の順で名簿に解決する', () => {
  const roster = memberList();
  assert.equal(matchMember('ゆま', '本間ゆま', roster).member.fullName, '本間 由真');
  assert.equal(matchMember('だいき', '風間', roster).member.fullName, '風間 大煕');
  assert.equal(matchMember('しゅゆ', null, roster).member.fullName, '原田 修有'); // kana
  assert.equal(matchMember('れい', null, roster).member.fullName, '村瀬 礼');     // kana
  assert.equal(matchMember('だれか', null, roster).member, null);                 // 未一致
});

// 実運用の議事録は Markdown 記号(##, -, **)を使わない素のテキストが多い。
const PLAIN = `ゆま
今日の目標：ジャイブを安定させる。
課題：強風クローズで起こしきれず走ってしまった。
発見：北風ランニングは何もしない方が速い。
ももか
今日の目標：全ての動作をスムーズに。
反省点：周期的な波を予測できなかった。
気づき：ポールを離すタイミングが分かった。`;

test('parseMinutes は素のテキスト(##/箇条書き/太字なし)を裸の名前見出しで分割する', () => {
  const blocks = parseMinutes(PLAIN);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].headerName, 'ゆま');
  assert.equal(blocks[1].headerName, 'ももか');
});

test('parseMinutes は素のテキストの 目標/課題/発見 ラベルを吸収する', () => {
  const b = parseMinutes(PLAIN)[0];
  assert.match(b.goal, /ジャイブを安定/);
  assert.match(b.issue, /強風クローズ/);
  assert.match(b.discovery, /北風ランニング/);
});

test('parseMinutes は 反省点→課題 / 気づき→発見 の別名を解決する', () => {
  const momoka = parseMinutes(PLAIN)[1];
  assert.match(momoka.issue, /周期的な波/);      // 反省点 → issue
  assert.match(momoka.discovery, /ポールを離す/); // 気づき → discovery
});

test('parseMinutes は全角半角コロン両対応、未知ラベルは無視', () => {
  const b = parseMinutes('## X（山田太郎）\n- **今日の目標**:半角コロン\n- **雑談**：無視される')[0];
  assert.equal(b.goal, '半角コロン');
  assert.equal(b.issue, '');
  assert.equal(b.discovery, '');
});

test('parseMinutesDate: 年ありスラッシュ + 時刻', () => {
  assert.deepEqual(parseMinutesDate('練習 2026/9/7 13:30 の記録'),
    { y: 2026, mo: 9, d: 7, h: 13, mi: 30 });
});

test('parseMinutesDate: ISO ハイフン(時刻なしは0:0)', () => {
  assert.deepEqual(parseMinutesDate('日付：2026-09-07'),
    { y: 2026, mo: 9, d: 7, h: 0, mi: 0 });
});

test('parseMinutesDate: 和暦表記 2026年9月7日 13時30分', () => {
  assert.deepEqual(parseMinutesDate('2026年9月7日 13時30分〜'),
    { y: 2026, mo: 9, d: 7, h: 13, mi: 30 });
});

test('parseMinutesDate: 年なしは defaultYear を補う', () => {
  assert.deepEqual(parseMinutesDate('9月7日の練習', { defaultYear: 2026 }),
    { y: 2026, mo: 9, d: 7, h: 0, mi: 0 });
});

test('parseMinutesDate: 年なしで defaultYear 無しは null', () => {
  assert.equal(parseMinutesDate('9月7日の練習'), null);
});

test('parseMinutesDate: 日付が無ければ null', () => {
  assert.equal(parseMinutesDate('今日は良い風でした', { defaultYear: 2026 }), null);
});
