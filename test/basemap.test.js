import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lonLatToTile, tileToLonLat, pickZoom, tileRangeForBounds, planBasemap, stitchBasemap,
  pickSeaColor, DEFAULT_SEA_COLOR,
} from '../src/basemap.js';

// RGBA(Uint8ClampedArray)を色リスト(各[r,g,b]をcount回)から組む。
function rgbaFrom(spec) {
  const px = [];
  for (const { rgb, count } of spec) for (let i = 0; i < count; i += 1) px.push(rgb);
  const data = new Uint8ClampedArray(px.length * 4);
  px.forEach(([r, g, b], i) => { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; });
  return data;
}

test('lonLatToTile: 東京(z=10)の既知タイル', () => {
  assert.deepEqual(lonLatToTile(35.68, 139.76, 10), { x: 909, y: 403 });
});

test('lonLatToTile: z=0 は常に{0,0}', () => {
  assert.deepEqual(lonLatToTile(35, 139, 0), { x: 0, y: 0 });
  assert.deepEqual(lonLatToTile(-40, -70, 0), { x: 0, y: 0 });
});

test('tileToLonLat: タイルNW隅→lonLatToTile で同じタイルに戻る(往復)', () => {
  const z = 14;
  for (const [x, y] of [[14552, 6451], [909, 403], [0, 0]]) {
    const nw = tileToLonLat(x, y, z);
    // NW隅から少しだけ内側の点は同じタイルに属す
    const inside = lonLatToTile(nw.lat - 1e-4, nw.lon + 1e-4, z);
    assert.deepEqual(inside, { x, y });
  }
});

test('tileToLonLat: 緯度は北ほど大(NW隅は南隣タイルより高緯度)', () => {
  const a = tileToLonLat(100, 200, 12);
  const b = tileToLonLat(100, 201, 12); // 1つ南(yが大)
  assert.ok(a.lat > b.lat);
  assert.equal(a.lon, b.lon);
});

// おおよそ1km四方の練習エリア(千葉近海想定)
const AREA = { minLat: 35.300, maxLat: 35.310, minLon: 139.800, maxLon: 139.812 };

test('pickZoom: 狭いエリアほど高ズーム、広いエリアほど低ズームを選ぶ', () => {
  const zSmall = pickZoom(AREA, 4);
  const wide = { minLat: 34.5, maxLat: 36.5, minLon: 138.5, maxLon: 140.5 };
  const zWide = pickZoom(wide, 4);
  assert.ok(zSmall > zWide, `zSmall=${zSmall} zWide=${zWide}`);
});

test('pickZoom: 選んだズームでは両軸ともタイル数が maxTiles 以内', () => {
  const maxTiles = 4;
  const z = pickZoom(AREA, maxTiles);
  const r = tileRangeForBounds(AREA, z);
  assert.ok(r.cols <= maxTiles && r.rows <= maxTiles);
  // 1つ上のズームでは超える(=最大限詳細を選んでいる)ことを確認(上限zでない限り)
  if (z < 18) {
    const r2 = tileRangeForBounds(AREA, z + 1);
    assert.ok(r2.cols > maxTiles || r2.rows > maxTiles);
  }
});

test('tileRangeForBounds: 被覆boundsは入力boundsを内包する', () => {
  const z = pickZoom(AREA, 4);
  const r = tileRangeForBounds(AREA, z);
  assert.ok(r.bounds.minLat <= AREA.minLat);
  assert.ok(r.bounds.maxLat >= AREA.maxLat);
  assert.ok(r.bounds.minLon <= AREA.minLon);
  assert.ok(r.bounds.maxLon >= AREA.maxLon);
  assert.equal(r.cols, r.x1 - r.x0 + 1);
  assert.equal(r.rows, r.y1 - r.y0 + 1);
});

test('planBasemap: タイル配置・画像サイズ・被覆boundsを返す', () => {
  const plan = planBasemap(AREA, { maxTiles: 4, tileSize: 256 });
  assert.equal(plan.width, plan.cols * 256);
  assert.equal(plan.height, plan.rows * 256);
  assert.equal(plan.tiles.length, plan.cols * plan.rows);
  // 各タイルの描画オフセットは 0..(cols-1)*256 の範囲でユニーク
  const dxs = new Set(plan.tiles.map((t) => t.dx));
  const dys = new Set(plan.tiles.map((t) => t.dy));
  assert.equal(dxs.size, plan.cols);
  assert.equal(dys.size, plan.rows);
  for (const t of plan.tiles) {
    assert.ok(t.dx >= 0 && t.dx < plan.width);
    assert.ok(t.dy >= 0 && t.dy < plan.height);
    assert.equal(t.z, plan.z);
  }
});

test('pickSeaColor: 白(陸)が多くても青みの強い最頻色(海)を選ぶ', () => {
  const data = rgbaFrom([
    { rgb: [255, 255, 255], count: 100 }, // 陸(白)
    { rgb: [140, 140, 140], count: 20 },  // 道路(灰)
    { rgb: [191, 211, 255], count: 40 },  // 海(GSI淡色)
  ]);
  assert.equal(pickSeaColor(data, { stride: 1 }), '#bfd3ff');
});

test('pickSeaColor: 海らしい色が無ければ既定値', () => {
  const data = rgbaFrom([
    { rgb: [255, 255, 255], count: 50 },
    { rgb: [140, 140, 140], count: 50 },
  ]);
  assert.equal(pickSeaColor(data, { stride: 1 }), DEFAULT_SEA_COLOR);
});

test('pickSeaColor: 2つの青のうち多い方を選ぶ', () => {
  const data = rgbaFrom([
    { rgb: [191, 211, 255], count: 10 },
    { rgb: [160, 190, 255], count: 30 },
  ]);
  assert.equal(pickSeaColor(data, { stride: 1 }), '#a0beff');
});

test('stitchBasemap: 各タイルを正しい位置に描き dataURL を返す(欠損タイルは飛ばす)', async () => {
  const plan = planBasemap(AREA, { maxTiles: 4, tileSize: 256 });
  const draws = [];
  const fakeCanvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (img, dx, dy) => draws.push({ img, dx, dy }) }),
    toDataURL: () => 'data:image/png;base64,STUB',
  };
  let calls = 0;
  const result = await stitchBasemap(plan, {
    createCanvas: (w, h) => { fakeCanvas.width = w; fakeCanvas.height = h; return fakeCanvas; },
    // 先頭タイルだけ欠損(null)を返し、残りはダミー画像
    fetchTile: (z, x, y) => { calls += 1; return Promise.resolve(calls === 1 ? null : { z, x, y }); },
  });
  assert.equal(result.image, 'data:image/png;base64,STUB');
  assert.deepEqual(result.bounds, plan.bounds);
  assert.equal(result.z, plan.z);
  assert.equal(result.seaColor, DEFAULT_SEA_COLOR); // fakeCanvasにgetImageDataなし→既定
  assert.equal(fakeCanvas.width, plan.width);
  assert.equal(draws.length, plan.tiles.length - 1); // 欠損1枚は描かれない
  // 描かれたタイルのオフセットは plan のものと一致
  for (const d of draws) {
    assert.ok(plan.tiles.some((t) => t.dx === d.dx && t.dy === d.dy));
  }
});
