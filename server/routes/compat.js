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
import {
  isCompatWriter, canPutDay, canDeleteDay, canSeeProject, filterProject, managedReflectionPredicate,
  buildReflectionIndex, filterProgressRead, mergeProgressWrite, filterRoadmapRead, mergeRoadmapWrite,
} from '../domain/compatAccess.js';
import { randomBytes } from 'node:crypto';

export async function compatRoute(req, res, ctx) {
  const {
    store, token, viewEnabled, viewSecret, viewUser, viewPassword,
    secureCookie, path, method, requireViewer, requireWrite,
  } = ctx;

  // ---- 認可 ----
  // DB 版の repo(getProjectAccess を持つ)では policy.js の判定で絞る(S2.5-P2)。
  // ファイル版は組織の情報が無いので従来どおり(閲覧ゲート + 書込トークンだけ)。
  const policyOn = typeof store.getProjectAccess === 'function';
  // 閲覧: 主体を返す。未ログインなら 401 を送って null。ポリシー無効時は true。
  const gateRead = () => {
    if (!policyOn) return requireViewer() ? null : true;
    const s = ctx.getSubject();
    if (!s) { send(res, 401, { error: 'login required' }); return null; }
    return s;
  };
  // 書き込み: 主体を返す。未認証(トークンの無い共有ログイン含む)は 401、書けない主体
  // (組織未設定の共有ログイン・ログインユーザー)は 403 を送って null。ポリシー無効時は true。
  const gateWrite = () => {
    if (!policyOn) return requireWrite() ? null : true;
    const s = ctx.getSubject();
    if (!s || (s.kind === 'legacy' && !s.canWrite)) { send(res, 401, { error: 'unauthorized' }); return null; }
    if (!isCompatWriter(s)) { send(res, 403, { error: 'forbidden' }); return null; }
    return s;
  };
  // 器の書き込み。ポリシー有効時は新しい器に組織を付け、見えない・書けない反省には触らない。
  const putProject = (name, proj, s) => {
    if (!policyOn) return store.writeProject(name, proj);
    const access = store.getProjectAccess(name);
    return store.writeProject(name, proj, {
      orgId: s.orgId, managedReflection: managedReflectionPredicate(s, access ? access.orgId : s.orgId),
    });
  };

  // 1回の読込みで JSON と access を得る(DB 版)。ファイル版は access なし。
  const loadWithAccess = async (name) => (policyOn
    ? store.readProjectWithAccess(name)
    : { project: await store.readProject(name), access: null });
  // 取込みの書き戻し用: 主体に見える中身だけにした JSON(見えない反省・軌跡は書き戻さない)。
  // 器そのものが見えない(中身がすべて見えない)ときは空の中身にする(PUT は見えない項目に触れない)。
  const loadForWrite = async (name, s) => {
    const { project, access } = await loadWithAccess(name);
    if (!policyOn) return project;
    return filterProject(s, project, access) || { ...project, tracks: [], reflections: [] };
  };

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
    const writer = gateWrite(); if (!writer) return true;
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
    // commit できる(PUT できる)器だけを返す。見えても書けない他組織の器は返さない(commit が 404 になるため)。
    // 一致する器が複数あれば、書ける最初の器を返す。
    let matched;
    if (policyOn && typeof store.findReflectionsByDate === 'function') {
      matched = store.findReflectionsByDate(person, parsed.practiceDate)
        .find((c) => canPutDay(writer, store.getProjectAccess(c.name))) || null;
    } else {
      matched = await store.findReflectionByDate(person, parsed.practiceDate);
      if (matched && policyOn && !canPutDay(writer, store.getProjectAccess(matched.name))) matched = null;
    }
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
    const writer = gateWrite(); if (!writer) return true;
    const body = await readBody(req) || {};
    const practiceDate = Number(body.practiceDate);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const bad = validateCommitRows(rows, practiceDate);
    if (bad) { send(res, 400, { error: bad }); return true; }

    const reflections = reflectionsFromRows({ rows: mergeRowsByMember(rows), now: Date.now() });
    // 日付の合う器をすべて調べ、書ける(自組織の)最初の器を使う。無ければ新しい器を作る。
    let found = null;
    if (policyOn && typeof store.findProjectsByPracticeDate === 'function') {
      found = store.findProjectsByPracticeDate(practiceDate)
        .find((c) => canPutDay(writer, store.getProjectAccess(c.name))) || null;
    } else {
      found = await store.findProjectByPracticeDate(practiceDate);
      if (found && policyOn && !canPutDay(writer, store.getProjectAccess(found.name))) found = null;
    }
    let name, created = false, proj;
    if (found) {
      name = found.name;
      proj = await loadForWrite(name, writer);
      if (!Array.isArray(proj.reflections)) proj.reflections = [];
    } else {
      const existing = (await store.listProjects()).map((p) => p.name);
      name = uniqueProjectName(practiceDate, existing);
      proj = emptyProject(practiceDate, new Date().toISOString());
      created = true;
    }
    proj.reflections.push(...reflections);
    if (typeof proj.practiceDate !== 'number') proj.practiceDate = practiceDate;
    await putProject(name, proj, writer);
    send(res, 200, { name, added: reflections.length, created });
    return true;
  }

  const commitMatch = path.match(/^\/api\/sensor-imports\/([^/]+)\/commit$/);
  if (commitMatch && method === 'POST') {
    const writer = gateWrite(); if (!writer) return true;
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
    let proj, access = null;
    try {
      // 器の読込みは1回だけ(JSON と access を同じ行から得る)。
      const loaded = await loadWithAccess(name);
      access = loaded.access;
      if (policyOn && !canPutDay(writer, access)) throw new Error('forbidden');
      proj = policyOn
        ? filterProject(writer, loaded.project, access) || { ...loaded.project, tracks: [], reflections: [] }
        : loaded.project;
    } catch { send(res, 404, { error: 'project not found' }); return true; }

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
      // 見えない軌跡も数える(色が既存の軌跡と重ならないように)。ポリシー有効時は全軌跡数(access)。
      colorIndex: policyOn ? (access?.tracks.length ?? 0) : tracks.length,
      source: { importId, filename: finalName, boatNumber: boatNumber.trim(), uploadedAt },
      excludedIntervals: parsed.excludedIntervals,
    });
    tracks.push(track);
    proj.tracks = tracks;
    const logs = Array.isArray(proj.sensorLogs) ? proj.sensorLogs : [];
    logs.push({ id: importId, filename: finalName, size: Buffer.byteLength(csv, 'utf8'), uploadedAt });
    proj.sensorLogs = logs;

    await putProject(name, proj, writer);
    send(res, 200, { name });
    return true;
  }

  const upMatch = path.match(/^\/api\/uploads\/([^/]+)\/([^/]+)$/);
  if (upMatch && method === 'GET') {
    const viewer = gateRead(); if (!viewer) return true;
    // 取込 CSV は組織の情報を持たない。ポリシー有効時は組織設定済みの共有ログインだけ(ユーザーは新 API の
    // GET /api/sessions/:id/csv へ。§10.8)。
    if (policyOn && !(viewer.kind === 'legacy' && viewer.orgId)) { send(res, 403, { error: 'forbidden' }); return true; }
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

  // ポリシー有効時の一覧: 主体に見える器だけ。
  const visibleList = async (subject) => (await store.listProjects())
    .filter(({ name }) => canSeeProject(subject, store.getProjectAccess(name)));

  if (path === '/api/projects' && method === 'GET') {
    const subject = gateRead(); if (!subject) return true;
    send(res, 200, policyOn ? await visibleList(subject) : await store.listProjects()); return true;
  }

  if (path === '/api/summaries' && method === 'GET') {
    const subject = gateRead(); if (!subject) return true;
    const rows = [];
    for (const { name } of await store.listProjects()) {
      try {
        // 器ごとに1回だけ読む。見える中身だけで要約する(見えない器は null)。
        const { project, access } = await loadWithAccess(name);
        const proj = policyOn ? filterProject(subject, project, access) : project;
        if (proj) rows.push({ name, ...practiceSummary(proj, { name }) });
      } catch { /* 壊れたファイルは飛ばす */ }
    }
    send(res, 200, rows); return true;
  }

  const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch) {
    const name = decodeURIComponent(projMatch[1]);
    if (!isValidProjectName(name)) { send(res, 400, { error: 'bad name' }); return true; }
    if (method === 'GET') {
      const subject = gateRead(); if (!subject) return true;
      try {
        const { project, access } = await loadWithAccess(name);
        // 見えない器は存在も伏せて 404。見える器は見える中身だけ返す。
        const proj = policyOn ? filterProject(subject, project, access) : project;
        if (!proj) { send(res, 404, { error: 'not found' }); return true; }
        send(res, 200, proj);
      } catch { send(res, 404, { error: 'not found' }); }
      return true;
    }
    if (method === 'PUT') {
      const writer = gateWrite(); if (!writer) return true;
      if (policyOn && !canPutDay(writer, store.getProjectAccess(name))) { send(res, 403, { error: 'forbidden' }); return true; }
      await putProject(name, await readBody(req), writer);
      send(res, 200, { ok: true }); return true;
    }
    if (method === 'DELETE') {
      const writer = gateWrite(); if (!writer) return true;
      // 見えない・書けない中身が混じる器は消さない(巻き込んで消すため)。
      if (policyOn) {
        const access = store.getProjectAccess(name);
        if (access && !canDeleteDay(writer, access)) { send(res, 403, { error: 'forbidden' }); return true; }
      }
      try { await store.deleteProject(name); } catch { /* 既に無ければ黙認 */ }
      send(res, 200, { ok: true }); return true;
    }
  }

  const ovMatch = path.match(/^\/api\/overlays\/([^/]+)$/);
  if (ovMatch) {
    const name = ovMatch[1];
    if (!OVERLAY_NAMES.includes(name)) { send(res, 400, { error: 'bad overlay' }); return true; }
    if (method === 'GET') {
      const subject = gateRead(); if (!subject) return true;
      const cur = await store.readOverlay(name);
      if (!policyOn) { send(res, 200, cur); return true; }
      send(res, 200, name === 'progress'
        ? filterProgressRead(subject, cur, buildReflectionIndex(store.listReflectionAccess()))
        : filterRoadmapRead(subject, cur, store.listRoadmapAccess()));
      return true;
    }
    if (method === 'PUT') {
      const writer = gateWrite(); if (!writer) return true;
      const incoming = await readBody(req);
      if (!policyOn) { await store.writeOverlay(name, incoming); send(res, 200, { ok: true }); return true; }
      // 全置き換えのうち、見えない・書けない項目は元のまま残す。
      const cur = await store.readOverlay(name);
      const merged = name === 'progress'
        ? mergeProgressWrite(writer, cur, incoming, buildReflectionIndex(store.listReflectionAccess()))
        : mergeRoadmapWrite(writer, cur, incoming, store.listRoadmapAccess());
      await store.writeOverlay(name, merged, { orgId: writer.orgId });
      send(res, 200, { ok: true }); return true;
    }
  }

  return false;
}
