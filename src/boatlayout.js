// 各 rig パラメータを 470 側面図(sample-data/470.jpg, 横向き)の
// 「そのデータが指し示す位置」に紐付けるアンカー表。座標は画像左上=0,0/右下=1,1。
// side は吹き出しグラフを画像のどちら側に置くか。座標は目視調整可能。
export const BOAT_IMAGE = 'sample-data/470.jpg';

export const ANCHORS = {
  rake:         { x: 0.66, y: 0.10, side: 'right' }, // マスト上部
  bridleHeight: { x: 0.66, y: 0.22, side: 'right' }, // ハウンズ付近
  gear:         { x: 0.46, y: 0.30, side: 'left'  }, // メインセイル中程
  foreTension:  { x: 0.40, y: 0.28, side: 'left'  }, // フォアステイ
  prebend:      { x: 0.64, y: 0.38, side: 'right' }, // マスト中央の曲がり
  jibPull:      { x: 0.40, y: 0.50, side: 'left'  }, // ジブ後縁
  sideTension:  { x: 0.58, y: 0.55, side: 'right' }, // シュラウド/チェーンプレート
  jibLeader:    { x: 0.44, y: 0.58, side: 'left'  }, // ジブクリュー下
  peakRope:     { x: 0.48, y: 0.70, side: 'left'  }, // ブーム端付近
  vangPull:     { x: 0.60, y: 0.72, side: 'right' }, // バング
  puller:       { x: 0.52, y: 0.80, side: 'left'  }, // デッキ/プラー
};

export function anchorFor(param) {
  return ANCHORS[param] ?? null;
}
