// world(x東正,y北正) -> screen(px右,py下)。北を上に見せるため y を反転。
export function worldToScreen(p, T) {
  return {
    px: T.w / 2 + (p.x - T.cx) * T.scale,
    py: T.h / 2 - (p.y - T.cy) * T.scale,
  };
}

export function screenToWorld(s, T) {
  return {
    x: T.cx + (s.px - T.w / 2) / T.scale,
    y: T.cy - (s.py - T.h / 2) / T.scale,
  };
}

// 画面ドラッグ(dpx,dpy)ぶん内容を動かす = 中心を逆向きに移動。
export function pan(T, dpx, dpy) {
  return { ...T, cx: T.cx - dpx / T.scale, cy: T.cy + dpy / T.scale };
}

// カーソル(px,py)の world点を固定したままズーム。
export function zoomAt(T, px, py, factor) {
  const before = screenToWorld({ px, py }, T);
  const scaled = { ...T, scale: T.scale * factor };
  const after = screenToWorld({ px, py }, scaled);
  return { ...scaled, cx: scaled.cx + (before.x - after.x), cy: scaled.cy + (before.y - after.y) };
}
