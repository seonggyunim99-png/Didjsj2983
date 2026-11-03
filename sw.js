// 서비스 워커: 오프라인 실행 + 다른 앱에서 '공유'로 보낸 사진 받기
const VERSION = 'v2.0.0';
const CACHE = `photo-vault-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/editor.js',
  './js/imaging.js',
  './js/library.js',
  './js/lock.js',
  './js/media.js',
  './js/scroller.js',
  './js/ui.js',
  './js/viewer.js',
  './js/zip.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('photo-vault-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* 공유 받은 파일을 앱이 열릴 때까지 맡겨두는 보관함 (js/db.js의 readInbox와 같은 구조) */
function openInbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('photo-vault-inbox', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) {
        req.result.createObjectStore('files', { keyPath: 'key', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function handleShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    const files = form.getAll('media').filter((f) => f && typeof f !== 'string');
    if (files.length) {
      const db = await openInbox();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        for (const f of files) {
          store.add({ file: f, name: f.name, type: f.type, lastModified: f.lastModified, at: Date.now() });
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }
    return Response.redirect(new URL(`./?shared=${files.length}#/photos`, scope).href, 303);
  } catch {
    return Response.redirect(new URL('./#/photos', scope).href, 303);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  // 앱 파일: 네트워크 우선(항상 최신), 오프라인이면 저장해 둔 사본 사용
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      }
      return response;
    } catch {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('오프라인 상태예요', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
