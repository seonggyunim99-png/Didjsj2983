// 보관함 상태와 동작(가져오기, 즐겨찾기, 휴지통, 앨범, 백업 내보내기/복원)
import * as db from './db.js';
import {
  detectType, kindOf, hashBlob, readExifDate, readVideoDate, makeImageThumb, makeVideoThumb, extOf,
} from './media.js';
import { buildZip, openZip, ZIP_MAX_ENTRY } from './zip.js';

export const TRASH_DAYS = 30;
const DAY = 864e5;

export const store = {
  loaded: false,
  media: [], // 최신순 정렬
  albums: [],
  byId: new Map(),
  lastExportAt: null,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn();
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function reindex() {
  store.media.sort((a, b) => b.takenAt - a.takenAt || b.addedAt - a.addedAt);
  store.byId = new Map(store.media.map((m) => [m.id, m]));
  store.albums.sort((a, b) => a.createdAt - b.createdAt);
}

export async function load() {
  const [media, albums, lastExportAt] = await Promise.all([
    db.getAllMedia(), db.getAllAlbums(), db.getMeta('lastExportAt'),
  ]);
  store.media = media;
  store.albums = albums;
  store.lastExportAt = lastExportAt;
  reindex();
  // 30일 지난 휴지통 항목 정리
  const limit = Date.now() - TRASH_DAYS * DAY;
  const expired = store.media.filter((m) => m.deletedAt && m.deletedAt < limit).map((m) => m.id);
  if (expired.length) await deleteForever(expired, false);
  store.loaded = true;
  emit();
}

/* ---------- 조회 ---------- */

export const activeMedia = () => store.media.filter((m) => !m.deletedAt);
export const trashedMedia = () => store.media.filter((m) => m.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
export const albumMedia = (albumId) => activeMedia().filter((m) => m.albums.includes(albumId));
export const getAlbum = (id) => store.albums.find((a) => a.id === id) || null;
export const getOriginal = (id) => db.getBlob(id);

export function daysLeft(m) {
  return Math.max(0, Math.ceil((m.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY));
}

export function totals(list) {
  let photos = 0;
  let videos = 0;
  let bytes = 0;
  let originalBytes = 0;
  let edited = 0;
  for (const m of list) {
    if (m.kind === 'video') videos++;
    else photos++;
    bytes += m.size;
    if (m.edited) {
      edited++;
      originalBytes += m.originalSize || 0;
    }
  }
  return { photos, videos, bytes, originalBytes, edited, count: list.length };
}

/* ---------- 가져오기 (백업) ---------- */

/**
 * @param {{blob?:Blob, load?:()=>Promise<Blob>, name:string, type?:string, lastModified?:number,
 *          takenAt?:number, favorite?:boolean, albumIds?:string[], albumNames?:string[],
 *          fromBackup?:boolean}[]} items
 * @param {(done:number,total:number,name?:string)=>void} onProgress
 */
export async function importFiles(items, onProgress, shouldStop = () => false) {
  const result = { added: 0, duplicates: 0, restored: 0, skipped: 0, failed: 0, quota: false, stopped: false };
  const albumCache = new Map();
  let lastEmit = performance.now();

  for (let i = 0; i < items.length; i++) {
    if (shouldStop()) {
      result.stopped = true;
      break;
    }
    const it = items[i];
    onProgress?.(i, items.length, it.name);
    try {
      const type = detectType(it.name, it.type || it.blob?.type);
      const kind = kindOf(type);
      if (!kind) {
        result.skipped++;
        continue;
      }
      let blob = it.blob || (await it.load());
      if (blob.type !== type) blob = new Blob([blob], { type });
      const hash = await hashBlob(blob);
      const albumIds = [...(it.albumIds || []), ...(await albumIdsByName(it.albumNames, albumCache))];

      const existing = await db.findByHash(hash);
      if (existing) {
        const rec = store.byId.get(existing.id) || existing;
        let changed = false;
        if (rec.deletedAt) {
          rec.deletedAt = null;
          changed = true;
          result.restored++;
        } else {
          result.duplicates++;
        }
        if (it.favorite && !rec.favorite) {
          rec.favorite = true;
          changed = true;
        }
        for (const a of albumIds) {
          if (!rec.albums.includes(a)) {
            rec.albums.push(a);
            changed = true;
          }
        }
        if (changed) await db.putMedia(rec);
        continue;
      }

      let takenAt = it.takenAt || null;
      if (!takenAt) takenAt = kind === 'image' ? await readExifDate(blob) : await readVideoDate(blob);
      if (!takenAt) takenAt = it.lastModified || Date.now();

      let info = null;
      try {
        info = kind === 'image' ? await makeImageThumb(blob) : await makeVideoThumb(blob);
      } catch {
        info = null; // 브라우저가 열 수 없는 형식(HEIC 등)도 원본은 그대로 보관
      }

      const now = Date.now();
      const rec = {
        id: uid(),
        hash,
        name: it.name || `${kind}-${now}.${extOf(it.name) || 'bin'}`,
        type,
        kind,
        size: blob.size,
        width: info?.width || 0,
        height: info?.height || 0,
        duration: info?.duration || 0,
        takenAt,
        addedAt: now,
        favorite: !!it.favorite,
        albums: [...new Set(albumIds)],
        deletedAt: null,
        exportedAt: it.fromBackup ? now : null,
        thumb: info?.thumb || null,
      };
      await db.addMedia(rec, blob);
      store.media.push(rec);
      store.byId.set(rec.id, rec);
      result.added++;
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        result.quota = true;
        break;
      }
      console.error('가져오기 실패', it.name, err);
      result.failed++;
    }

    if (performance.now() - lastEmit > 1500) {
      reindex();
      emit();
      lastEmit = performance.now();
    }
  }

  onProgress?.(items.length, items.length);
  reindex();
  emit();
  return result;
}

/* ---------- 편집 ---------- */

function records(ids) {
  return ids.map((id) => store.byId.get(id)).filter(Boolean);
}

export async function setFavorite(ids, value) {
  const list = records(ids);
  list.forEach((m) => { m.favorite = value; });
  await db.putMedia(list);
  emit();
}

export async function moveToTrash(ids) {
  const now = Date.now();
  const list = records(ids);
  list.forEach((m) => { m.deletedAt = now; });
  await db.putMedia(list);
  emit();
}

export async function restore(ids) {
  const list = records(ids);
  list.forEach((m) => { m.deletedAt = null; });
  await db.putMedia(list);
  emit();
}

export async function deleteForever(ids, notify = true) {
  await db.deleteMedia(ids);
  const gone = new Set(ids);
  store.media = store.media.filter((m) => !gone.has(m.id));
  reindex();
  if (notify) emit();
}

/* ---------- 사진 편집 ---------- */

function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
}
const extFor = (type) => (type === 'image/png' ? 'png' : 'jpg');

/**
 * 편집 결과를 저장합니다.
 * - 덮어쓰기: 처음 편집할 때의 원본을 따로 보관해서 '원본으로 되돌리기'가 가능해요.
 * - 사본: 원본은 그대로 두고 같은 촬영 일시의 새 사진을 만들어요.
 */
export async function saveEdit(id, blob, { asCopy = false } = {}) {
  const m = store.byId.get(id);
  if (!m) throw new Error('사진을 찾을 수 없어요');
  const info = await makeImageThumb(blob);
  const now = Date.now();
  if (asCopy) {
    const hash = await hashBlob(blob);
    const existing = await db.findByHash(hash);
    if (existing) return store.byId.get(existing.id) || existing;
    const [base] = splitName(m.originalName || m.name);
    const rec = {
      id: uid(),
      hash,
      name: `${base}_edit.${extFor(blob.type)}`,
      type: blob.type,
      kind: 'image',
      size: blob.size,
      width: info.width,
      height: info.height,
      duration: 0,
      takenAt: m.takenAt,
      addedAt: now,
      favorite: false,
      albums: [...m.albums],
      deletedAt: null,
      exportedAt: null,
      thumb: info.thumb,
      editedAt: now,
    };
    await db.addMedia(rec, blob);
    store.media.push(rec);
    reindex();
    emit();
    return rec;
  }
  const first = !m.edited;
  await db.replaceBlob(id, blob, first);
  if (first) {
    m.originalSize = m.size;
    m.originalType = m.type;
    m.originalName = m.name;
  }
  const [base] = splitName(m.originalName || m.name);
  Object.assign(m, {
    size: blob.size,
    type: blob.type,
    name: `${base}.${extFor(blob.type)}`,
    width: info.width,
    height: info.height,
    thumb: info.thumb,
    edited: true,
    editedAt: now,
    exportedAt: null,
  });
  await db.putMedia(m);
  emit();
  return m;
}

export async function revertEdit(id) {
  const m = store.byId.get(id);
  if (!m?.edited) return false;
  const orig = await db.getBlob(`orig:${id}`);
  if (!orig) return false;
  let info = null;
  try {
    info = await makeImageThumb(orig);
  } catch {
    info = null;
  }
  await db.restoreOriginal(id);
  Object.assign(m, {
    size: orig.size,
    type: m.originalType || orig.type,
    name: m.originalName || m.name,
    width: info?.width || m.width,
    height: info?.height || m.height,
    thumb: info?.thumb || m.thumb,
    edited: false,
    editedAt: null,
    exportedAt: null,
    originalSize: 0,
  });
  delete m.originalType;
  delete m.originalName;
  await db.putMedia(m);
  emit();
  return true;
}

/** 사진 정보(EXIF)는 편집 전 원본에서 읽습니다. */
export async function getExifSource(id) {
  return (await db.getBlob(`orig:${id}`)) || db.getBlob(id);
}

export async function setTakenAt(ids, ms) {
  const list = records(ids);
  list.forEach((m) => { m.takenAt = ms; });
  await db.putMedia(list);
  reindex();
  emit();
}

export async function setAlbumCover(albumId, mediaId) {
  const album = getAlbum(albumId);
  if (!album) return;
  album.coverId = mediaId;
  await db.putAlbum(album);
  emit();
}

/** 모든 데이터를 지웁니다 (되돌릴 수 없음). */
export async function wipeAll() {
  await db.destroyAll();
}

/* ---------- 앨범 ---------- */

export async function createAlbum(name) {
  const album = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await db.putAlbum(album);
  store.albums.push(album);
  reindex();
  emit();
  return album;
}

export async function renameAlbum(id, name) {
  const album = getAlbum(id);
  if (!album) return;
  album.name = name.trim();
  await db.putAlbum(album);
  emit();
}

export async function deleteAlbum(id) {
  const changed = store.media.filter((m) => m.albums.includes(id));
  changed.forEach((m) => { m.albums = m.albums.filter((a) => a !== id); });
  await db.putMedia(changed);
  await db.deleteAlbum(id);
  store.albums = store.albums.filter((a) => a.id !== id);
  emit();
}

export async function addToAlbum(albumId, ids) {
  const list = records(ids).filter((m) => !m.albums.includes(albumId));
  list.forEach((m) => m.albums.push(albumId));
  await db.putMedia(list);
  emit();
  return list.length;
}

export async function removeFromAlbum(albumId, ids) {
  const list = records(ids).filter((m) => m.albums.includes(albumId));
  list.forEach((m) => { m.albums = m.albums.filter((a) => a !== albumId); });
  await db.putMedia(list);
  emit();
}

async function albumIdsByName(names, cache) {
  const ids = [];
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (!name) continue;
    let id = cache.get(name);
    if (!id) {
      const existing = store.albums.find((a) => a.name === name);
      id = existing ? existing.id : (await createAlbum(name)).id;
      cache.set(name, id);
    }
    ids.push(id);
  }
  return ids;
}

