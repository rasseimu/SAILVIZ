// MP4/QuickTime(ISO BMFF) の埋め込み撮影時刻を読む。
// 構造: 箱(box)の木。moov > mvhd の creation_time(1904-01-01起点の秒)。
// ファイルシステムの作成日と違い中身なので、Drive等でDLしても保持される。
const MAC_EPOCH_OFFSET = 2082844800; // 1904→1970 秒差

function readType(dv, at) {
  return String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
}

// [start,end) 直下の box を走査し、type 最初の一致の payload 範囲を返す。
function findBox(dv, start, end, type) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const t = readType(dv, pos + 4);
    let headerSize = 8;
    if (size === 1) { // 64bit largesize
      size = dv.getUint32(pos + 8) * 2 ** 32 + dv.getUint32(pos + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos; // 末尾まで
    }
    if (size < headerSize || pos + size > end) break; // 壊れている
    if (t === type) return { start: pos + headerSize, end: pos + size };
    pos += size;
  }
  return null;
}

// mvhd から creation_time(Unix ms) と duration(ms) を読む。
// version0: creation(4)/modification(4)/timescale(4)/duration(4)
// version1: creation(8)/modification(8)/timescale(4)/duration(8)
function readMvhd(dv, payloadStart) {
  const version = dv.getUint8(payloadStart);
  const p = payloadStart + 4; // version(1)+flags(3) をスキップ
  let creation, timescale, duration;
  if (version === 1) {
    creation = dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
    timescale = dv.getUint32(p + 16);
    duration = dv.getUint32(p + 20) * 2 ** 32 + dv.getUint32(p + 24);
  } else {
    creation = dv.getUint32(p);
    timescale = dv.getUint32(p + 8);
    duration = dv.getUint32(p + 12);
  }
  if (!creation) return null; // 0 は未設定扱い
  const unixSec = creation - MAC_EPOCH_OFFSET;
  if (unixSec <= 0) return null;
  return {
    creationMs: unixSec * 1000,
    durationMs: timescale > 0 ? (duration / timescale) * 1000 : null,
  };
}

// バイト列から ASCII 部分文字列の開始位置を from 以降で返す(無ければ -1)。
function indexOfAscii(bytes, str, from = 0) {
  const n = str.length;
  for (let i = Math.max(0, from); i + n <= bytes.length; i++) {
    let hit = true;
    for (let j = 0; j < n; j++) { if (bytes[i + j] !== str.charCodeAt(j)) { hit = false; break; } }
    if (hit) return i;
  }
  return -1;
}

const ISO8601 = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

// QuickTime レガシー udta の `date` アトム(ASCII "date" の直後に ISO8601 日時)から
// 撮影日時を拾う。creationdate を残さず date アトムに録画時刻を入れる書き出しがあるため。
// 誤検出防止のため「"date" の直後(数バイト以内)に ISO8601 が始まる」場合のみ採用する。
function findDateAtomMs(bytes) {
  let at = 0;
  while ((at = indexOfAscii(bytes, 'date', at)) >= 0) {
    const payloadStart = at + 4; // "date" の直後
    const end = Math.min(bytes.length, payloadStart + 8 + 32); // 小窓(先頭8B以内にISO開始)
    let s = '';
    for (let i = payloadStart; i < end; i++) s += String.fromCharCode(bytes[i]);
    const m = s.match(ISO8601);
    if (m && m.index <= 8) {
      const ms = Date.parse(m[0]);
      if (Number.isFinite(ms)) return ms;
    }
    at = payloadStart;
  }
  return null;
}

