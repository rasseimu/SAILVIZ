import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMinutes, matchMember } from '../src/minutes.js';
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

test('parseMinutes は全角半角コロン両対応、未知ラベルは無視', () => {
  const b = parseMinutes('## X（山田太郎）\n- **今日の目標**:半角コロン\n- **雑談**：無視される')[0];
  assert.equal(b.goal, '半角コロン');
  assert.equal(b.issue, '');
  assert.equal(b.discovery, '');
});
