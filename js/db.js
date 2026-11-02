// IndexedDB 저장소: 사진 메타데이터, 원본 파일, 앨범, 설정값을 보관합니다.
const DB_NAME = 'photo-vault';
const DB_VERSION = 1;

// 공유하기(Share Target)로 들어온 파일을 서비스 워커가 잠시 맡겨두는 별도 DB
const INBOX_NAME = 'photo-vault-inbox';

let dbPromise = null;

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('media')) {
          const media = db.createObjectStore('media', { keyPath: 'id' });
          media.createIndex('hash', 'hash', { unique: true });
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('albums')) db.createObjectStore('albums', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAllMedia() {
  return wrap((await store('media')).getAll());
}

export async function getAllAlbums() {
  return wrap((await store('albums')).getAll());
}

export async function findByHash(hash) {
  return wrap((await store('media')).index('hash').get(hash));
}

export async function getBlob(id) {
  const row = await wrap((await store('blobs')).get(id));
  return row ? row.blob : null;
}

/** 새 항목과 원본 파일을 하나의 트랜잭션으로 저장 */
export async function addMedia(record, blob) {
  const db = await openDB();
  const tx = db.transaction(['media', 'blobs'], 'readwrite');
  tx.objectStore('media').add(record);
  tx.objectStore('blobs').put({ id: record.id, blob });
  return done(tx);
}

export async function putMedia(records) {
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return;
  const db = await openDB();
  const tx = db.transaction('media', 'readwrite');
  const s = tx.objectStore('media');
  for (const r of list) s.put(r);
  return done(tx);
}

export async function deleteMedia(ids) {
  if (!ids.length) return;
  const db = await openDB();
  const tx = db.transaction(['media', 'blobs'], 'readwrite');
  const media = tx.objectStore('media');
  const blobs = tx.objectStore('blobs');
  for (const id of ids) {
    media.delete(id);
    blobs.delete(id);
  }
  return done(tx);
}

export async function putAlbum(album) {
  const db = await openDB();
  const tx = db.transaction('albums', 'readwrite');
  tx.objectStore('albums').put(album);
  return done(tx);
}

export async function deleteAlbum(id) {
  const db = await openDB();
  const tx = db.transaction('albums', 'readwrite');
  tx.objectStore('albums').delete(id);
  return done(tx);
}

export async function getMeta(key, fallback = null) {
  const row = await wrap((await store('meta')).get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  return done(tx);
}

/* ---------- 공유 받은 파일 임시 보관함 (sw.js와 같은 구조) ---------- */

function openInbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INBOX_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) {
        req.result.createObjectStore('files', { keyPath: 'key', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readInbox() {
  const db = await openInbox();
  try {
    return await wrap(db.transaction('files').objectStore('files').getAll());
  } finally {
    db.close();
  }
}

export async function clearInbox(keys) {
  const db = await openInbox();
  try {
    const tx = db.transaction('files', 'readwrite');
    const s = tx.objectStore('files');
    for (const k of keys) s.delete(k);
    await done(tx);
  } finally {
    db.close();
  }
}