// 書き出し/DLしたMP4は mvhd.creation_time が「書き出し時刻」に化けることがある。
// Apple由来の動画は moov メタに元の撮影日時
//   com.apple.quicktime.creationdate (例 "2026-08-23T09:27:01+0900")
// を keys/ilst として残すことが多く、書き出し後も生きていれば本来の録画時刻が復元できる。
// creationdate キーの近傍から ISO8601 日時を1つ拾い Unix ms で返す(TZ付きは Date.parse が吸収)。
// キーが無ければ誤検出を避けるため null(裸の日付文字列は拾わない)。
export function findAppleCreationMs(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const key = indexOfAscii(bytes, 'creationdate');
  if (key >= 0) {
    // keys(キー名)の後、ilst(値)側に日時文字列が来る。近傍を広めに走査。
    const end = Math.min(bytes.length, key + 4096);
    let s = '';
    for (let i = key; i < end; i++) s += String.fromCharCode(bytes[i]);
    const m = s.match(ISO8601);
    if (m) {
      const ms = Date.parse(m[0]);
      if (Number.isFinite(ms)) return ms;
    }
  }
  // creationdate が無い/日時を取れない書き出しは udta `date` アトムを試す。
  return findDateAtomMs(bytes);
}

// ArrayBuffer から { creationMs, durationMs, appleCreationMs } を返す。取れなければ null。
// creationMs は mvhd(端末により意味が違う/書き出しで化ける)。appleCreationMs は元撮影日時(あれば信頼)。
export function parseMp4Times(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const moov = findBox(dv, 0, dv.byteLength, 'moov');
  if (!moov) return null;
  const mvhd = findBox(dv, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  const base = readMvhd(dv, mvhd.start);
  const appleCreationMs = findAppleCreationMs(arrayBuffer);
  if (!base && appleCreationMs == null) return null;
  return {
    creationMs: base?.creationMs ?? null,
    durationMs: base?.durationMs ?? null,
    appleCreationMs,
  };
}

// 後方互換: creation_time(Unix ms) のみ。
export function parseMp4CreationTime(arrayBuffer) {
  return parseMp4Times(arrayBuffer)?.creationMs ?? null;
}

// creation_time を「録画終了時刻」で書く端末か、ファイル名で判定する。
// iPhone は録画開始、Google Pixel(PXL_プレフィックス) は録画終了で書く実機確認済み。
export function isEndTimeDevice(name) {
  return /^PXL_/i.test(name || '');
}

// 埋め込みメタ({creationMs,durationMs}|null) とファイル名から録画開始(絶対ms)を求める。
// 端末で creation_time の意味が違うため name で分岐する:
//   - 終了時刻端末(Pixel): 開始 = 終了 − 長さ (長さ不明なら減算せず creation のまま)
//   - それ以外(iPhone等): creation_time がそのまま録画開始
// meta 無しは null。
export function embeddedStartMs(meta, name) {
  if (!meta) return null;
  // 元の撮影日時(Apple)が残っていれば最優先。書き出しで mvhd が化けても正しい録画開始が得られる。
  if (meta.appleCreationMs != null) return meta.appleCreationMs;
  if (isEndTimeDevice(name) && meta.durationMs != null) {
    return meta.creationMs - meta.durationMs;
  }
  return meta.creationMs;
}

// File/Blob からトップレベル box を辿り、moov box だけを部分読みして時刻を返す。
// 数GBの動画でも全読みせずに済む（mdat はサイズ分だけ seek で飛ばす）。
// 取れなければ null。File System Access API で得た File にそのまま使える。
export async function parseMp4TimesFromFile(file) {
  const size = file.size;
  let pos = 0;
  while (pos + 8 <= size) {
    const head = new DataView(await file.slice(pos, Math.min(pos + 16, size)).arrayBuffer());
    let boxSize = head.getUint32(0);
    const type = readType(head, 4);
    let headerSize = 8;
    if (boxSize === 1) { // 64bit largesize
      if (head.byteLength < 16) break;
      boxSize = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - pos; // 末尾まで
    }
    if (boxSize < headerSize || pos + boxSize > size) break; // 壊れている
    if (type === 'moov') return parseMp4Times(await file.slice(pos, pos + boxSize).arrayBuffer());
    pos += boxSize;
  }
  return null;
}