/* ---------- 백업 파일(ZIP) ---------- */

export const MANIFEST_NAME = 'photo-vault.json';
const PART_LIMIT = 1024 * 1024 * 1024; // 파일 하나당 약 1GB

/** 내보낼 항목을 1GB 단위 파트로 나눕니다. */
export function planExport(items) {
  const parts = [];
  const tooLarge = [];
  let cur = [];
  let curSize = 0;
  // 오래된 것부터 담아야 파트 번호가 시간 순서가 됩니다.
  const ordered = [...items].sort((a, b) => a.takenAt - b.takenAt);
  for (const m of ordered) {
    if (m.size > ZIP_MAX_ENTRY) {
      tooLarge.push(m);
      continue;
    }
    if (cur.length && (curSize + m.size > PART_LIMIT || cur.length >= 60000)) {
      parts.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(m);
    curSize += m.size;
  }
  if (cur.length) parts.push(cur);
  return { parts, tooLarge };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function safeName(name) {
  return (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120);
}

/** 사진 목록으로 ZIP을 만듭니다. withManifest면 복원용 정보 파일도 함께 넣습니다. */
export async function buildArchive(items, { withManifest = true, part = 1, parts = 1 } = {}, onProgress) {
  const used = new Set();
  const entries = [];
  const manifestItems = [];
  for (const m of items) {
    const d = new Date(m.takenAt);
    const folder = withManifest ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}/` : '';
    let base = safeName(m.name);
    let path = folder + base;
    let n = 2;
    while (used.has(path.toLowerCase())) {
      const dot = base.lastIndexOf('.');
      const alt = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
      path = folder + alt;
      n++;
    }
    used.add(path.toLowerCase());
    const blob = await db.getBlob(m.id);
    if (!blob) continue;
    entries.push({ path, blob, mtime: m.takenAt });
    manifestItems.push({
      path,
      name: m.name,
      type: m.type,
      takenAt: m.takenAt,
      addedAt: m.addedAt,
      favorite: !!m.favorite,
      albums: m.albums.map((id) => getAlbum(id)?.name).filter(Boolean),
      hash: m.hash,
    });
  }
  if (withManifest) {
    const manifest = {
      app: 'photo-vault',
      format: 1,
      exportedAt: new Date().toISOString(),
      part,
      parts,
      items: manifestItems,
    };
    entries.push({
      path: MANIFEST_NAME,
      blob: new Blob([JSON.stringify(manifest, null, 1)], { type: 'application/json' }),
      mtime: Date.now(),
    });
  }
  return buildZip(entries, onProgress);
}

export async function markExported(ids) {
  const now = Date.now();
  const list = records(ids);
  list.forEach((m) => { m.exportedAt = now; });
  await db.putMedia(list);
  store.lastExportAt = now;
  await db.setMeta('lastExportAt', now);
  emit();
}

/** 백업 ZIP 파일들을 읽어 가져오기 목록을 만듭니다. */
export async function readBackupFiles(files) {
  const items = [];
  const errors = [];
  for (const file of files) {
    try {
      const zip = await openZip(file);
      const manEntry = zip.entries.find((e) => e.name === MANIFEST_NAME || e.name.endsWith(`/${MANIFEST_NAME}`));
      const meta = new Map();
      if (manEntry) {
        try {
          const manifest = JSON.parse(await (await zip.getBlob(manEntry)).text());
          const prefix = manEntry.name.slice(0, manEntry.name.length - MANIFEST_NAME.length);
          for (const it of manifest.items || []) meta.set(prefix + it.path, it);
        } catch {
          /* 정보 파일이 깨졌으면 사진만 가져옵니다 */
        }
      }
      for (const entry of zip.entries) {
        if (entry.dir || entry === manEntry || entry.encrypted) continue;
        const base = entry.name.split('/').pop();
        if (!base || base.startsWith('.') || entry.name.startsWith('__MACOSX/')) continue;
        const info = meta.get(entry.name);
        const type = detectType(base, info?.type);
        if (!kindOf(type)) continue;
        items.push({
          name: info?.name || base,
          type,
          size: entry.size,
          lastModified: entry.mtime,
          takenAt: info?.takenAt || null,
          favorite: !!info?.favorite,
          albumNames: Array.isArray(info?.albums) ? info.albums : [],
          fromBackup: !!info,
          load: () => zip.getBlob(entry, type),
        });
      }
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  return { items, errors };
}
