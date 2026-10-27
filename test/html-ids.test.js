// index.html の id 重複ガード。
// 別々の機能ブランチをマージした際、同じ id を持つ要素が両方残ると
// getElementById が先頭要素しか返さず、後から配線した addEventListener が
// 意図しない要素に付いて機能が無言で壊れる（例: vmg-toggle の重複）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

test('index.html に重複した id が存在しない', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  assert.deepEqual([...dupes], [], `重複 id: ${[...dupes].join(', ')}`);
});

test('index.html に refl-date と import-date が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  assert.ok(/id="refl-date"/.test(html), 'refl-date が無い');
  assert.ok(/id="import-date"/.test(html), 'import-date が無い');
});

test('index.html に風速帯ノートのUI要素が存在する', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  for (const id of ['progress-kb-rebuild', 'progress-kb-status', 'progress-kb-view', 'kb-modal', 'kb-modal-body', 'kb-modal-download', 'kb-modal-close']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} が無い`);
  }
});

test('index.html にホームと組織管理への導線がある', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  for (const id of ['top-screen', 'top-recent', 'top-goal-text', 'top-goal-form', 'top-member-goals', 'top-guide', 'sb-home-logo', 'account-org']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} が無い`);
  }
  assert.ok(/data-nav="top"/.test(html), 'サイドバーのホームが無い');
  // 組織管理はログアウトの上
  assert.ok(html.indexOf('id="account-org"') < html.indexOf('id="account-logout"'), '組織管理がログアウトより下にある');
  assert.ok(/id="account-org"[^>]*href="\/account#org"/.test(html), '組織管理のリンク先が違う');
});

test('index.html に動画フォルダ(自動取込)のボタンが、同期フォルダ取込の隣にある', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  assert.ok(/id="video-root"/.test(html), 'video-root が無い');
  const folder = html.indexOf('id="folder-import"');
  const root = html.indexOf('id="video-root"');
  assert.ok(folder >= 0 && root > folder && html.indexOf('id="project-save"') > root, 'folder-import と project-save の間に無い');
});

test('index.html に動画のコメント欄があり、オーバーレイは動画のステージの中・欄はステージの後ろ', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  const stage = html.match(/<div id="video-stage">([\s\S]*?)<\/div>\s*<section id="video-comments"/);
  assert.ok(stage, 'video-stage の直後に video-comments が無い');
  assert.ok(/id="video-el"/.test(stage[1]) && /id="video-comment-overlay"/.test(stage[1]), 'video-stage の中に video-el と overlay が無い');
  assert.ok(html.indexOf('id="video-comments"') < html.indexOf('</aside>', html.indexOf('id="video-panel"')), 'video-panel の中に無い');
});

test('index.html にプロ動画の画面とサイドバーの入口があり、コメント欄の部品がそろっている', () => {
  const html = readFileSync(join(__dir, '..', 'index.html'), 'utf8');
  assert.ok(/class="sb-item" data-nav="study"/.test(html), 'サイドバーに study が無い');
  for (const id of ['study-screen', 'study-bar', 'study-root', 'study-root-label', 'study-status', 'study-comment-note', 'study-list',
    'study-player', 'study-video-name', 'study-stage', 'study-video', 'study-comment-overlay', 'study-player-empty', 'study-comments']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} が1つでない`);
  }
  const stage = html.match(/<div id="study-stage">([\s\S]*?)<\/div>/);
  assert.ok(stage && /id="study-video"/.test(stage[1]) && /id="study-comment-overlay"/.test(stage[1]), 'study-stage の中に動画とオーバーレイが無い');
});
