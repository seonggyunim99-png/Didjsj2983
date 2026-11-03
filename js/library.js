// 보관함 상태와 동작(가져오기, 즐겨찾기, 휴지통, 앨범, 백업 내보내기/복원)
import * as db from './db.js';
import {
  detectType, kindOf, hashBlob, readExifDate, readVideoDate, makeImageThumb, makeVideoThumb, extOf,
} from './media.js';
import { buildZip, openZip, ZIP_MAX_ENTRY } from './zip.js';
import { statsFromBlob, STATS_VERSION } from './imaging.js';

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

/** 휴지통이 아닌 모든 항목 (숨긴 항목 포함 — 백업용) */
export const activeMedia = () => store.media.filter((m) => !m.deletedAt);
/** 화면에 보여줄 항목 (숨긴 항목 제외) */
export const visibleMedia = () => store.media.filter((m) => !m.deletedAt && !m.hidden);
export const hiddenMedia = () => store.media.filter((m) => !m.deletedAt && m.hidden);
export const trashedMedia = () => store.media.filter((m) => m.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
export const albumMedia = (albumId) => visibleMedia().filter((m) => m.albums.includes(albumId));
export const isScreenshot = (m) => /screenshot|스크린샷|screen_?shot|캡처|capture/i.test(m.name);
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
        hidden: !!it.hidden,
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
/**
 * 다시 편집할 때 쓸 원본과 편집 값 (저장할 때 함께 보관해 둔 경우)
 * @returns {Promise<{blob:Blob, type:string, state:object, baseId:string}|null>}
 */
export async function getEditBase(m) {
  if (!m?.editState || !m.editBase) return null;
  const src = store.byId.get(m.editBase);
  if (!src) return null;
  const blob = src.edited ? await db.getBlob(`orig:${src.id}`) : await db.getBlob(src.id);
  if (!blob) return null;
  return { blob, type: src.originalType || src.type, state: m.editState, baseId: src.id };
}

/**
 * 편집한 사진 저장
 * @param state 편집 값 (다시 편집할 수 있게 보관), baseId 편집을 시작한 원본 사진 (원본이 바뀌지 않는 경우만)
 */
export async function saveEdit(id, blob, { asCopy = false, state = null, baseId = null } = {}) {
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
      copyOf: m.copyOf || m.id, // 원본과 그 사본은 '비슷한 사진'으로 묶지 않음
      editState: state && baseId ? state : null,
      editBase: state && baseId ? baseId : null,
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
    stats: null,
    editState: state && baseId ? state : null,
    editBase: state && baseId ? baseId : null,
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
    stats: null,
    editState: null,
    editBase: null,
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

/* ---------- 숨긴 항목 ---------- */

export async function setHidden(ids, value) {
  const list = records(ids);
  list.forEach((m) => { m.hidden = value; });
  await db.putMedia(list);
  emit();
}

/* ---------- 사진 분석 (보정 추천 · 정리 도우미) ---------- */

export const analysis = { running: false, done: 0, total: 0 };
let analysisRun = null;

const needsStats = (m) => m.kind === 'image' && m.thumb && !m.deletedAt && (!m.stats || m.stats.v !== STATS_VERSION);

/** 아직 분석하지 않은 사진을 조금씩 분석합니다. onTick(analysis)로 진행 상황을 알려줘요. */
export function ensureStats(onTick) {
  if (analysisRun) return analysisRun;
  const todo = store.media.filter(needsStats);
  if (!todo.length) return Promise.resolve(false);
  Object.assign(analysis, { running: true, done: 0, total: todo.length });
  analysisRun = (async () => {
    let pending = [];
    for (const m of todo) {
      try {
        if (needsStats(m)) {
          m.stats = await statsFromBlob(m.thumb);
          pending.push(m);
        }
      } catch {
        m.stats = { v: STATS_VERSION, failed: true };
      }
      analysis.done++;
      if (pending.length >= 25) {
        await db.putMedia(pending);
        pending = [];
        onTick?.(analysis);
      }
      // 화면이 멈추지 않게 조금씩 쉬어 갑니다
      if (analysis.done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (pending.length) await db.putMedia(pending);
    analysis.running = false;
    analysisRun = null;
    onTick?.(analysis);
    emit();
    return true;
  })();
  return analysisRun;
}

const goodStats = (m) => m.kind === 'image' && m.stats && !m.stats.failed && m.stats.v === STATS_VERSION;

/** 보정하면 좋아질 사진 묶음 */
export function enhanceSuggestions() {
  const cats = { dark: [], bright: [], flat: [], cast: [] };
  for (const m of visibleMedia()) {
    if (!goodStats(m) || m.edited || m.copyOf || isScreenshot(m) || m.type === 'image/png') continue;
    const s = m.stats;
    if (s.p50 < 0.3 && s.mean < 0.34) cats.dark.push(m);
    else if (s.p50 > 0.82 || s.highClip > 0.3) cats.bright.push(m);
    else if (s.p95 - s.p05 < 0.3 && s.p05 > 0.18) cats.flat.push(m); // 검은 부분이 들뜨고 대비가 약한 뿌연 사진
    else if ((Math.abs(s.castRB) > 0.18 || Math.abs(s.castG) > 0.15) && s.chroma < 0.5) cats.cast.push(m);
  }
  return cats;
}

/** 선명함을 대비로 나눠서, 대비가 낮을 뿐인 사진과 정말 흐린 사진을 구분합니다. */
const focus = (s) => s.sharp / Math.max(0.05, s.p95 - s.p05) ** 2;
const BLUR_LIMIT = 400;
export const blurryMedia = () => visibleMedia()
  .filter((m) => goodStats(m) && !isScreenshot(m) && m.stats.p95 - m.stats.p05 > 0.15 && focus(m.stats) < BLUR_LIMIT)
  .sort((a, b) => focus(a.stats) - focus(b.stats));
export const screenshotMedia = () => visibleMedia().filter(isScreenshot);
export const LARGE_VIDEO = 50 * 1024 * 1024;
export const largeVideos = () => visibleMedia().filter((m) => m.kind === 'video' && m.size >= LARGE_VIDEO).sort((a, b) => b.size - a.size);

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/**
 * 비슷한 사진 묶음. 가까운 시간(2시간 안)에 찍었고 모양이 거의 같은 사진끼리 묶어요.
 * (연속 촬영처럼 1분 안에 찍은 사진은 기준을 조금 넉넉하게)
 * 각 묶음의 첫 번째가 가장 선명하고 큰 '추천 보관' 사진입니다.
 */
export function similarGroups() {
  const list = visibleMedia().filter((m) => goodStats(m) && m.stats.ph).sort((a, b) => a.takenAt - b.takenAt);
  const parent = list.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const WINDOW = 2 * 3600e3;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j].takenAt - list[i].takenAt <= WINDOW; j++) {
      // 1분 안에 연달아 찍은 사진은 조금 더 너그럽게, 그 외에는 거의 같은 사진만 묶음
      const a = list[i];
      const b = list[j];
      if (a.copyOf === b.id || b.copyOf === a.id || (a.copyOf && a.copyOf === b.copyOf)) continue; // 직접 만든 사본
      const limit = b.takenAt - a.takenAt <= 60e3 ? 12 : 6;
      if (hamming(a.stats.ph, b.stats.ph) <= limit) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  list.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });
  const score = (m) => m.stats.sharp * Math.sqrt((m.width * m.height) || 1) + (m.favorite ? 1e12 : 0);
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => score(b) - score(a)))
    .sort((a, b) => b[0].takenAt - a[0].takenAt);
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
      hidden: !!m.hidden,
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
          hidden: !!info?.hidden,
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
