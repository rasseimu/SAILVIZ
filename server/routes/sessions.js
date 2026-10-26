// server/routes/sessions.js
// 記録セッション API(Phase 3。設計書 v2 §7・§10.4)。アプリの「終了と同時のアップロード」の受け口。
//   POST   /api/sessions                    登録(同じ id の再送は同じ結果)
//   PUT    /api/sessions/:id/chunks/:seq    チャンク(本文 CSV・X-Chunk-Sha256)
//   GET    /api/sessions/:id                → { session, receivedSeqs(所有者のみ) }
//   POST   /api/sessions/:id/finalize       → { pointCount, bounds, csvName, attachedTo }
//   PATCH  /api/sessions/:id                艇番・乗員・種別・公開範囲
//   GET    /api/sessions?scope=mine|crew    素の配列(新しい順)
//   GET    /api/sessions/:id/track | /csv   閲覧権限に従う
//   DELETE /api/sessions/:id                所有者
// 読めないセッションは存在を明かさないため 404。エラーは { error: { code, message } }(§10.1)。
// 処理したら true、対象外なら false。
import { createHash } from 'node:crypto';
import { send } from './http.js';
import { canRead } from '../domain/policy.js';

const MAX_JSON = 64 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024; // 300 点で約 20KB(§7.3)。余裕を見て 4MB
const KINDS = ['practice', 'race'];
const VIS = ['private', 'org', 'public'];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const err = (res, status, code, message) => send(res, status, { error: { code, message } });

async function readRaw(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('too large'); e.code = 'too_large'; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// 乗員の形だけを検証する(組織の判定は呼び出し側)。不正なら null。
function normalizeCrew(crew) {
  if (!Array.isArray(crew) || crew.length < 1 || crew.length > 20) return null;
  const out = [];
  for (const c of crew) {
    if (!c || typeof c !== 'object') return null;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name || name.length > 100) return null;
    if (c.userId != null && typeof c.userId !== 'string') return null;
    if (c.role != null && typeof c.role !== 'string') return null;
    out.push({ role: c.role ?? null, userId: c.userId || null, name });
  }
  return out;
}
const normalizeBoatNo = (b) => (typeof b === 'string' && b.trim() && b.trim().length <= 20 ? b.trim() : null);

