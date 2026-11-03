// 파일 형식 판별, 중복 확인용 해시, 촬영 날짜 읽기, 썸네일 생성

const IMAGE_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng', svg: 'image/svg+xml',
};
const VIDEO_EXT = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  '3gp': 'video/3gpp', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** 사진/동영상이면 MIME 타입을, 아니면 빈 문자열을 돌려줍니다. */
export function detectType(name, type) {
  if (type && (type.startsWith('image/') || type.startsWith('video/'))) return type;
  const ext = extOf(name);
  return IMAGE_EXT[ext] || VIDEO_EXT[ext] || '';
}

export function kindOf(type) {
  if (!type) return null;
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  return null;
}

/* ---------- 해시 (중복 사진 건너뛰기) ---------- */

const FULL_HASH_LIMIT = 64 * 1024 * 1024; // 64MB 이하는 전체, 그 이상은 일부 구간만
const SAMPLE = 4 * 1024 * 1024;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fnv1a(bytes, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export async function hashBlob(blob) {
  let bytes;
  if (blob.size <= FULL_HASH_LIMIT) {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    const mid = Math.floor(blob.size / 2) - SAMPLE / 2;
    const parts = await Promise.all([
      blob.slice(0, SAMPLE).arrayBuffer(),
      blob.slice(mid, mid + SAMPLE).arrayBuffer(),
      blob.slice(blob.size - SAMPLE).arrayBuffer(),
    ]);
    const head = new TextEncoder().encode(`size:${blob.size};`);
    bytes = new Uint8Array(head.length + SAMPLE * 3);
    bytes.set(head, 0);
    let off = head.length;
    for (const p of parts) {
      bytes.set(new Uint8Array(p), off);
      off += p.byteLength;
    }
  }
  if (globalThis.crypto?.subtle) {
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
  }
  // https가 아닌 환경(로컬 네트워크 등) 대비용 간이 해시
  const a = fnv1a(bytes).toString(16).padStart(8, '0');
  const b = fnv1a(bytes, 0x01234567).toString(16).padStart(8, '0');
  return `f${a}${b}${blob.size.toString(16)}`;
}

/* ---------- 촬영 날짜 ---------- */

function parseExifDateString(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m || +m[1] < 1971) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

const TIFF_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** TIFF(EXIF) 구조를 읽어 태그 값을 꺼낼 수 있게 합니다. */
function parseTiff(dv, start) {
  const le = dv.getUint16(start) === 0x4949;
  const u16 = (o) => dv.getUint16(start + o, le);
  const u32 = (o) => dv.getUint32(start + o, le);
  if (u16(2) !== 42) return null;

  const readIfd = (off) => {
    const tags = {};
    if (!off || start + off + 2 > dv.byteLength) return tags;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > dv.byteLength) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TIFF_SIZES[type] || 1) * count;
      tags[u16(e)] = { type, count, vo: size > 4 ? u32(e + 8) : e + 8 };
    }
    return tags;
  };
  const val = (t) => {
    if (!t) return undefined;
    const { type, count, vo } = t;
    if (type === 2) {
      let str = '';
      for (let i = 0; i < count && i < 128; i++) {
        const c = dv.getUint8(start + vo + i);
        if (!c) break;
        str += String.fromCharCode(c);
      }
      return str.trim();
    }
    const one = (k) => {
      switch (type) {
        case 1: case 7: return dv.getUint8(start + vo + k);
        case 3: return u16(vo + k * 2);
        case 4: return u32(vo + k * 4);
        case 5: return u32(vo + k * 8) / (u32(vo + k * 8 + 4) || 1);
        case 10: return dv.getInt32(start + vo + k * 8, le) / (dv.getInt32(start + vo + k * 8 + 4, le) || 1);
        default: return undefined;
      }
    };
    return count === 1 ? one(0) : Array.from({ length: Math.min(count, 8) }, (_, k) => one(k));
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(val(ifd0[0x8769])) : {};
  const gps = ifd0[0x8825] ? readIfd(val(ifd0[0x8825])) : {};
  return { ifd0, exif, gps, val };
}

