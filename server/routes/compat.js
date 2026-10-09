// server/routes/compat.js
// 旧 API(共有ログイン・projects・overlays・sensor-imports・minutes-imports・uploads など)。
// api.js から挙動不変で切り出した。判定順序・バリデーション・戻り値をそのまま保つ。
// 処理したら true、どのパスにも一致しなければ false(呼び出し側が 404 を返す)。
import { send, readBody } from './http.js';
import { isAuthorized, isViewer } from '../auth.js';
import {
  OVERLAY_NAMES, isValidProjectName, isValidImportId, isValidUploadFile,
} from '../storage.js';
import { uniqueProjectName } from '../../src/projectfs.js';
import {
  validateCommitRows, mergeRowsByMember, reflectionsFromRows, emptyProject,
} from '../minutesimport.js';
import { practiceSummary } from '../../src/summary.js';
import { parseSensorCsv, jstStamp, buildTrack } from '../sensorimport.js';
import { randomBytes } from 'node:crypto';

export async function compatRoute(req, res, ctx) {
  const {
    store, token, viewEnabled, viewSecret, viewUser, viewPassword,
    secureCookie, path, method, requireViewer, requireWrite,
  } = ctx;

  if (path === '/api/auth') { send(res, 200, { unlocked: isAuthorized(req, token) }); return true; }

  // 閲覧セッションの状態。ゲート無効時は常にログイン済み扱い。
  if (path === '/api/session' && method === 'GET') {
    // users はログイン画面の候補表示用(ユーザー名のみ・パスワードは返さない)。
    send(res, 200, {
      loggedIn: isViewer(req, viewSecret, token),
      gate: viewEnabled,
      users: viewEnabled ? [viewUser] : [],
    });
    return true;
  }

  // 閲覧ログイン。user/password を照合し、成功で sailviz_view Cookie を発行。
  if (path === '/api/login' && method === 'POST') {
    if (!viewEnabled) { send(res, 200, { loggedIn: true }); return true; }
    const body = await readBody(req) || {};
    if (body.user === viewUser && body.password === viewPassword) {
      send(res, 200, { loggedIn: true }, {
        'set-cookie': `sailviz_view=${viewSecret}; HttpOnly; SameSite=Lax; Path=/${secureCookie}`,
      });
    } else send(res, 401, { error: 'ユーザー名またはパスワードが違います' });
    return true;
  }

  if (path === '/api/logout' && method === 'POST') {
    send(res, 200, { loggedIn: false }, {
      'set-cookie': `sailviz_view=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
    });
    return true;
  }

  if (path === '/api/sensor-imports' && method === 'POST') {
    if (requireWrite()) return true;
    const body = await readBody(req) || {};
    const { person, csv } = body;
    if (typeof csv !== 'string' || typeof person !== 'string') {
      send(res, 400, { error: 'person と csv が必要' }); return true;
    }
    let parsed;
    try { parsed = parseSensorCsv(csv); }
    catch (e) { send(res, 422, { error: String(e.message || e) }); return true; }
    const importId = `imp_${jstStamp(parsed.practiceDate).replace(/-/g, '_')}_${randomBytes(4).toString('hex')}`;
    await store.saveUpload(importId, 'raw.csv', csv);
    const matched = await store.findReflectionByDate(person, parsed.practiceDate);
    send(res, 200, {
      importId,
      practiceDate: parsed.practiceDate,
      points: parsed.points.length,
      bounds: parsed.bounds,
      matched,
    });
    return true;
  }

  if (path === '/api/minutes-imports/commit' && method === 'POST') {
    if (requireWrite()) return true;
    const body = await readBody(req) || {};
    const practiceDate = Number(body.practiceDate);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const bad = validateCommitRows(rows, practiceDate);
    if (bad) { send(res, 400, { error: bad }); return true; }

    const reflections = reflectionsFromRows({ rows: mergeRowsByMember(rows), now: Date.now() });
    const found = await store.findProjectByPracticeDate(practiceDate);
    let name, created = false, proj;
    if (found) {
      name = found.name;
      proj = await store.readProject(name);
      if (!Array.isArray(proj.reflections)) proj.reflections = [];
    } else {
      const existing = (await store.listProjects()).map((p) => p.name);
      name = uniqueProjectName(practiceDate, existing);
      proj = emptyProject(practiceDate, new Date().toISOString());
      created = true;
    }
    proj.reflections.push(...reflections);
    if (typeof proj.practiceDate !== 'number') proj.practiceDate = practiceDate;
    await store.writeProject(name, proj);
    send(res, 200, { name, added: reflections.length, created });
    return true;
  }

  const commitMatch = path.match(/^\/api\/sensor-imports\/([^/]+)\/commit$/);
  if (commitMatch && method === 'POST') {
    if (requireWrite()) return true;
    const importId = decodeURIComponent(commitMatch[1]);
    if (!isValidImportId(importId)) { send(res, 400, { error: 'bad importId' }); return true; }
    const body = await readBody(req) || {};
    const { name, boatNumber } = body;
    if (typeof name !== 'string' || !isValidProjectName(name) ||
        typeof boatNumber !== 'string' || !boatNumber.trim()) {
      send(res, 400, { error: 'name と boatNumber が必要' }); return true;
    }
    let csv;
    try { csv = await store.readUpload(importId, 'raw.csv'); }
    catch { send(res, 404, { error: 'import not found' }); return true; }
    let proj;
    try { proj = await store.readProject(name); }
    catch { send(res, 404, { error: 'project not found' }); return true; }

    const parsed = parseSensorCsv(csv);
    const finalName = `${boatNumber.trim()}_${jstStamp(parsed.points[0].t)}.csv`;
    await store.renameUpload(importId, 'raw.csv', finalName);

    const uploadedAt = Date.now();
    const tracks = Array.isArray(proj.tracks) ? proj.tracks : [];
    const track = buildTrack({
      id: importId,
      name: boatNumber.trim(),
      points: parsed.points,
      bounds: parsed.bounds,
      colorIndex: tracks.length,
      source: { importId, filename: finalName, boatNumber: boatNumber.trim(), uploadedAt },
      excludedIntervals: parsed.excludedIntervals,
    });
    tracks.push(track);
    proj.tracks = tracks;
    const logs = Array.isArray(proj.sensorLogs) ? proj.sensorLogs : [];
    logs.push({ id: importId, filename: finalName, size: Buffer.byteLength(csv, 'utf8'), uploadedAt });
    proj.sensorLogs = logs;

    await store.writeProject(name, proj);
    send(res, 200, { name });
    return true;
  }

  const upMatch = path.match(/^\/api\/uploads\/([^/]+)\/([^/]+)$/);
  if (upMatch && method === 'GET') {
    if (requireViewer()) return true;
    const importId = decodeURIComponent(upMatch[1]);
    const file = decodeURIComponent(upMatch[2]);
    if (!isValidImportId(importId) || !isValidUploadFile(file)) {
      send(res, 400, { error: 'bad path' }); return true;
    }
    try {
      const text = await store.readUpload(importId, file);
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    } catch { send(res, 404, { error: 'not found' }); }
    return true;
  }

  if (path === '/api/unlock' && method === 'POST') {
    if (!token) { send(res, 503, { error: 'write disabled' }); return true; }
    const body = await readBody(req);
    if (body?.password === token) {
      send(res, 200, { unlocked: true }, {
        'set-cookie': `sailviz_token=${token}; HttpOnly; SameSite=Lax; Path=/${secureCookie}`,
      });
    } else send(res, 401, { error: 'invalid password' });
    return true;
  }

  if (path === '/api/lock' && method === 'POST') {
    send(res, 200, { unlocked: false }, {
      'set-cookie': `sailviz_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
    });
    return true;
  }

  if (path === '/api/projects' && method === 'GET') {
    if (requireViewer()) return true;
    send(res, 200, await store.listProjects()); return true;
  }

  if (path === '/api/summaries' && method === 'GET') {
    if (requireViewer()) return true;
    const list = await store.listProjects();
    const rows = [];
    for (const { name } of list) {
      try { rows.push({ name, ...practiceSummary(await store.readProject(name), { name }) }); }
      catch { /* 壊れたファイルは飛ばす */ }
    }
    send(res, 200, rows); return true;
  }

  const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch) {
    const name = decodeURIComponent(projMatch[1]);
    if (!isValidProjectName(name)) { send(res, 400, { error: 'bad name' }); return true; }
    if (method === 'GET') {
      if (requireViewer()) return true;
      try { send(res, 200, await store.readProject(name)); }
      catch { send(res, 404, { error: 'not found' }); }
      return true;
    }
    if (method === 'PUT') {
      if (requireWrite()) return true;
      await store.writeProject(name, await readBody(req));
      send(res, 200, { ok: true }); return true;
    }
    if (method === 'DELETE') {
      if (requireWrite()) return true;
      try { await store.deleteProject(name); } catch { /* 既に無ければ黙認 */ }
      send(res, 200, { ok: true }); return true;
    }
  }

  const ovMatch = path.match(/^\/api\/overlays\/([^/]+)$/);
  if (ovMatch) {
    const name = ovMatch[1];
    if (!OVERLAY_NAMES.includes(name)) { send(res, 400, { error: 'bad overlay' }); return true; }
    if (method === 'GET') {
      if (requireViewer()) return true;
      send(res, 200, await store.readOverlay(name)); return true;
    }
    if (method === 'PUT') {
      if (requireWrite()) return true;
      await store.writeOverlay(name, await readBody(req));
      send(res, 200, { ok: true }); return true;
    }
  }

  return false;
}
