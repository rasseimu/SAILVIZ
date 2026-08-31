// src/windstripview.js
// 練習画面のタイムライン上に置く「風軸ストリップ」。可視トラックごとの推定風向(0-360°)を
// 時間軸に沿った折れ線で描く。timeline.js と同じ tToX 写像で x を合わせ、下のバーと縦に揃える。

const PAD_Y = 3; // 上下の余白(px)。0°/360°が枠に貼り付かないように。

export function createWindStrip(canvas) {
  const ctx = canvas.getContext('2d');

  // 度(0-360) → ストリップy。0°を下、360°を上に。上下に PAD_Y の余白。
  const degToY = (deg, h) => {
    const usable = h - PAD_Y * 2;
    return h - PAD_Y - (deg / 360) * usable;
  };

  // series: [{ series:[{tMs,windFromDeg}], color }]（tMs は既に軸時刻へ変換済み）
  function render({ range, series = [], now }) {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!(range.end > range.start)) return;

    const tToX = (t) => ((t - range.start) / (range.end - range.start)) * w;

    // 目盛り: 0°(下)・180°(中)・360°(上) の薄い横線と N/S ラベル
    ctx.strokeStyle = '#e0e6eb';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#9aa7b2';
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'middle';
    for (const [deg, label] of [[0, 'N'], [180, 'S'], [360, '']]) {
      const y = Math.round(degToY(deg, h)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (label) ctx.fillText(label, 2, degToY(deg, h) - 6);
    }

    // トラックごとに風向折れ線。360°⇔0°のラップは |Δ|>180° で線を切って縦断を防ぐ。
    for (const { series: pts, color } of series) {
      if (!pts || pts.length < 2) continue;
      ctx.strokeStyle = color || '#1c72b8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false, prevDeg = null;
      for (const p of pts) {
        const x = tToX(p.tMs), y = degToY(p.windFromDeg, h);
        if (!started || (prevDeg != null && Math.abs(p.windFromDeg - prevDeg) > 180)) {
          ctx.moveTo(x, y); started = true;
        } else {
          ctx.lineTo(x, y);
        }
        prevDeg = p.windFromDeg;
      }
      ctx.stroke();
    }

    // 現在時刻のプレイヘッド(timeline と同色の橙・細線)
    if (now != null) {
      const xN = tToX(now);
      ctx.strokeStyle = '#e67e22';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xN, 0); ctx.lineTo(xN, h); ctx.stroke();
    }
  }

  return { render };
}
