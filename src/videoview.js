// 動画パネルの90°回転(表示のみ)のための純関数。DOM/ブラウザAPI非依存。

// 現在の回転角(度)を90°進める。0→90→180→270→0 を循環。
export function nextRotation(r) {
  return (((r / 90) + 1) % 4) * 90;
}

// ステージ W×H に object-fit:contain で収めるための、回転前の動画ボックス寸法。
// 90/270 では縦横を入れ替え、rotate 後にステージへぴったり収まるようにする。
export function rotatedFitBox(r, W, H) {
  const swap = r === 90 || r === 270;
  return swap ? { w: H, h: W } : { w: W, h: H };
}
