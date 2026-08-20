// world(x東正,y北正) -> screen(px右,py下)。北を上に見せるため y を反転。
// T.rot(ラジアン, 既定0)で中心まわりに回転。
export function worldToScreen(p, T) {
  const rot = T.rot || 0;
  const sx0 = (p.x - T.cx) * T.scale;
  const sy0 = -(p.y - T.cy) * T.scale; // 回転前の画面オフセット(北=上)
  const c = Math.cos(rot), s = Math.sin(rot);
  return {
    px: T.w / 2 + (sx0 * c - sy0 * s),
    py: T.h / 2 + (sx0 * s + sy0 * c),
  };
}

export function screenToWorld(scr, T) {
  const rot = T.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  const sx = scr.px - T.w / 2;
  const sy = scr.py - T.h / 2;
  const sx0 = sx * c + sy * s; // 逆回転して回転前オフセットへ
  const sy0 = -sx * s + sy * c;
  return {
    x: T.cx + sx0 / T.scale,
    y: T.cy - sy0 / T.scale,
  };
}

// 画面ドラッグ(dpx,dpy)ぶん内容を動かす = 中心を逆向きに移動(回転を考慮)。
export function pan(T, dpx, dpy) {
  const rot = T.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  // 画面デルタ→world デルタ(worldToScreenの線形部の逆)
  const dX = (dpx * c + dpy * s) / T.scale;
  const dY = (dpx * s - dpy * c) / T.scale;
  return { ...T, cx: T.cx - dX, cy: T.cy - dY };
}

// カーソル(px,py)の world点を固定したままズーム。
export function zoomAt(T, px, py, factor) {
  const before = screenToWorld({ px, py }, T);
  const scaled = { ...T, scale: T.scale * factor };
  const after = screenToWorld({ px, py }, scaled);
  return { ...scaled, cx: scaled.cx + (before.x - after.x), cy: scaled.cy + (before.y - after.y) };
}