export function createSessionsRoute({ sessions, accounts, now = () => Date.now() }) {
  // DB(STORAGE=db)でないときは記録セッションを扱えない。
  if (!sessions) {
    return async (req, res, ctx) => {
      if (!ctx.path.startsWith('/api/sessions')) return false;
      err(res, 503, 'unavailable', '記録セッションはこのサーバでは使えません');
      return true;
    };
  }

  const toJson = (s, { withOrg = false } = {}) => ({
    id: s.id,
    ownerUserId: s.owner_user_id ?? null,
    kind: s.kind,
    visibility: s.visibility,
    boatNo: s.boat_no ?? '',
    crew: sessions.crewOf(s.id),
    startedMs: s.started_ms ?? null,
    endedMs: s.ended_ms ?? null,
    chunkCount: s.chunk_count ?? null,
    pointCount: s.point_count ?? null,
    status: s.status,
    csvName: sessions.csvNameOf(s.id),
    attachedTo: sessions.attachedTo(s),
    ...(withOrg ? { orgId: s.org_id ?? null } : {}),
  });

  const target = (s) => ({
    kind: s.kind === 'race' ? 'race' : 'session',
    visibility: s.visibility,
    ownerId: s.owner_user_id ?? null,
    crewIds: sessions.crewOf(s.id).map((c) => c.userId).filter(Boolean),
    orgId: s.org_id ?? null,
  });

  // 乗員の userId は、所有者本人か、記録した組織のメンバーでなければならない(§5.3)。
  const crewAllowed = (crew, ownerUserId, orgId) => crew.every((c) => !c.userId
    || c.userId === ownerUserId || (orgId && accounts.isMember(orgId, c.userId)));

  return async function sessionsRoute(req, res, ctx) {
    const { path, method } = ctx;
    if (path !== '/api/sessions' && !path.startsWith('/api/sessions/')) return false;
    const url = new URL(req.url, 'http://localhost');
    const subject = ctx.getSubject();
    if (subject?.orgForbidden) { err(res, 403, 'org_forbidden', '所属していない組織です'); return true; }
    const me = subject?.kind === 'user' ? subject : null;

    const readJson = async () => {
      const buf = await readRaw(req, MAX_JSON);
      if (!buf.length) return {};
      return JSON.parse(buf.toString('utf8'));
    };
    const needUser = () => {
      if (me) return true;
      err(res, 401, 'unauthorized', 'ログインが必要です');
      return false;
    };
    // 所有者のセッションだけを返す。それ以外は 404 を送って null。
    const ownSession = (id) => {
      const s = sessions.get(id);
      if (!s || s.owner_user_id !== me.userId) { err(res, 404, 'not_found', '記録が見つかりません'); return null; }
      return s;
    };
    // 読めるセッションだけを返す。それ以外は 404 を送って null。
    const readableSession = (id) => {
      const s = sessions.get(id);
      if (!s || !canRead(subject, target(s))) { err(res, 404, 'not_found', '記録が見つかりません'); return null; }
      return s;
    };

    try {
      if (path === '/api/sessions' && method === 'POST') {
        if (!needUser()) return true;
        let b;
        try { b = await readJson(); } catch { err(res, 422, 'invalid_input', 'JSON を読めません'); return true; }
        const boatNo = normalizeBoatNo(b.boatNo);
        const crew = normalizeCrew(b.crew);
        const bad = !ID_RE.test(String(b.id ?? '')) ? 'id'
          : !KINDS.includes(b.kind) ? 'kind'
            : !boatNo ? 'boatNo'
              : !crew ? 'crew'
                : !Number.isFinite(b.startedMs) ? 'startedMs'
                  : (b.visibility != null && !VIS.includes(b.visibility)) ? 'visibility'
                    : (b.device != null && typeof b.device !== 'object') ? 'device' : null;
        if (bad) { err(res, 422, 'invalid_input', `${bad} が正しくありません`); return true; }
        const existing = sessions.get(b.id);
        if (existing) {
          if (existing.owner_user_id !== me.userId) { err(res, 409, 'conflict', '同じ id の記録が既にあります'); return true; }
          send(res, 200, { session: toJson(existing) });
          return true;
        }
        const orgId = me.activeOrgId ?? null;
        if (!crewAllowed(crew, me.userId, orgId)) {
          err(res, 422, 'crew_not_member', '乗員に、記録する組織のメンバーでない人が含まれています');
          return true;
        }
        const def = accounts.getUser(me.userId)?.default_visibility;
        const visibility = b.kind === 'race' ? 'public' : (b.visibility ?? (VIS.includes(def) ? def : 'private'));
        const device = b.device ? {
          platform: String(b.device.platform ?? ''), osVersion: String(b.device.osVersion ?? ''), app: String(b.device.app ?? ''),
        } : null;
        const s = sessions.create({
          id: b.id, ownerUserId: me.userId, orgId, kind: b.kind, boatNo, crew, visibility,
          startedMs: b.startedMs, device, now: now(),
        });
        send(res, 200, { session: toJson(s) });
        return true;
      }

      if (path === '/api/sessions' && method === 'GET') {
        if (!needUser()) return true;
        const scope = url.searchParams.get('scope') || 'mine';
        if (scope !== 'mine' && scope !== 'crew') { err(res, 422, 'invalid_input', 'scope は mine か crew です'); return true; }
        const rows = scope === 'mine' ? sessions.listByOwner(me.userId) : sessions.listByCrew(me.userId);
        send(res, 200, rows.map((s) => toJson(s)));
        return true;
      }

      const chunkM = path.match(/^\/api\/sessions\/([^/]+)\/chunks\/(\d+)$/);
      if (chunkM && method === 'PUT') {
        if (!needUser()) return true;
        const s = ownSession(decodeURIComponent(chunkM[1])); if (!s) return true;
        const seq = Number(chunkM[2]);
        if (!Number.isSafeInteger(seq) || seq > 100_000) { err(res, 422, 'invalid_input', 'seq が正しくありません'); return true; }
        let buf;
        try { buf = await readRaw(req, MAX_CHUNK); } catch { err(res, 413, 'too_large', 'チャンクが大きすぎます'); return true; }
        const hash = createHash('sha256').update(buf).digest('hex');
        const claimed = String(req.headers['x-chunk-sha256'] ?? '').trim().toLowerCase();
        if (claimed && claimed !== hash) { err(res, 422, 'hash_mismatch', 'X-Chunk-Sha256 が本文と一致しません'); return true; }
        const csv = buf.toString('utf8');
        const pointCount = Math.max(0, csv.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
        // finalize 後は、同じ内容の再送(duplicate)だけを受ける。新しい seq は結果を変えるので 409。
        if (s.status === 'finalized' && sessions.chunkHash(s.id, seq) !== hash) {
          err(res, 409, 'finalized', '確定済みの記録です');
          return true;
        }
        const status = sessions.putChunk({ sessionId: s.id, seq, csv, sha256: hash, pointCount, now: now() });
        if (status === 'conflict') { err(res, 409, 'conflict', '同じ seq に別の内容が届いています'); return true; }
        send(res, 200, { seq, status });
        return true;
      }

      const finM = path.match(/^\/api\/sessions\/([^/]+)\/finalize$/);
      if (finM && method === 'POST') {
        if (!needUser()) return true;
        const s = ownSession(decodeURIComponent(finM[1])); if (!s) return true;
        let b;
        try { b = await readJson(); } catch { err(res, 422, 'invalid_input', 'JSON を読めません'); return true; }
        if (!Number.isSafeInteger(b.chunkCount) || !Number.isFinite(b.endedMs)) {
          err(res, 422, 'invalid_input', 'endedMs と chunkCount が必要です'); return true;
        }
        const r = sessions.finalize({ id: s.id, endedMs: b.endedMs, chunkCount: b.chunkCount, now: now() });
        if (!r.ok) { err(res, 422, r.code, r.message); return true; }
        send(res, 200, r.result);
        return true;
      }

      const subM = path.match(/^\/api\/sessions\/([^/]+)\/(track|csv)$/);
      if (subM && method === 'GET') {
        const s = readableSession(decodeURIComponent(subM[1])); if (!s) return true;
        if (s.status !== 'finalized') { err(res, 404, 'not_found', 'まだ確定していない記録です'); return true; }
        if (subM[2] === 'track') { send(res, 200, sessions.track(s.id)); return true; }
        const name = sessions.csvNameOf(s.id) || `${s.id}.csv`;
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        res.end(sessions.joinedCsv(s.id));
        return true;
      }

      const oneM = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (oneM && method === 'GET') {
        const s = readableSession(decodeURIComponent(oneM[1])); if (!s) return true;
        const isOwner = me && s.owner_user_id === me.userId;
        send(res, 200, isOwner ? { session: toJson(s), receivedSeqs: sessions.receivedSeqs(s.id) } : { session: toJson(s) });
        return true;
      }

      if (oneM && method === 'PATCH') {
        if (!needUser()) return true;
        const s = ownSession(decodeURIComponent(oneM[1])); if (!s) return true;
        let b;
        try { b = await readJson(); } catch { err(res, 422, 'invalid_input', 'JSON を読めません'); return true; }
        const patch = {};
        if (b.boatNo !== undefined) {
          patch.boatNo = normalizeBoatNo(b.boatNo);
          if (!patch.boatNo) { err(res, 422, 'invalid_input', 'boatNo が正しくありません'); return true; }
        }
        if (b.crew !== undefined) {
          patch.crew = normalizeCrew(b.crew);
          if (!patch.crew) { err(res, 422, 'invalid_input', 'crew が正しくありません'); return true; }
          if (!crewAllowed(patch.crew, me.userId, s.org_id)) {
            err(res, 422, 'crew_not_member', '乗員に、記録した組織のメンバーでない人が含まれています'); return true;
          }
        }
        if (b.kind !== undefined) {
          if (!KINDS.includes(b.kind)) { err(res, 422, 'invalid_input', 'kind が正しくありません'); return true; }
          patch.kind = b.kind;
        }
        if (b.visibility !== undefined) {
          if (!VIS.includes(b.visibility)) { err(res, 422, 'invalid_input', 'visibility が正しくありません'); return true; }
          // レースは常に全体公開(§5.4)。
          if ((patch.kind ?? s.kind) !== 'race') patch.visibility = b.visibility;
        }
        const updated = sessions.update(s.id, patch, now());
        send(res, 200, { session: toJson(updated) });
        return true;
      }

      if (oneM && method === 'DELETE') {
        if (!needUser()) return true;
        const s = ownSession(decodeURIComponent(oneM[1])); if (!s) return true;
        sessions.remove(s.id, now());
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return true;
      }
    } catch (e) {
      if (e?.code === 'too_large') { err(res, 413, 'too_large', '本文が大きすぎます'); return true; }
      throw e;
    }
    return false;
  };
}
