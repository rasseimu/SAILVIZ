// UI アイコン(Feather Icons)。src/vendor/feather/sprite.svg の <symbol> を <use> で参照する。
// DOM には触れない。HTML 文字列を返すので innerHTML 側で使う(埋め込みの切り替えだけ状態を持つ)。

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

// スプライトをページに埋め込んだ後(app.js が起動時に1度だけ読む)は、ページ内の参照にする。
// ファイルの参照のままだと、アイコンを含む再描画のたびにスプライトを取りに行き(配信は no-store)、
// 休止中のサーバーを起こして表示が約1秒遅れる。id はページの要素(id="map" など)と衝突しないよう接頭辞を付ける。
const INLINE_PREFIX = 'ic-';
let inline = false;
export function setInlineSprite(on) { inline = !!on; }
export const iconHref = (name) => (inline ? `#${INLINE_PREFIX}${name}` : `${SPRITE_URL}#${name}`);

// スプライト(SVG の文字列)を、ページに埋め込む形にする(symbol の id に接頭辞・見えない svg)。
export function inlineSpriteMarkup(svgText) {
  return String(svgText)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<symbol id="/g, `<symbol id="${INLINE_PREFIX}`)
    .replace(/^\s*<svg\b/, '<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden"')
    .trim();
}

// 装飾アイコン(aria-hidden)。意味はボタンの文字・title・aria-label 側で伝える。
export function icon(name) {
  if (!ICON_NAMES.has(name)) throw new Error(`unknown icon: ${name}`);
  return `<svg class="ic" aria-hidden="true" focusable="false"><use href="${iconHref(name)}"></use></svg>`;
}
