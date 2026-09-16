# TracTrac アーキテクチャ解析 — SailViz 応用メモ

> 解析対象: `live.tractrac.com/viewer`(JAPAN GAMES AOMORI 成年男子470級R5)
> 手法: 実通信キャプチャ + Web Worker ソース + バイナリ読取メソッドの静的解析
> 目的: localStorage / バックエンド / GPS保存 / 圧縮 / 派生値計算 の設計を SailViz(SailLog)へ応用する

---

## 結論(先に要点)

TracTrac は **localStorage に GPS を一切置かず**、位置データは
**「WebSocket で配信されるパック済みバイナリ」→「Web Worker で展開・計算」** という構成。

- 設定(低頻度)と 位置データ(高頻度)を **別サーバ・別プロトコル**に分離
- GPS は **固定小数点の整数量子化(scaled integer)** でバイナリ圧縮
- hdg / 速度 / after(遅延再生)は **専用 Calculation.worker** で算出(UIスレッドと分離)

---

## 全体構成(実測)

| 要素 | 実体 | 役割 |
|---|---|---|
| Viewer本体 | `live.tractrac.com`(静的SPA / Leaflet地図) | UI・描画 |
| レース定義JSON | `em.liveserver1.tractrac.com/.../races/{id}.json`(42KB) | 設定・競技者・マーク・コースのみ。**GPS実データは無し** |
| GPS実データ | `ws://liveserver1.tractrac.com:8891〜8894`(4本に負荷分散) | 位置の高頻度配信。リプレイはHTTP fetchでも取得 |
| MultipleDataReader.worker | 72KB | 受信・バイナリ展開(**計算しない**) |
| Calculation.worker | 831KB | hdg / 速度 / after などの算出 |
| 地図タイル | `tile.tractrac.com` | 自前タイルサーバ |

`multipleDataservers:true` で位置配信を 4 本の WebSocket に分散している点に注目。

---

## ① localStorage とバックエンドの使い方

- 実測で **localStorage は空**。IndexedDB・CacheStorage・ServiceWorker も **未使用**。
- app.js は localStorage を参照するが(minified化でキー名は追跡不可)、用途は**表示設定・UI状態程度**と推定。

### 応用ポイント: チャネル分離
「低頻度の設定(HTTP・JSON)」と「高頻度の位置データ(WebSocket・バイナリ)」を
**別サーバ・別プロトコル**に分ける。

- SailViz も **メタデータAPI** と **時系列トラック配信** を分離すべき。
- **GPS本体は localStorage に置かない**(5MB上限・文字列限定・端末間同期不可)。
- localStorage は **単位設定・テール長などの個人設定だけ**に使う。

---

## ② GPSトラッキングの保存場所

- クライアントには **永続保存しない**(localStorage / IDB に置かない)。
- サーバ側の**データサーバから配信**:
  - ライブ = WebSocket push
  - 終了レースのリプレイ = HTTP fetch(reader worker に `fetch` と `XMLHttpRequest` の両方あり)
- ブラウザ内では **Worker のメモリ(ArrayBuffer / TypedArray)に一時保持**して描画するのみ。

---

## ③ データ圧縮の方法(最重要)

reader worker のバイナリ読取メソッド集計:

| メソッド | 出現数 |
|---|---|
| `getInt32` | 42 |
| `getInt16` | 11 |
| `getFloat32 / getFloat64` | **0** |

→ 緯度経度を float64 のまま送らず、**固定小数点の整数量子化(scaled integer)でパック**している。

### 典型的な実装
- 緯度経度を `×1e6〜1e7` して **Int32**(mm〜cm 精度)
- 速度・方位を **Int16**(スケール済み)
- 1点あたり float×3(24B)→ int で **10〜12B 程度に半減**
- gzip / protobuf / msgpack の痕跡は無し → **独自の固定長バイナリレコード**を WebSocket フレームで送信(テキストJSONではない)

### SailViz 応用の順序
1. 緯度経度の**整数量子化**(基準点からの delta + scale)
2. **固定長バイナリ or 列指向配列**で保持
3. 表示用は **Douglas-Peucker で間引き**

---

## ④ hdg / kts / after の計算場所

すべて **`Calculation.worker` 側**(60fps描画を止めないため UI スレッドから分離)。
reader worker は `atan2` がゼロ = **受信・展開のみで計算しない**、という役割分担が明確。

| 派生値 | 実装(確認 / 推定) |
|---|---|
| **hdg(方位)** | `Math.atan2`×11 + 度⇔ラジアン換算(`PI/180`)×41。連続2点の緯度経度差から atan2 で進行方位(bearing / COG)を算出【確認】 |
| **after(遅延再生)** | worker内に `after`/`delay`/`tail`/`interpolate`。JSON に `delayIntervals:"3,12,15"`。指定秒数ぶん過去の位置を、GPS点間を**線形補間**して表示【確認】 |
| **kts(速度)** | 距離÷時間で m/s を算出(worker内に `3.6`=m/s→km/h の痕跡)。knots(×1.94384)換算と表示は、JSON の `DefaultSpeedUnits:"Knots"` から見て **UI層側の可能性が高い**【推定】 |

---

## 確度の注記

- **確認済み**: 全体構成 / バイナリ整数量子化 / atan2 による方位計算 / after の補間表示(ソース・バイナリ読取から確認)
- **未確定(推定)**: 緯度経度の正確なスケール係数、knots換算の正確な実装場所(worker or UI)— minified化のため
- 確定したい場合は、実際の WebSocket フレームを1本キャプチャしてバイト構造を解析可能

---

## SailViz への落とし込み(チェックリスト)

- [ ] 設定/メタデータ API と GPSトラック配信を分離する
- [ ] GPS は緯度経度を Int32 量子化 + 速度/方位を Int16 でバイナリ化
- [ ] localStorage は個人設定のみ(GPS本体は入れない)
- [ ] hdg / 速度 / after の計算は Web Worker に隔離してUIスレッドを空ける
- [ ] リプレイは点間の線形補間で滑らかに描画
- [ ] 表示負荷対策に Douglas-Peucker 間引きを用意
