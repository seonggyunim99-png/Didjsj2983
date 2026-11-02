// 외부 라이브러리 없이 동작하는 ZIP 만들기/읽기
// - 만들기: 무압축(STORE). 사진·동영상은 이미 압축돼 있어서 빠르고 용량 차이도 거의 없습니다.
// - 읽기: 무압축과 일반 압축(DEFLATE) 모두 지원.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crc32Blob(blob, onBytes) {
  const CHUNK = 4 * 1024 * 1024;
  let crc = 0;
  for (let off = 0; off < blob.size; off += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    crc = crc32Update(crc, bytes);
    onBytes?.(bytes.length);
  }
  return crc;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(date, time) {
  const y = ((date >> 9) & 0x7f) + 1980;
  const mo = ((date >> 5) & 0x0f) - 1;
  const d = date & 0x1f;
  const t = new Date(y, mo, d || 1, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/** 한 파일이 넣을 수 있는 최대 크기 (ZIP64 미사용) */
export const ZIP_MAX_ENTRY = 0xffffffff - 1024;

/**
 * @param {{path:string, blob:Blob, mtime?:number}[]} entries
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function buildZip(entries, onProgress) {
  const enc = new TextEncoder();
  const body = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  const total = entries.reduce((s, e) => s + e.blob.size, 0);
  let processed = 0;

  for (const e of entries) {
    const name = enc.encode(e.path);
    const size = e.blob.size;
    const crc = await crc32Blob(e.blob, (n) => {
      processed += n;
      onProgress?.(processed, total);
    });
    const { time, date } = dosDateTime(e.mtime);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // 파일명 UTF-8
    lh.setUint16(8, 0, true); // STORE
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    body.push(lh.buffer, name, e.blob);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    centralSize += 46 + name.length;

    offset += 30 + name.length + size;
  }
  if (offset > 0xffffffff) throw new Error('ZIP 파일이 4GB를 넘을 수 없어요.');

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  onProgress?.(total, total);
  return new Blob([...body, ...central, eocd.buffer], { type: 'application/zip' });
}

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(bytes); // 윈도우에서 만든 한글 ZIP
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
}

/** ZIP 파일의 목록을 읽고, 항목별로 Blob을 꺼낼 수 있는 객체를 돌려줍니다. */
export async function openZip(file) {
  const size = file.size;
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
  let eo = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eo = i;
      break;
    }
  }
  if (eo < 0) throw new Error(`${file.name || '파일'}: ZIP 파일이 아니에요.`);

  const count = tail.getUint16(eo + 10, true);
  const cdSize = tail.getUint32(eo + 12, true);
  const cdOff = tail.getUint32(eo + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error(`${file.name || '파일'}: 4GB가 넘는 ZIP(ZIP64)은 지원하지 않아요.`);
  }

  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = decodeName(nameBytes, flags & 0x0800);
    entries.push({
      name,
      dir: name.endsWith('/'),
      encrypted: !!(flags & 1),
      method: cd.getUint16(p + 10, true),
      mtime: fromDos(cd.getUint16(p + 14, true), cd.getUint16(p + 12, true)),
      compressedSize: cd.getUint32(p + 20, true),
      size: cd.getUint32(p + 24, true),
      localOffset: cd.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function getBlob(entry, type = '') {
    if (entry.encrypted) throw new Error('암호가 걸린 ZIP 항목이에요.');
    const lh = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('손상된 ZIP 항목이에요.');
    const start = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(start, start + entry.compressedSize, type);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축된 ZIP을 풀 수 없어요.');
      const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const blob = await new Response(stream).blob();
      return type ? new Blob([blob], { type }) : blob;
    }
    throw new Error('지원하지 않는 압축 방식이에요.');
  }

  return { name: file.name, entries, getBlob };
}
