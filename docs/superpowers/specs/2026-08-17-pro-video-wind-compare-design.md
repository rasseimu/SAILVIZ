# 同じ風のプロ動画との並列比較 — 設計

## 目的

現在見ている練習動画を、**同じ風条件のプロ動画**と画面に並べて見比べられるようにする。
同期フォルダ `練習動画/プロ動画/` の中からプロ動画を風でマッチングして提案し、
選ぶと GPS・練習動画・プロ動画の 3 分割で並べて再生する。

## 非目標(YAGNI)

- 2 動画の同期再生(頭出し合わせ)。**個別操作**とする。
- プロ動画への手動風タグ付け UI。風はファイル名から読む。
- プロ動画のプロジェクト保存への永続化。比較は**セッション限定の一時状態**。
- Google Drive API / OAuth 連携。既存方針どおりローカル同期フォルダを
  File System Access API で読む(既存方針: Drive for Desktop のローカル同期フォルダ）。

## 風の命名規約(ファイル名)

プロ動画は専用フォルダ `プロ動画/`(同期フォルダ内)に置く。風はファイル名に埋め込む。
実フォーマット例:

```
2026-08-16_風速3.2ms_風向NE47度_Day 5 2026 470 World Championship, Enoshima JPN.mp4
```

パーサが拾うトークン:

- 風速: `風速([\d.]+)\s*m` → `3.2`(m/s)
- 風向: `風向([A-Z]{1,3})?\s*([\d.]+)\s*度` → `47`(度を採用)
  - 度が無い場合のフォールバックとして英字方位(N/NE/ENE…)を度に変換
- 日付 `YYYY-MM-DD` は表示用に任意で拾う(マッチングには未使用)

風速・風向のどちらかが読めなければ、その動画は候補から**除外**(除外数を UI に表示)。

## モジュール構成

### `src/windspec.js`(純粋・DOM 非依存・テスト対象)

```
parseWindSpec(name) -> { deg, speed, dateStr? } | null
  // ファイル名から風速(m/s)と風向(度 0..360)を抽出。読めなければ null。

COMPASS_DEG = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ... }  // 英字→度フォールバック

windScore(target, cand) -> number   // 小さいほど近い
  // 方位の円周角度差(0..180) を正規化 + 風速差(m/s) を重み付き合成。

rankProVideos(list, target, { maxDegDiff, maxSpeedDiff }) -> [{...item, score}]
  // 閾値でフィルタし score 昇順にソート。target は { deg, speed }。
```

- `target.deg` は AMeDAS の `dirIdx`(1..16, 22.5°刻み, 16=北=0°)から
  `(dirIdx % 16) * 22.5` で度に変換して渡す。
- 既定閾値(調整可): `maxDegDiff = 45`(±2セクタ相当), `maxSpeedDiff = 2` m/s。
- スコア合成の既定: `score = degDiff/45 + speedDiff/2`(方位と風速を同程度に重視)。

### `src/proscan.js`

```
scanProVideos(dirHandle, parse = parseWindSpec) -> [{ file, name, path, wind }]
  // dirHandle 直下 + サブフォルダを再帰走査し、動画ファイルごとに
  // wind = parse(name) を付けて返す(wind=null も含めて返し、除外は呼び出し側)。
```

- `folderimport.js` の `VIDEO_RE` / 走査流儀を踏襲。fake handle でテスト。
- 風はファイル名から読むため走査は基本フラットだが、サブフォルダ再帰も残す。

### `src/dirhandle.js`(既存を拡張)

- `saveDirHandle` / `loadDirHandle` / `ensurePermission` に **key 引数**を追加
  (既定 `'projectDir'` で後方互換)。プロフォルダは `'proDir'` で永続化。

## 比較元(現在の練習動画)の風

`currentVideo` の時刻を使い、既存の `fetchWind`(AMeDAS 辻堂)で取得。
失敗時は `fetchWindFromCsv`(辻堂 CSV)にフォールバック(反省ノートと同じ経路)。

- 対象時刻: `currentVideo.t + (durationMs ?? 0) / 2`(録画中央)。
- 得られた `{ dirIdx, speed }` を `windspec` の `target { deg, speed }` に変換。
- 風が取得できない場合: 候補提示は不可。ステータスに「風を取得できませんでした」を表示し、
  比較フローを中断(v1 では手入力フォールバックは非対応=非目標)。

## UI フロー

1. 練習動画パネルを開いた状態で **「🆚 プロと比較」** ボタンを押す
   (`#video-bar` 内に配置)。
2. プロフォルダ未選択なら `showDirectoryPicker()` で `プロ動画/` を選択
   (`proDir` として永続化。次回以降は権限確認のみ)。
3. `scanProVideos` でプロ動画を走査、`fetchWind` で現在の風を取得。
4. `rankProVideos` で近い順に並べ、**候補リスト**を提示
   (各行: 風ラベル `NE47° / 3.2m` + 近さ、上位数件。空なら「該当なし」)。
5. 候補をクリックすると 2 つ目の動画として読み込み、3 分割表示に入る。

候補リストは動画パネル上の軽量なオーバーレイ/リストで表示(モーダルは使わない)。

## レイアウト(3 分割・左右並び)

比較中の `main` 構成:

```
[ sidebar | canvas(stage) | 練習video (#video-panel) | プロvideo (#pro-panel) ]
```

- `#pro-panel`: 新規パネル。`#video-panel` と同様の名前バー
  (プロ動画名 + 風ラベル + 閉じるボタン)+ `<video id="pro-video-el" controls>`。
- 幅配分: canvas は `flex:1`、練習・プロ各パネルは `flex: 0 0 ~33%`(3 分割の見た目)。
  比較していない通常時は従来どおり(canvas + 練習動画の 2 分割、または動画なし)。
- canvas の GPS マスター同期は**練習動画側のみ**維持(`#video-el`)。
  プロ動画は独立した native controls で**個別操作**。

## 開閉・状態

- プロパネルの × / Esc でプロ動画のみ閉じ、練習動画+canvas の 2 分割に戻る。
- 練習動画パネルを閉じると比較も終了(プロパネルも閉じ、blob URL を revoke)。
- プロ動画の blob URL は `createObjectURL` で生成し、閉じる/差し替え時に必ず revoke。
- `state`(プロジェクト保存対象)には比較状態を持たせない。モジュール内のセッション変数で管理。

## エッジケース

- プロフォルダの権限が失効: `ensurePermission` が false → 再選択を促す。
- ファイル名に風が無い動画: 候補から除外。除外数をステータスに表示。
- 現在の風が取得不可: 比較中断+メッセージ(上述)。
- 候補 0 件(閾値内に無し): 「同じ風のプロ動画が見つかりません」を表示。

## テスト計画(TDD)

- `windspec.test`:
  - `parseWindSpec` — 実フォーマット、風速のみ/風向のみ、英字方位フォールバック、非マッチ。
  - `windScore` / `rankProVideos` — 円周角度差(例 350°↔10°=20°)、閾値フィルタ、ソート順。
- `proscan.test`:
  - fake `dirHandle`(`folderimport` テストのフェイクを踏襲)で再帰走査・wind 付与・非動画除外。
- `dirhandle` の key 引数は後方互換(既定 `projectDir`)を確認。

DOM/レイアウト・fetch 結線(app.js)は既存同様に手動確認。
