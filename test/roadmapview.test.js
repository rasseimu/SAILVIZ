import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepperHtml } from '../src/roadmap.js';

const ms = (specs) => specs.map((s, i) => ({ id: `m${i}`, title: s.title, done: !!s.done, doneAt: s.done ? 1 : null }));

test('stepperHtml: 空なら空メッセージ', () => {
  const html = stepperHtml([]);
  assert.match(html, /まだ段階がありません/);
  assert.doesNotMatch(html, /rm-stepper/);
});

test('stepperHtml: 現在地マークは最初の未達ノードに付く', () => {
  const html = stepperHtml(ms([{ title: 'A', done: true }, { title: 'B' }, { title: 'C' }]));
  // 現在地ラベルは1つだけ
  assert.equal((html.match(/現在地/g) || []).length, 1);
  // 達成ノードは done クラス、現在地ノードは current クラス
  assert.match(html, /rm-done/);
  assert.match(html, /rm-current/);
  // タイトルはエスケープされて含まれる
  assert.match(html, /A/);
  assert.match(html, /B/);
});

test('stepperHtml: 全達成なら末尾ゴールに「達成！」', () => {
  const html = stepperHtml(ms([{ title: 'A', done: true }, { title: 'B', done: true }]));
  assert.match(html, /達成！/);
  assert.doesNotMatch(html, /現在地/);
});

test('stepperHtml: HTML特殊文字をエスケープ', () => {
  const html = stepperHtml(ms([{ title: '<b>x</b>' }]));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
