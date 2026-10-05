// server/domain/projectRows.js
// 旧プロジェクト JSON ⇄ DB の行。純関数(node:sqlite 非依存)でテストの中心。
//
// 往復保証の方針(ledger 参照):
// - 再構築の真実は JSON ブロブ。列は検索用の非正規化コピー。
// - practice_days.web_state = proj から {tracks, reflections} を除いた残り(verbatim)。
// - tracks.view = track から {id, points, bounds, tRange, source} を除いた残り(verbatim)。
//   points/bounds/tRange は列、source は rec_sessions.source。存在した場合のみ保存し、
//   復元時も存在した場合のみ付け直す(キーの有無を正確に保つ)。
// - reflections.body = 反省オブジェクト全体(verbatim)。復元はそのまま返す。
// - assembleProject は純粋な旧 JSON を返す(_rev は付けない。互換 GET 層で付与)。

const two = (n) => String(n).padStart(2, '0');

// 検索用の date(JST 'YYYY-MM-DD')。practiceDate(ms)優先、無ければファイル名から。
function deriveDate(proj, legacyName) {
  if (Number.isFinite(proj.practiceDate)) {
    const d = new Date(Number(proj.practiceDate) + 9 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  }
  const m = legacyName && String(legacyName).match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// キーが存在すれば JSON 文字列、無ければ null(SQL NULL)。null 値と「キー無し」を区別する。
const col = (obj, key) => (key in obj ? JSON.stringify(obj[key]) : null);
// 列が null でなければ復元して付け直す。
const addCol = (target, key, value) => { if (value !== null && value !== undefined) target[key] = JSON.parse(value); };

export function decomposeProject(proj, { legacyName = null, pdId = 'pd_x', date = null, now = 0, orgId = null, ownerUserId = null } = {}) {
  const wsObj = { ...proj };
  delete wsObj.tracks;
  delete wsObj.reflections;

  const practiceDay = {
    id: pdId,
    org_id: orgId,
    owner_user_id: ownerUserId,
    date: date ?? deriveDate(proj, legacyName),
    legacy_name: legacyName,
    web_state: JSON.stringify(wsObj),
    saved_at: proj.savedAt ?? null,
    rev: 0,
    created_at: now,
    updated_at: now,
  };

  const sessions = [];
  const tracks = [];
  // 旧データの track.id は一意でない(全艇が 'Location.csv' 等)。rec_sessions.id は
  // 設計上「新規 ID」なので、器×索引で一意な合成 ID を採番し、元の track.id は view に残す。
  (Array.isArray(proj.tracks) ? proj.tracks : []).forEach((t, i) => {
    const sessionId = `${pdId}_t${i}`;
    const view = { ...t };
    delete view.points; delete view.bounds; delete view.tRange; delete view.source;
    sessions.push({
      id: sessionId,
      owner_user_id: null,
      legacy_owner_name: null,
      kind: 'practice',
      practice_day_id: pdId,
      race_record_id: null,
      position: i,
      boat_no: t.source?.boatNumber ?? null,
      started_ms: null,
      ended_ms: null,
      chunk_count: null,
      point_count: Array.isArray(t.points) ? t.points.length : null,
      status: 'finalized',
      visibility: 'org',
      device: null,
      source: col(t, 'source'),
      created_at: now,
      finalized_at: null,
    });
    tracks.push({
      session_id: sessionId,
      points: col(t, 'points'),
      bounds: col(t, 'bounds'),
      t_range: col(t, 'tRange'),
      point_count: Array.isArray(t.points) ? t.points.length : null,
      csv_name: t.source?.filename ?? null,
      view: JSON.stringify(view),
    });
  });

  // 旧データの反省 ID もファイル間で重複しうる(progress.json は元 ID をキーに別管理)。
  // reflections.id は器×索引の合成 ID にし、元 ID は body(verbatim)に保持する。
  const reflections = (Array.isArray(proj.reflections) ? proj.reflections : []).map((r, i) => ({
    id: `${pdId}_r${i}`,
    practice_day_id: pdId,
    position: i,
    author_user_id: null,
    legacy_author_name: Array.isArray(r.people) ? (r.people[0] ?? null) : null,
    session_id: r.sessionId ?? null,
    voice_id: null,
    visibility: 'org',
    body: JSON.stringify(r),
    created_at: r.createdAt ?? null,
    updated_at: now,
  }));

  return { practiceDay, sessions, tracks, reflections };
}

export function assembleProject({ practiceDay, sessions = [], tracks = [], reflections = [] }) {
  const proj = { ...JSON.parse(practiceDay.web_state) };

  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const pos = (sid) => sessById.get(sid)?.position ?? 0;
  const outTracks = [...tracks]
    .sort((a, b) => pos(a.session_id) - pos(b.session_id))
    .map((tr) => {
      const s = sessById.get(tr.session_id);
      // view に元の track.id を含む(合成 session_id ではなく元 id を復元する)。
      const t = { ...JSON.parse(tr.view) };
      addCol(t, 'points', tr.points);
      addCol(t, 'bounds', tr.bounds);
      addCol(t, 'tRange', tr.t_range);
      if (s) addCol(t, 'source', s.source);
      return t;
    });

  const outRefls = [...reflections]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((r) => JSON.parse(r.body));

  proj.tracks = outTracks;
  proj.reflections = outRefls;
  return proj;
}
