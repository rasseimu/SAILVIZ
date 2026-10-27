// 画面(view)とアドレスの対応。画面側(app.js)とサーバーの配信(server/static.js)で共用する純関数。
// view: top=ホーム, home=練習データ(カード一覧), track=練習を開いた画面, dashboard, progress, roadmap, study=プロ動画。
// 練習は ?id= で開く(下の階層にすると index.html の相対パスの読込が崩れるため、アドレスは1階層にそろえる)。
const VIEW_PATHS = {
  top: '/home',
  home: '/practices',
  track: '/practice',
  dashboard: '/dashboard',
  progress: '/progress',
  roadmap: '/roadmap',
  study: '/study',
};
const PATH_VIEWS = new Map(Object.entries(VIEW_PATHS).map(([view, path]) => [path, view]));

// サーバーが index.html を返すアドレス。
export const APP_PATHS = new Set(Object.values(VIEW_PATHS));

// 画面のアドレス。知らない画面は null。
export function pathFor(view, { id } = {}) {
  const path = VIEW_PATHS[view];
  if (!path) return null;
  return view === 'track' && id ? `${path}?id=${encodeURIComponent(id)}` : path;
}

// アドレス → { view, id }。/ や知らないアドレスは null(呼び出し側で既定の画面にする)。
export function routeFromLocation(pathname, search = '') {
  const view = PATH_VIEWS.get(pathname);
  if (!view) return null;
  const id = view === 'track' ? (new URLSearchParams(search).get('id') || null) : null;
  return { view, id };
}
