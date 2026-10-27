-- tracks の点列(points)を最後の列へ移す(列の並びだけ変える。中身・主キーは同じ)。
-- SQLite は行を列の順に並べて保存し、大きい値は続きのページ(overflow)に置く。点列(1行 最大数 MB)の後ろの列
-- (t_range・view など)を読むと、点列の続きのページを全部たどることになり、キャッシュが空のとき遅い
-- (本番で練習一覧・要約の初回が 1〜3 秒)。点列を最後にすれば、点列を読まない問い合わせは点列のページに触れない。
-- SQLite は列の順を ALTER で変えられないので表を作り直す。tracks を参照する外部キー・索引は無い(001〜007 を確認済み)。

CREATE TABLE tracks_new (
  session_id TEXT PRIMARY KEY,
  bounds TEXT,
  t_range TEXT,
  point_count INTEGER,
  csv_name TEXT,
  view TEXT,                     -- name, color, visible, windAxisOverrides, extra
  points TEXT                    -- 点列(大きい)。必ず最後の列に置く
);

INSERT INTO tracks_new (session_id, bounds, t_range, point_count, csv_name, view, points)
  SELECT session_id, bounds, t_range, point_count, csv_name, view, points FROM tracks;

DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;
