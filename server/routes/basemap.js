// server/routes/basemap.js
// 地理院タイル(淡色)の同一オリジンプロキシ。クロスオリジンでの canvas 汚染を避け、
// 合成画像を toDataURL 可能にする。公開地図の読み取りのみなので認証不要。
// 処理したら true、パス/メソッド不一致なら false(次のルートへ)。

export async function basemapRoute(req, res, ctx) {
  const tileMatch = ctx.path.match(/^\/api\/basemap\/pale\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
  if (!(tileMatch && ctx.method === 'GET')) return false;
  const z = Number(tileMatch[1]), x = Number(tileMatch[2]), y = Number(tileMatch[3]);
  const n = 2 ** z;
  if (z < 0 || z > 18 || x < 0 || y < 0 || x >= n || y >= n) {
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad tile'); return true;
  }
  try {
    const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`, {
      headers: { 'user-agent': 'sailviz' },
    });
    if (!r.ok) { res.writeHead(r.status === 404 ? 404 : 502, { 'content-type': 'text/plain' }); res.end('tile unavailable'); return true; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' }); res.end('tile fetch error');
  }
  return true;
}
