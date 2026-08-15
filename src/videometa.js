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

function readMvhdCreation(dv, payloadStart) {
  const version = dv.getUint8(payloadStart);
  const p = payloadStart + 4; // version(1)+flags(3) をスキップ
  const creation = version === 1
    ? dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4)
    : dv.getUint32(p);
  if (!creation) return null; // 0 は未設定扱い
  const unixSec = creation - MAC_EPOCH_OFFSET;
  return unixSec > 0 ? unixSec * 1000 : null;
}

// ArrayBuffer を受け取り、撮影時刻(Unix ms) を返す。取れなければ null。
// 注意: creation_time はUTC想定だが、端末によっては現地時刻で書かれ tz ぶんズレ得る。
export function parseMp4CreationTime(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const moov = findBox(dv, 0, dv.byteLength, 'moov');
  if (!moov) return null;
  const mvhd = findBox(dv, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;
  return readMvhdCreation(dv, mvhd.start);
}
