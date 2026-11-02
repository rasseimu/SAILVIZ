// 名簿・登録画面の案内文が画面コードに残っていることの確認(DOM を使わない文字列の存在確認)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/account/main.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('登録画面: 名簿の案内と同意文がある', () => {
  assert.match(main, /id: 'ac-reg-roster-note'/);
  assert.match(main, /部の名簿に載っているアドレスで登録してください/);
  assert.match(main, /'・位置情報と録音の用途に同意します'/);
});

test('登録画面: 同意文から利用規約とプライバシーポリシーを別タブで開ける', () => {
  assert.match(main, /h\('a', \{ id: 'ac-reg-terms-link', href: '\/terms\.html', target: '_blank', rel: 'noopener' \}, '利用規約'\)/);
  assert.match(main, /h\('a', \{ id: 'ac-reg-privacy-link', href: '\/privacy\.html', target: '_blank', rel: 'noopener' \}, 'プライバシーポリシー'\)/);
});

test('規約とプライバシーポリシーのページが互いにリンクしている', () => {
  const terms = readFileSync(new URL('../terms.html', import.meta.url), 'utf8');
  const privacy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  assert.match(terms, /<title>SailViz 利用規約<\/title>/);
  assert.match(terms, /href="\/privacy\.html"/);
  assert.match(privacy, /href="\/terms\.html"/);
});

test('名簿画面: ヘッダは「氏名,メール」の形という案内がある', () => {
  assert.match(main, /id: 'ac-roster-header-note'/);
  assert.match(main, /「氏名,メール」の形/);
});

test('ランディング: ログインはメールアドレスのアカウントと旧共有ログインの両方で使えるという補足がある', () => {
  assert.match(index, /id="landing-login"[^>]*title="メールアドレス\(または部内共有アカウント\)でログイン"/);
});