async function readTiff(blob) {
  try {
    const dv = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (dv.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= dv.byteLength) {
      const marker = dv.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
      const len = dv.getUint16(off + 2);
      if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) return parseTiff(dv, off + 10);
      off += 2 + len;
    }
  } catch {
    /* 손상되었거나 EXIF가 없는 파일 */
  }
  return null;
}

/** JPEG의 EXIF에서 촬영 일시를 읽습니다. */
export async function readExifDate(blob) {
  const t = await readTiff(blob);
  if (!t) return null;
  return parseExifDateString(t.val(t.exif[0x9003]))
    || parseExifDateString(t.val(t.exif[0x9004]))
    || parseExifDateString(t.val(t.ifd0[0x0132]));
}

/** 사진 정보 화면용: 카메라, 렌즈, 촬영 설정, 위치 */
export async function readExifDetails(blob) {
  const t = await readTiff(blob);
  if (!t) return null;
  const { ifd0, exif, gps, val } = t;
  const out = {
    make: val(ifd0[0x010f]) || '',
    model: val(ifd0[0x0110]) || '',
    lens: val(exif[0xa434]) || '',
    fNumber: val(exif[0x829d]),
    exposure: val(exif[0x829a]),
    iso: val(exif[0x8827]),
    focal: val(exif[0x920a]),
    lat: null,
    lon: null,
  };
  if (Array.isArray(out.iso)) [out.iso] = out.iso;
  const dms = (v) => (Array.isArray(v) && v.length >= 3 ? v[0] + v[1] / 60 + v[2] / 3600 : null);
  const lat = dms(val(gps[2]));
  const lon = dms(val(gps[4]));
  if (lat !== null && lon !== null && (lat || lon)) {
    out.lat = val(gps[1]) === 'S' ? -lat : lat;
    out.lon = val(gps[3]) === 'W' ? -lon : lon;
  }
  return out;
}

/** MP4/MOV 동영상의 mvhd 상자에서 생성 일시를 읽습니다. */
export async function readVideoDate(blob) {
  const scan = async (start, end) => {
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    for (let i = 0; i + 20 < bytes.length; i++) {
      // 'mvhd'
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + i + 4);
        const version = dv.getUint8(0);
        const secs = version === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
        const ms = (secs - 2082844800) * 1000; // 1904년 기준 → 1970년 기준
        if (ms > Date.UTC(2000, 0, 1) && ms < Date.now() + 864e5) return ms;
        return null;
      }
    }
    return null;
  };
  try {
    const CH = 2 * 1024 * 1024;
    return (await scan(0, CH)) ?? (blob.size > CH ? await scan(Math.max(0, blob.size - CH * 2), blob.size) : null);
  } catch {
    return null;
  }
}

/* ---------- 썸네일 ---------- */

const THUMB_SHORT = 360; // 짧은 변 기준
const THUMB_LONG_MAX = 1080;

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.82) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

function drawScaled(source, w, h) {
  const scale = Math.min(1, THUMB_SHORT / Math.min(w, h), THUMB_LONG_MAX / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // 투명 PNG도 JPEG 썸네일로 깔끔하게
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, tw, th);
  return canvas;
}

export async function makeImageThumb(blob) {
  let source;
  let w;
  let h;
  try {
    source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    w = source.width;
    h = source.height;
  } catch {
    source = await loadImageElement(blob);
    w = source.naturalWidth;
    h = source.naturalHeight;
  }
  if (!w || !h) throw new Error('empty image');
  const canvas = drawScaled(source, w, h);
  source.close?.();
  const thumb = await canvasToBlob(canvas);
  return { thumb, width: w, height: h, duration: 0 };
}

export function makeVideoThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const meta = () => ({
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    });
    const timer = setTimeout(() => finish({ thumb: null, ...meta() }), 12000);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => finish({ thumb: null, width: 0, height: 0, duration: 0 });
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      try {
        video.currentTime = Math.max(0.1, Math.min(1, d / 3));
      } catch {
        finish({ thumb: null, ...meta() });
      }
    };
    video.onseeked = async () => {
      const m = meta();
      if (!m.width || !m.height) return finish({ thumb: null, ...m });
      try {
        const canvas = drawScaled(video, m.width, m.height);
        finish({ thumb: await canvasToBlob(canvas), ...m });
      } catch {
        finish({ thumb: null, ...m });
      }
    };
    video.src = url;
  });
}
