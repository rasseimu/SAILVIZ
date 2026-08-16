# プロジェクト保存／読込 設計

作成日: 2026-08-17
対象: SailViz（クライアント側GPS軌跡ビューア）

## 目的

作業の途中経過（GPS軌跡・タグ・マーク・ピン・動画メタ・反省）を、選んだ
**保存フォルダ**にファイルとして手動保存し、「過去の練習」プルダウンから
任意のセーブデータを選んで作業を再開できるようにする。自分用の再開が主目的で、
動画実体はファイルに含めず、読込時にフォルダを再選択して再リンクする。

保存フォルダは Drive 同期フォルダ等を選べるため、結果的に別PCとも共有できる
（既存の動画フォルダ運用と揃える）。

## 非目標（YAGNI）

- 自動保存（操作の都度の保存）は行わない。手動保存のみ。
- 動画バイナリの埋め込みは行わない（参照のみ）。
- 共有相手向けの自己完結HTML書き出しは行わない。
- メンバー名簿はコード内の静的データ（`members.js`）なのでファイルに含めない。
- 練習ごとの名前/メモ入力は行わない（ファイル名のタイムスタンプで識別）。

## 保存場所

`showDirectoryPicker()` で選んだ **保存フォルダ** に `.sailviz.json` を書き出す。
選んだ `FileSystemDirectoryHandle` を **IndexedDB に永続化**し、次回起動時に
再取得する（セッション毎に一度、ブラウザの権限確認に応じる）。
保存フォルダと動画フォルダは独立（同じフォルダを選んでも可）。
File System Access API 前提のため Chrome/Edge 限定。

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

### 新規 `src/projectfs.js`（フォルダ入出力・注入可能な純ロジック）
`FileSystemDirectoryHandle`/`FileSystemFileHandle` を引数で受け取り、テスト時は
既存 `folderimport.test.js` と同様にフェイクハンドルを注入する。
- `listProjectFiles(dirHandle)` → `[{ name, savedAt }]`（`.sailviz.json` のみ、名前降順）。
  - `savedAt` はファイル名のタイムスタンプから導出（中身は読まない＝軽量）。
- `readProject(dirHandle, name)` → `JSON.parse` した保存オブジェクト。
- `writeProject(dirHandle, name, obj)` → `getFileHandle(name,{create:true})`→`createWritable()`→書込。
- ファイル名生成 `projectFileName(date)` → `sailviz-YYYYMMDD-HHMM.sailviz.json`。

### 新規 `src/dirhandle.js`（保存フォルダの永続化）
- `saveDirHandle(handle)` / `loadDirHandle()`：IndexedDB にハンドルを保存/復元。
- `ensurePermission(handle)`：`queryPermission`→必要なら `requestPermission`。
- IndexedDB/権限はブラウザAPI依存で単体テスト対象外（手動確認）。薄く保つ。

### 追加 `src/folderimport.js`
- `collectVideoFiles(dirHandle, nameSet)` → `Map<string, File>`。
  - ディレクトリ直下の動画ファイルのうち、名前が `nameSet` に含まれるものを収集。
  - blob URL生成はしない（DOM副作用を持たせない）。呼び出し側で `createObjectURL`。

### `src/app.js`（結線とUI）
- **保存** `#project-save`（💾 保存）: topbarの「動画フォルダ取込」の隣。
  - 保存フォルダ未選択なら `showDirectoryPicker()` で選び、`saveDirHandle` で永続化。
  - `writeProject(dir, projectFileName(new Date()), serializeProject(state,{savedAt}))`。
  - 保存後、`過去の練習` プルダウンを再列挙。status に保存ファイル名を表示。
- **過去の練習** `#practice-select`（`<select>`）: 保存ボタンの隣。
  - 起動時: `loadDirHandle()`→権限OKなら `listProjectFiles` で `<option>` を生成。
    先頭は「（練習を選択…）」。フォルダ未設定なら「▶ 保存フォルダを選択…」を表示。
  - 「保存フォルダを選択…」選択時: `showDirectoryPicker`→永続化→再列挙。
  - 練習ファイル選択時: 現在トラックがあれば `confirm`→`readProject`→`deserializeProject`。
    state配列を置換、`state.reflections` を `saveReflections` でlocalStorageへ書き戻し、
    `recomputeView()`/`renderSidebar()`/`draw()`。動画は未リンク表示。
- **動画再リンク**: 既存「📁 動画フォルダ取込」を流用。読込後にフォルダを選ぶと
  `collectVideoFiles(dir, new Set(state.videos.map(v=>v.name)))` で照合し、
  一致ファイルに `v.url = URL.createObjectURL(file)` を設定。未一致は status に本数表示。

## エラー処理

- `JSON.parse` 失敗 / `version` 不一致 → `statusEl` にメッセージ表示し、**stateは変更しない**。
  プルダウンは元の選択に戻す。
- フォルダ選択/権限拒否・キャンセル → 何もしない（既存挙動に合わせる）。
- 一部動画が見つからない → 見つかった本数／見つからない本数を status に表示。
- 非対応ブラウザ（`showDirectoryPicker` 無し）→ 保存/過去の練習ボタンで案内表示。

## テスト

- `test/project.test.js`
  - serialize→deserialize ラウンドトリップで tracks/events/marks/pins/videos(メタ)/reflections/
    mode/accuracyFilter/crop が保存されること。
  - `transform` と `video.url` が保存結果に含まれないこと。
  - `version` 不一致で `deserializeProject` が throw すること。
- `test/projectfs.test.js`
  - `listProjectFiles` が注入ハンドルから `.sailviz.json` のみを新しい順で返すこと。
  - `writeProject`→`readProject` のラウンドトリップ（フェイクハンドルで）。
  - `projectFileName` の書式。
- `test/folderimport.test.js`（追記）
  - `collectVideoFiles` が注入ディレクトリハンドルから名前一致ファイルのみ返すこと。
- `test/dom-smoke.test.js`（追記）
  - 過去の練習プルダウンが列挙結果で `<option>` を生成し、選択で state/sidebar が更新されること。

## 実装順序（概略）

1. `src/project.js` + `test/project.test.js`（TDD）
2. `src/projectfs.js` + `test/projectfs.test.js`（TDD）
3. `src/folderimport.js` に `collectVideoFiles` + テスト
4. `src/dirhandle.js`（永続化・薄い層）
5. `index.html` にボタン/プルダウン追加、`app.js` に保存／過去の練習／再リンク結線
6. dom-smoke 追記、手動確認（保存→リロード→過去の練習で選択→フォルダ再リンク→動画再生）
