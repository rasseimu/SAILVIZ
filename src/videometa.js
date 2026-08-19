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

// ArrayBuffer から { creationMs, durationMs } を返す。取れなければ null。
// 注意: creation_time はUTC想定だが端末により現地時刻で書かれ得る(TZは別途注意)。
export function parseMp4Times(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const moov = findBox(dv, 0, dv.byteLength, 'moov');
  if (!moov) return null;
  const mvhd = findBox(dv, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  return readMvhd(dv, mvhd.start);
}

// 後方互換: creation_time(Unix ms) のみ。
export function parseMp4CreationTime(arrayBuffer) {
  return parseMp4Times(arrayBuffer)?.creationMs ?? null;
}

// 埋め込みメタ({creationMs,durationMs}|null) から録画開始(絶対ms)を求める。
// creation_time は「録画開始時刻」として扱う(端末により終了時刻で書かれ得るが、
// 実機動画で確認した結果ずれの主因が duration の二重減算だったため減算しない)。
// meta 無しは null。
export function embeddedStartMs(meta) {
  if (!meta) return null;
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
