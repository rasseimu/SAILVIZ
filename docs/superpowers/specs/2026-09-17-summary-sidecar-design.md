# 項目44 段階1: サマリ・サイドカーで一覧を points 非依存にする

- 日付: 2026-09-17
- 対象ロードマップ項目: `docs/roadmap.md` 44「メタデータと GPS 実データの分離」
- スコープ: **段階1のみ**（軽量要約サイドカー）。段階2（points 本体の分離）と項目45（SoA化）は対象外。

## 背景と動機

ホーム/ダッシュボードの一覧は `GET /api/summaries` を叩く。現状の実装は
全プロジェクトを `readProject`（本体ファイルを丸ごと `JSON.parse`）してから
`practiceSummary` を計算している。本体ファイルには GPS 全点が埋め込まれており、
実データでは 1 ファイル約 11MB。プロジェクトが増えるほど一覧が線形に重くなる。

一方 `practiceSummary`（`src/summary.js`）は **points に一切触れない**純関数で、
必要なのは以下だけ:

- `reflections`（最初の wind と件数）
- `practiceDate`
- `tracks[].tRange.start` と `tracks.length`
- `videos[].t` と `videos.length`
- `events.length`

つまりボトルネックは要約計算ではなく、要約に不要な全 points を含む本体の
`JSON.parse`。これを避けるため、要約結果を軽量サイドカーに永続化し、一覧は
サイドカーだけを読む。

## 決定事項（ブレインストーミングでの合意）

1. **スコープ**: 段階1のみ。points 本体の分離は将来（YAGNI）。
2. **保存先**: サイドカー `*.summary.json`。本体先頭への埋め込みは
   `JSON.parse` が結局全体を読むため効果が薄く却下。
3. **配置**: `data/projects/summaries/` サブディレクトリに置く（本体と分離して
   `projects/` を汚さない）。
4. **既存プロジェクトの移行**: 遅延生成。手動移行スクリプトは作らない。

## アーキテクチャ

### ファイルレイアウト

```
data/projects/
  foo.sailviz.json            # 本体（GPS 全点を含む、従来どおり）
  summaries/
    foo.summary.json          # 軽量要約サイドカー（practiceSummary の結果）
```

`foo.sailviz.json` に対するサイドカー名は `foo.summary.json`
（`\.sailviz\.json$` を `.summary.json` に置換）。本体名は
`isValidProjectName` 済みなのでトラバーサル不可。

### データフロー

- **書込み（PUT / sensor commit / minutes commit / import）**: 全て
  `storage.writeProject` を経由する。本体を書いた後、同じ obj から
  `practiceSummary(obj, {name})` を計算してサイドカーを書く。
  → サイドカーは常に本体と同期。
- **削除**: `storage.deleteProject` が本体とサイドカーの両方を削除する。
- **一覧（GET /api/summaries）**: `listProjects` で本体名を列挙し、各名について
  サイドカーを読む。無ければ（既存プロジェクト）本体を一度だけ読んで要約を
  計算し、サイドカーを書き戻す（遅延バックフィル）。以後は軽量読取りのみ。

## コンポーネント詳細

### `server/storage.js`

新規/変更:

- `summaryName(name)`（内部ヘルパ）: `name.replace(/\.sailviz\.json$/, '.summary.json')`。
  入力は検証済み本体名前提。
- `summariesDir(dataDir)`（内部）: `join(projectsDir(dataDir), 'summaries')`。
- `writeSummary(dataDir, name, summaryObj)`: `summaries/` を ensureDir して
  `summaryName(name)` に JSON 書込み。
- `readSummary(dataDir, name)`: サイドカーを読み JSON.parse。ファイル欠損や
  破損時は `null` を返す（例外を投げない）。
- `writeProject(dataDir, name, obj)`: 本体書込み後に
  `practiceSummary(obj, { name })` を計算して `writeSummary`。
  **要約計算・サイドカー書込みが失敗しても本体書込みは成功扱い**（try/catch で
  握りつぶす。遅延生成が保険）。`practiceSummary` を `../src/summary.js` から import。
- `deleteProject(dataDir, name)`: 本体 unlink 後、サイドカーも unlink（ENOENT 無視）。

`listProjects` は変更不要。`summaries/` はディレクトリであり、また
`*.summary.json` は `PROJECT_RE`（`.sailviz.json` 必須）に一致しないため
一覧に混入しない。

### `server/api.js` — `/api/summaries`

現状:
```js
for (const { name } of list) {
  try { rows.push({ name, ...practiceSummary(await readProject(dataDir, name), { name }) }); }
  catch { /* 壊れたファイルは飛ばす */ }
}
```

変更後:
```js
for (const { name } of list) {
  try {
    let s = await readSummary(dataDir, name);            // 無ければ null
    if (!s) {                                            // 遅延バックフィル
      s = practiceSummary(await readProject(dataDir, name), { name });
      await writeSummary(dataDir, name, s);
    }
    rows.push({ name, ...s });
  } catch { /* 壊れたファイルは飛ばす */ }
}
```

`readSummary`/`writeSummary` を storage から import に追加。レスポンス形状
`{ name, ...summary }` は不変。

## エラー処理

- サイドカー欠損/JSON 破損 → `readSummary` が `null` → 本体から再生成。
- 本体破損 → try/catch で従来どおり skip。
- GET でのバックフィル書込みは派生キャッシュの実体化。副作用ではあるが
  内容は決定的で、並行アクセスでも同一内容の last-writer-wins のため安全。

## テスト（TDD）

`test/server-storage.test.js`:
- `writeProject` がサイドカー `summaries/*.summary.json` を生成し、その内容が
  `practiceSummary(obj, {name})` と一致する。
- `readSummary` はサイドカー欠損時 `null` を返す。
- `deleteProject` が本体とサイドカーの両方を削除する。
- 要約計算が失敗しても（例: 異常な obj）本体書込みは成功する。

`test/server-api.test.js`:
- サイドカー有りで `GET /api/summaries` が期待どおりの行を返す。
- サイドカー無しのプロジェクトに対する `GET /api/summaries` 後、サイドカーが
  生成されている（遅延バックフィル）。

## 非対象（将来）

- 段階2: points 本体を別ファイル/別エンドポイント
  `/api/projects/:name/tracks/:id` に分離。
- 項目45: GPS 点の列指向（SoA）化。
- 項目47: 整数量子化バイナリ。

## 影響ファイル

- `server/storage.js`（サイドカー CRUD + write/delete フック）
- `server/api.js`（`/api/summaries` の遅延バックフィル）
- `test/server-storage.test.js` / `test/server-api.test.js`（テスト追加）
- `src/summary.js` は変更なし（既に points 非依存）。
