# プロジェクト保存／読込 設計

作成日: 2026-08-17
対象: SailViz（クライアント側GPS軌跡ビューア）

## 目的

作業の途中経過（GPS軌跡・タグ・マーク・ピン・動画メタ・反省）を1つのファイルに
手動で保存し、後で読み込んで作業を再開できるようにする。自分用の再開が主目的で、
動画実体はファイルに含めず、読込時にフォルダを再選択して再リンクする。

## 非目標（YAGNI）

- 自動保存（IndexedDB等）は行わない。手動の保存／読込のみ。
- 動画バイナリの埋め込みは行わない（参照のみ）。
- 共有相手向けの自己完結HTML書き出しは行わない。
- メンバー名簿はコード内の静的データ（`members.js`）なのでファイルに含めない。

## 保存ファイル形式

拡張子 `.sailviz.json`。単一のJSONオブジェクト。

```jsonc
{
  "version": 1,
  "savedAt": "2026-08-17T09:30:00.000Z",  // 保存時刻(ISO)。表示・デバッグ用
  "mode": "absolute",                      // "absolute" | "elapsed"
  "accuracyFilter": true,
  "crop": { "start": 0, "end": 0 },
  "tracks": [ /* GPS点を含む全トラック(下記) */ ],
  "events": [ /* タグ(parseTags出力) */ ],
  "marks":  [ /* { id, lat, lon, shape, color } */ ],
  "pins":   [ /* 絶対msの配列 */ ],
  "videos": [ /* { id, t, name, durationMs } — url(blob)は含めない */ ],
  "reflections": [ /* reflections.js の反省ノート配列 */ ]
}
```

### 直列化で除外するもの
- `state.transform`: 投影関数 `proj` を含み直列化不能。読込後に `recomputeView()` で再計算。
- `video.url`: `URL.createObjectURL` の一時blob URL。セッションを跨いで失効するため保存しない。

### tracks の要素
既存の `addTrack` が積む形をそのまま保存する:
`{ id, name, color, visible, points:[{t,lat,lon,...}], bounds, tRange:{start,end} }`。
`points` は数値のみでJSON安全。読込時はそのまま復元し、`recomputeView()` で
`bounds`/`crop`/表示変換を再計算する（保存値は参考。tracksから再算出可能）。

## モジュール構成

### 新規 `src/project.js`（純ロジック・DOM非依存）
- `serializeProject(state, { savedAt })` → 保存用プレーンオブジェクト。
  - `transform` を除外。`videos` は `{id,t,name,durationMs}` へ写像（`url`除去）。
  - `version`/`savedAt` を付与。
- `deserializeProject(obj)` → `{ mode, accuracyFilter, crop, tracks, events, marks, pins, videos, reflections }`。
  - `obj.version !== 1` は `Error` を投げる。
  - 各配列は欠損時 `[]`、スカラは既定値でフォールバック。
  - `videos` は `url` を持たない状態で返す（未リンク）。

### 追加 `src/folderimport.js`
- `collectVideoFiles(dirHandle, nameSet)` → `Map<string, File>`。
  - ディレクトリ直下の動画ファイルのうち、名前が `nameSet` に含まれるものを収集。
  - blob URL生成はしない（DOM副作用を持たせない）。呼び出し側で `createObjectURL`。

### `src/app.js`（結線とUI）
- 保存ボタン `#project-save`（💾 保存）: topbarの「動画フォルダ取込」の隣に配置。
  - クリック時 `serializeProject(state,{savedAt:new Date().toISOString()})` → `JSON.stringify`
    → `Blob(['application/json'])` → 一時アンカーで `sailviz-YYYYMMDD-HHMM.sailviz.json` をダウンロード。
- 開くボタン `#project-open`（📂 開く = `<input type=file accept=".json">`）:
  - `file.text()` → `JSON.parse` → `deserializeProject`。
  - 現在トラックがあれば「上書きしますか？」の `confirm`。
  - state配列を置換、`state.reflections` を `saveReflections` でlocalStorageへ書き戻し。
  - `recomputeView()` / `renderSidebar()` / `draw()`。動画は未リンク表示。
- 動画再リンク: 既存「📁 動画フォルダ取込」を流用。読込後にフォルダを選ぶと
  `collectVideoFiles(dir, new Set(state.videos.map(v=>v.name)))` で照合し、
  一致ファイルに `v.url = URL.createObjectURL(file)` を設定。未一致は status に本数表示。

## エラー処理

- `JSON.parse` 失敗 / `version` 不一致 → `statusEl` にメッセージ表示し、**stateは変更しない**。
- 再リンクでフォルダ選択キャンセル → 何もしない（既存挙動に合わせる）。
- 一部動画が見つからない → 見つかった本数／見つからない本数を status に表示。

## テスト

- `test/project.test.js`
  - serialize→deserialize ラウンドトリップで tracks/events/marks/pins/videos(メタ)/reflections/
    mode/accuracyFilter/crop が保存されること。
  - `transform` と `video.url` が保存結果に含まれないこと。
  - `version` 不一致で `deserializeProject` が throw すること。
- `test/folderimport.test.js`（追記）
  - `collectVideoFiles` が注入ディレクトリハンドルから名前一致ファイルのみ返すこと。
- `test/dom-smoke.test.js`（追記）
  - 保存で Blob/アンカーが生成されること、読込で state と sidebar が更新されること。

## 実装順序（概略）

1. `src/project.js` + `test/project.test.js`（TDD）
2. `src/folderimport.js` に `collectVideoFiles` + テスト
3. `index.html` にボタン追加、`app.js` に保存／開く／再リンク結線
4. dom-smoke 追記、手動確認（保存→リロード→開く→フォルダ再リンク→動画再生）
