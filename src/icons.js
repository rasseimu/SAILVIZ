// UI アイコン(Feather Icons)。src/vendor/feather/sprite.svg の <symbol> を <use> で参照する。
// 純関数。DOM には触れない。HTML 文字列を返すので innerHTML 側で使う。

export const SPRITE_URL = '/src/vendor/feather/sprite.svg';

// スプライトに収録済みの名前。未収録の名前は空の四角になるので、ここで弾く。
export const ICON_NAMES = new Set([
  'home', 'folder', 'tool', 'trending-up', 'log-out', 'tag', 'mic', 'film', 'check',
  'mail', 'plus', 'cpu', 'wind', 'arrow-left', 'arrow-right', 'save', 'bar-chart-2', 'clipboard',
  'award', 'chevron-left', 'chevron-right', 'trash-2', 'compass', 'edit-2', 'map-pin', 'play',
  'pause', 'navigation', 'map', 'edit-3', 'alert-triangle', 'loader', 'check-circle', 'target',
  'message-square', 'square', 'check-square', 'flag', 'arrow-up', 'arrow-down',
  'building-2', // Lucide 由来(Feather に建物が無い)
]);

// 装飾アイコン(aria-hidden)。意味はボタンの文字・title・aria-label 側で伝える。
export function icon(name) {
  if (!ICON_NAMES.has(name)) throw new Error(`unknown icon: ${name}`);
  return `<svg class="ic" aria-hidden="true" focusable="false"><use href="${SPRITE_URL}#${name}"></use></svg>`;
}
