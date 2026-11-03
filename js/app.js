// 사진 보관함 — 앱 화면과 사용자 동작
import * as lib from './library.js';
import { store } from './library.js';
import { readInbox, clearInbox } from './db.js';
import { detectType, kindOf, extOf, readExifDetails } from './media.js';
import {
  icon, esc, fmtNum, fmtBytes, fmtDuration, fmtDay, fmtDateTime, fmtCounts, dayKey,
  toast, openModal, confirmDialog, promptDialog, actionSheet, progress, downloadBlob, isModalOpen,
  dateTimeDialog,
} from './ui.js';
import { Viewer } from './viewer.js';
import { Editor } from './editor.js';
import * as lock from './lock.js';
import { createScroller } from './scroller.js';

const APP_VERSION = '2.0';

const $ = (s, root = document) => root.querySelector(s);
const appbar = $('#appbar');
const main = $('#main');
const tabbar = $('#tabbar');
const selbar = $('#selbar');
const fileInput = $('#file-input');
const folderInput = $('#folder-input');
const zipInput = $('#zip-input');
const dropOverlay = $('#drop-overlay');

const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canPickFolder = 'webkitdirectory' in document.createElement('input') && !isTouch;

/* ---------- 설정 ---------- */

const GRID_SIZES = { s: '작게', m: '보통', l: '크게' };
const GRID_ORDER = ['s', 'm', 'l'];
const THEMES = { system: '시스템 설정', light: '밝게', dark: '어둡게' };
const prefs = { grid: 'm', theme: 'system' };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('pv-prefs') || '{}'));
} catch {
  /* 저장소를 쓸 수 없는 환경 */
}
function savePrefs() {
  try {
    localStorage.setItem('pv-prefs', JSON.stringify(prefs));
  } catch {
    /* 무시 */
  }
}
document.documentElement.dataset.grid = GRID_SIZES[prefs.grid] ? prefs.grid : 'm';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = THEMES[prefs.theme] ? prefs.theme : 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute('media');
    m.content = dark ? '#101114' : '#ffffff';
  });
}
applyTheme();
darkQuery.addEventListener?.('change', applyTheme);

/* ---------- 상태 ---------- */

let route = parseRoute();
let list = []; // 지금 화면에 보이는 사진 목록(표시 순서)
const sel = { active: false, ids: new Set(), anchor: -1 };
let viewer = null;
let lastViewedId = null;
let busy = 0;
let importChain = Promise.resolve();
let uploadAlbumId = null;
let installEvent = null;
let navigatedInApp = false;
let askedPersist = false;
let editor = null;
let searchQuery = '';
const scrollMemory = new Map();
const scroller = createScroller({
  topInset: () => Math.max(0, appbar.getBoundingClientRect().bottom),
  bottomInset: () => (window.innerWidth >= 900 ? 16 : tabbar.offsetHeight + 8),
});

/* ---------- 뒤로가기(안드로이드 뒤로 버튼) 처리 ---------- */

const layers = [];
let popping = false;

function pushLayer(close) {
  layers.push(close);
  history.pushState({ pvLayer: layers.length }, '');
}

function popLayer() {
  if (!layers.length || popping) return;
  popping = true;
  history.back();
}

function closeLayersSilently() {
  while (layers.length) layers.pop()();
}

window.addEventListener('popstate', () => {
  popping = false;
  const close = layers.pop();
  close?.();
});

/* ---------- 라우팅 ---------- */

function parseRoute() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'album' && id) return { name: 'album', id: decodeURIComponent(id) };
  if (['photos', 'albums', 'favorites', 'videos', 'trash', 'backup', 'search', 'settings'].includes(name)) return { name };
  return { name: 'photos' };
}

const routeKey = (r) => r.name + (r.id ? `/${r.id}` : '');
const TAB_OF = {
  photos: 'photos', search: 'photos', albums: 'albums', album: 'albums', favorites: 'albums', videos: 'albums', trash: 'albums',
  backup: 'backup', settings: 'backup',
};
const isGalleryRoute = () => ['photos', 'favorites', 'videos', 'album', 'trash', 'search'].includes(route.name);

window.addEventListener('hashchange', () => {
  scrollMemory.set(routeKey(route), window.scrollY);
  navigatedInApp = true;
  closeLayersSilently();
  route = parseRoute();
  render();
  window.scrollTo(0, scrollMemory.get(routeKey(route)) || 0);
});

function goBack() {
  if (navigatedInApp) history.back();
  else location.replace(route.name === 'search' ? '#/photos' : route.name === 'settings' ? '#/backup' : '#/albums');
}

/* ---------- 썸네일 ---------- */

const thumbUrls = new Map();

function cachedThumb(m) {
  const c = thumbUrls.get(m.id);
  return c && c.blob === m.thumb ? c.url : null;
}

function thumbURL(m) {
  if (!m?.thumb) return null;
  const cached = cachedThumb(m);
  if (cached) return cached;
  const old = thumbUrls.get(m.id);
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(m.thumb);
  thumbUrls.set(m.id, { blob: m.thumb, url });
  return url;
}

function cleanupThumbs() {
  for (const [id, c] of thumbUrls) {
    const m = store.byId.get(id);
    if (!m || m.thumb !== c.blob) {
      URL.revokeObjectURL(c.url);
      thumbUrls.delete(id);
    }
  }
}

function createThumbLoader() {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const tile = entry.target;
      io.unobserve(tile);
      const m = store.byId.get(tile.dataset.id);
      const img = tile.querySelector('img');
      if (!m || !img || img.getAttribute('src')) continue;
      const done = () => tile.classList.add('loaded');
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      img.src = thumbURL(m);
    }
  }, { rootMargin: '800px 0px' });
  return {
    observe(root) {
      root.querySelectorAll('.tile:not(.loaded)').forEach((t) => io.observe(t));
    },
    reset() {
      io.disconnect();
    },
  };
}
const mainThumbs = createThumbLoader();

/* ---------- 목록 ---------- */

function computeList() {
  switch (route.name) {
    case 'photos': return lib.activeMedia();
    case 'favorites': return lib.activeMedia().filter((m) => m.favorite);
    case 'videos': return lib.activeMedia().filter((m) => m.kind === 'video');
    case 'album': return lib.albumMedia(route.id);
    case 'trash': return lib.trashedMedia();
    case 'search': return searchMedia(searchQuery);
    default: return [];
  }
}

/* ---------- 검색 ---------- */

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

function searchText(m) {
  const d = new Date(m.takenAt);
  const albums = m.albums.map((a) => lib.getAlbum(a)?.name || '').join(' ');
  const shot = /screenshot|스크린샷|screen_?shot|캡처/i.test(m.name);
  return ` ${m.name} ${albums} ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일 `
    + `${m.kind === 'video' ? '동영상 비디오 video' : '사진 photo'} ${m.favorite ? '즐겨찾기' : ''} `
    + `${m.edited || m.editedAt ? '편집 편집한' : ''} ${shot ? '스크린샷 screenshot' : ''} ${m.type} `.toLowerCase();
}

function searchMedia(q) {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const year = new Date().getFullYear();
  const norm = tokens.map((t) => {
    if (t === '올해') return ` ${year}년`;
    if (t === '작년') return ` ${year - 1}년`;
    if (/^\d{4}$/.test(t)) return ` ${t}년`;
    if (/^\d+(년|월|일)$/.test(t)) return ` ${t}`;
    if (t === '편집한' || t === '편집된') return '편집';
    return t;
  });
  return lib.activeMedia().filter((m) => {
    const text = searchText(m);
    return norm.every((t) => text.includes(t));
  });
}

/* ---------- 추억 ("N년 전 오늘") ---------- */

function memories() {
  const now = new Date();
  const groups = new Map();
  for (const m of lib.activeMedia()) {
    const d = new Date(m.takenAt);
    const years = now.getFullYear() - d.getFullYear();
    if (years < 1) continue;
    const same = new Date(now.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((same - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    if (Math.abs(diff) > 3) continue;
    if (!groups.has(years)) groups.set(years, { years, exact: false, items: [] });
    const g = groups.get(years);
    g.items.push(m);
    if (diff === 0) g.exact = true;
  }
  return [...groups.values()].sort((a, b) => a.years - b.years);
}

function tileHTML(m, i, { trash = false, selected } = {}) {
  const url = cachedThumb(m);
  const kindLabel = m.kind === 'video' ? '동영상' : '사진';
  let badges = '';
  if (m.kind === 'video') badges += `<span class="badge badge-video">${icon('play')}${m.duration ? fmtDuration(m.duration) : ''}</span>`;
  if (trash) badges += `<span class="badge badge-days">${lib.daysLeft(m)}일</span>`;
  else if (m.favorite) badges += `<span class="badge badge-fav">${icon('heart')}</span>`;
  const inner = m.thumb
    ? `<img alt="" draggable="false"${url ? ` src="${url}"` : ''}>`
    : `<span class="ph">${icon(m.kind === 'video' ? 'video' : 'image')}<em>${esc(extOf(m.name).toUpperCase() || '파일')}</em></span>`;
  const cls = `tile${url || !m.thumb ? ' loaded' : ''}${selected?.has(m.id) ? ' sel' : ''}`;
  return `<div class="${cls}" data-i="${i}" data-id="${esc(m.id)}" role="button" tabindex="0" aria-label="${kindLabel}, ${esc(fmtDateTime(m.takenAt))}">${inner}${badges}<span class="tick">${icon('check')}</span></div>`;
}

function galleryHTML(items, { trash = false, selected } = {}) {
  if (trash) {
    return `<div class="grid">${items.map((m, i) => tileHTML(m, i, { trash, selected })).join('')}</div>`;
  }
  let html = '';
  let i = 0;
  while (i < items.length) {
    const key = dayKey(items[i].takenAt);
    let j = i;
    let tiles = '';
    while (j < items.length && dayKey(items[j].takenAt) === key) {
      tiles += tileHTML(items[j], j, { selected });
      j++;
    }
    html += `<section class="day" data-day="${key}">
      <header class="day-head">
        <button type="button" class="day-check" data-day="${key}" aria-label="이 날짜 모두 선택"><span class="tick">${icon('check')}</span></button>
        <h3>${fmtDay(items[i].takenAt)}</h3><span class="day-count">${fmtNum(j - i)}</span>
      </header>
      <div class="grid">${tiles}</div>
    </section>`;
    i = j;
  }
  return html;
}

function updateDayChecks(root, set) {
  root.querySelectorAll('.day').forEach((sec) => {
    let all = true;
    for (const t of sec.querySelectorAll('.tile')) {
      if (!set.has(t.dataset.id)) {
        all = false;
        break;
      }
    }
    sec.querySelector('.day-check')?.classList.toggle('on', all);
  });
}

/* ---------- 렌더링 ---------- */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  list = computeList();
  if (sel.ids.size) {
    const visible = new Set(list.map((m) => m.id));
    for (const id of sel.ids) if (!visible.has(id)) sel.ids.delete(id);
  }
  renderAppbar();
  renderMain();
  renderTabbar();
  renderSelbar();
}

function iconBtn(act, ic, label) {
  return `<button type="button" class="icon-btn" data-act="${act}" aria-label="${label}" title="${label}">${icon(ic)}</button>`;
}

function renderAppbar() {
  if (sel.active) {
    const all = list.length > 0 && sel.ids.size === list.length;
    appbar.className = 'appbar is-selecting';
    appbar.innerHTML = `
      ${iconBtn('sel-exit', 'close', '선택 취소')}
      <div class="appbar-title"><h1>${sel.ids.size ? `${fmtNum(sel.ids.size)}개 선택됨` : '항목 선택'}</h1></div>
      <button type="button" class="text-btn" data-act="sel-all">${all ? '선택 해제' : '전체 선택'}</button>`;
    return;
  }
  if (route.name === 'search') {
    if (appbar.querySelector('#search-input')) return; // 입력 중인 검색창은 그대로 둡니다
    appbar.className = 'appbar is-search';
    appbar.innerHTML = `
      ${iconBtn('back', 'back', '뒤로')}
      <label class="search-field">${icon('search')}
        <input id="search-input" type="search" enterkeyhint="search" autocomplete="off" placeholder="날짜, 앨범, 파일 이름 검색" value="${esc(searchQuery)}" aria-label="사진 검색">
      </label>
      ${searchQuery ? iconBtn('clear-search', 'close', '검색어 지우기') : ''}`;
    const input = appbar.querySelector('#search-input');
    input.addEventListener('input', () => onSearchInput(input.value));
    if (!searchQuery) setTimeout(() => input.focus(), 50);
    return;
  }
  const root = ['photos', 'albums', 'backup'].includes(route.name);
  let title = '';
  let sub = '';
  let actions = '';
  const counts = () => (list.length ? fmtCounts(lib.totals(list)) : '');
  switch (route.name) {
    case 'photos':
      title = '사진';
      sub = counts();
      actions = iconBtn('search', 'search', '검색') + iconBtn('add', 'add', '사진 추가') + iconBtn('menu', 'more', '더보기');
      break;
    case 'albums':
      title = '앨범';
      actions = iconBtn('new-album', 'add', '새 앨범');
      break;
    case 'album': {
      title = lib.getAlbum(route.id)?.name || '앨범';
      sub = counts();
      actions = iconBtn('album-add', 'add', '사진 추가') + iconBtn('menu', 'more', '더보기');
      break;
    }
    case 'favorites':
      title = '즐겨찾기';
      sub = counts();
      actions = iconBtn('menu', 'more', '더보기');
      break;
    case 'videos':
      title = '동영상';
      sub = counts();
      actions = iconBtn('menu', 'more', '더보기');
      break;
    case 'trash':
      title = '휴지통';
      sub = list.length ? `${fmtNum(list.length)}개` : '';
      actions = list.length ? `<button type="button" class="text-btn" data-act="select">선택</button><button type="button" class="text-btn danger" data-act="empty-trash">비우기</button>` : '';
      break;
    case 'backup':
      title = '백업';
      actions = iconBtn('settings', 'settings', '설정');
      break;
    case 'settings':
      title = '설정';
      break;
    default:
  }
  appbar.className = `appbar${root ? ' is-root' : ''}`;
  appbar.innerHTML = `
    ${root ? '' : iconBtn('back', 'back', '뒤로')}
    <div class="appbar-title"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <div class="appbar-actions">${actions}</div>`;
}

function renderTabbar() {
  const active = TAB_OF[route.name];
  tabbar.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === active;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
}

function renderSelbar() {
  document.body.classList.toggle('selecting', sel.active);
  if (!sel.active) {
    selbar.innerHTML = '';
    return;
  }
  const items = [...sel.ids].map((id) => store.byId.get(id)).filter(Boolean);
  const allFav = items.length > 0 && items.every((m) => m.favorite);
  const buttons = route.name === 'trash'
    ? [['restore', 'restore', '복원'], ['delete-forever', 'trash', '영구 삭제']]
    : [
      ['share', 'share', '공유'],
      ['favorite', allFav ? 'heart' : 'heartOutline', allFav ? '즐겨찾기 해제' : '즐겨찾기'],
      route.name === 'album' ? ['remove-from-album', 'removeCircle', '앨범에서 빼기'] : ['add-to-album', 'albums', '앨범에 추가'],
      ['download', 'download', '저장'],
      ['delete', 'trash', '삭제'],
    ];
  const disabled = items.length ? '' : ' disabled';
  selbar.innerHTML = buttons.map(([act, ic, label]) => `<button type="button" class="sel-btn" data-act="${act}"${disabled}>${icon(ic)}<span>${label}</span></button>`).join('');
}

function renderMain() {
  mainThumbs.reset();
  main.className = `main view-${route.name}`;
  if (!store.loaded) main.innerHTML = '<div class="loading" aria-label="불러오는 중"><i></i></div>';
  else if (isGalleryRoute()) renderGallery();
  else if (route.name === 'albums') renderAlbums();
  else if (route.name === 'backup') renderBackup();
  else if (route.name === 'settings') renderSettings();
  if (isGalleryRoute() && store.loaded) requestAnimationFrame(() => scroller.refresh(main));
  else scroller.disable();
}

function emptyHTML({ ic, title, text, buttons = '' }) {
  return `<div class="empty"><div class="empty-icon">${icon(ic)}</div><h2>${title}</h2><p>${text}</p>${buttons ? `<div class="empty-actions">${buttons}</div>` : ''}</div>`;
}

function renderGallery() {
  if (route.name === 'album' && !lib.getAlbum(route.id)) {
    main.innerHTML = emptyHTML({ ic: 'albums', title: '앨범을 찾을 수 없어요', text: '삭제되었거나 잘못된 주소예요.', buttons: '<a class="btn primary" href="#/albums">앨범 목록으로</a>' });
    return;
  }
  let html = '';
  if (route.name === 'search') {
    if (!searchQuery.trim()) {
      main.innerHTML = searchSuggestionsHTML();
      return;
    }
    if (list.length) html += `<p class="result-count">검색 결과 ${fmtNum(list.length)}개</p>`;
  }
  if (route.name === 'photos' && !sel.active) html += memoriesHTML();
  if (route.name === 'trash') {
    html += `<div class="banner">${icon('info')}<span>휴지통의 항목은 ${lib.TRASH_DAYS}일이 지나면 영구 삭제돼요. 타일의 숫자는 남은 날짜예요.</span></div>`;
  }
  if (!list.length) {
    const empty = {
      photos: {
        ic: 'cloud', title: '아직 보관한 사진이 없어요',
        text: '휴대폰이나 PC의 사진·동영상을 추가하면<br>이 기기 안의 보관함에 안전하게 저장돼요.',
        buttons: `<button type="button" class="btn primary" data-act="add">${icon('add')}사진 추가</button><button type="button" class="btn" data-act="restore-zip">백업 파일에서 복원</button>`,
      },
      favorites: { ic: 'heartOutline', title: '즐겨찾기가 비어 있어요', text: '사진을 볼 때 ♡ 버튼을 누르면 여기에 모여요.' },
      videos: { ic: 'video', title: '동영상이 없어요', text: '보관한 동영상이 여기에 모여요.' },
      album: {
        ic: 'albums', title: '앨범이 비어 있어요', text: '보관함의 사진을 고르거나 기기에서 바로 올릴 수 있어요.',
        buttons: `<button type="button" class="btn primary" data-act="album-pick">${icon('photos')}보관함에서 고르기</button><button type="button" class="btn" data-act="album-upload">${icon('upload')}기기에서 올리기</button>`,
      },
      trash: { ic: 'trash', title: '휴지통이 비어 있어요', text: '삭제한 항목은 여기에서 30일 동안 복원할 수 있어요.' },
      search: { ic: 'search', title: '검색 결과가 없어요', text: `‘${esc(searchQuery)}’와 일치하는 사진이 없어요.<br>‘2025년 10월’, ‘동영상’, 앨범 이름처럼 검색해 보세요.` },
    }[route.name];
    main.innerHTML = html + emptyHTML(empty);
    return;
  }
  html += `<div class="gallery">${galleryHTML(list, { trash: route.name === 'trash', selected: sel.ids })}</div>`;
  main.innerHTML = html;
  updateDayChecks(main, sel.ids);
  mainThumbs.observe(main);
}

let memoryGroups = [];

function memoriesHTML() {
  memoryGroups = memories();
  if (!memoryGroups.length) return '';
  return `<section class="memories" aria-label="추억">
    <h2 class="memories-title">${icon('restore')}추억</h2>
    <div class="memory-row">${memoryGroups.map((g, i) => {
      const url = thumbURL(g.items.find((m) => m.thumb) || g.items[0]);
      return `<button type="button" class="memory" data-act="memory" data-i="${i}">
        ${url ? `<img src="${url}" alt="" draggable="false">` : ''}
        <span class="memory-text"><strong>${g.years}년 전 ${g.exact ? '오늘' : '이맘때'}</strong><small>${new Date(g.items[0].takenAt).getFullYear()}년 · ${fmtNum(g.items.length)}개</small></span>
      </button>`;
    }).join('')}</div>
  </section>`;
}

function searchSuggestionsHTML() {
  const active = lib.activeMedia();
  const year = new Date().getFullYear();
  const chips = [];
  if (active.some((m) => m.kind === 'video')) chips.push(['video', '동영상']);
  if (active.some((m) => m.favorite)) chips.push(['heart', '즐겨찾기']);
  if (active.some((m) => m.edited || m.editedAt)) chips.push(['tune', '편집']);
  if (active.some((m) => /screenshot|스크린샷|캡처/i.test(m.name))) chips.push(['image', '스크린샷']);
  if (active.some((m) => new Date(m.takenAt).getFullYear() === year)) chips.push(['event', '올해']);
  if (active.some((m) => new Date(m.takenAt).getFullYear() === year - 1)) chips.push(['event', '작년']);
  const months = [];
  for (const m of active) {
    const d = new Date(m.takenAt);
    const label = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
    if (!months.includes(label)) months.push(label);
    if (months.length >= 8) break;
  }
  const chip = (ic, label) => `<button type="button" class="chip" data-act="search-chip" data-q="${esc(label)}">${icon(ic)}${esc(label)}</button>`;
  if (!active.length) return emptyHTML({ ic: 'search', title: '검색할 사진이 없어요', text: '사진을 추가하면 날짜, 앨범, 이름으로 찾을 수 있어요.' });
  return `<div class="page">
    ${chips.length ? `<h3 class="section-title">빠른 검색</h3><div class="chips">${chips.map(([ic, l]) => chip(ic, l)).join('')}</div>` : ''}
    ${store.albums.length ? `<h3 class="section-title">앨범</h3><div class="chips">${store.albums.map((a) => chip('albums', a.name)).join('')}</div>` : ''}
    <h3 class="section-title">날짜</h3><div class="chips">${months.map((l) => chip('event', l)).join('')}</div>
    <p class="footer-note">여러 단어를 띄어 쓰면 모두 맞는 사진만 보여줘요 (예: 2025년 여행)</p>
  </div>`;
}

let searchTimer = 0;
function onSearchInput(value) {
  searchQuery = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    list = computeList();
    renderMain();
    const has = !!searchQuery;
    const clearBtn = appbar.querySelector('[data-act="clear-search"]');
    if (has && !clearBtn) appbar.insertAdjacentHTML('beforeend', iconBtn('clear-search', 'close', '검색어 지우기'));
    if (!has && clearBtn) clearBtn.remove();
  }, 140);
}

function setSearch(q) {
  const input = appbar.querySelector('#search-input');
  if (input) input.value = q;
  onSearchInput(q);
}

function segmented(act, options, current) {
  return `<div class="segmented" role="radiogroup">${Object.entries(options).map(([v, label]) => `<button type="button" role="radio" aria-checked="${v === String(current)}" class="${v === String(current) ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`).join('')}</div>`;
}

function renderSettings() {
  const active = lib.activeMedia();
  const t = lib.totals(active);
  const lockOn = lock.isLockEnabled();
  main.innerHTML = `
    <div class="page">
      <h3 class="section-title">화면</h3>
      <section class="card">
        <div class="setting"><div><strong>테마</strong><small>밝은 화면과 어두운 화면 중에 골라요</small></div></div>
        ${segmented('set-theme', THEMES, prefs.theme)}
        <div class="setting gap"><div><strong>사진 크기</strong><small>사진 탭에서 두 손가락으로 벌리거나 오므려도 바뀌어요</small></div></div>
        ${segmented('set-grid', GRID_SIZES, prefs.grid)}
      </section>

      <h3 class="section-title">보안</h3>
      <section class="card list">
        <button type="button" class="row" data-act="lock-toggle" role="switch" aria-checked="${lockOn}">
          ${icon('lock')}<div><strong>앱 잠금</strong><small>앱을 열 때 PIN 4자리를 입력하게 해요</small></div>
          <span class="switch${lockOn ? ' on' : ''}"><i></i></span>
        </button>
        ${lockOn ? `
          ${row('lock-change', 'edit', 'PIN 변경', '새 PIN 4자리로 바꿔요')}
          <div class="row static">${icon('event')}<div><strong>자동 잠금</strong><small>다른 앱으로 갔다가 돌아왔을 때</small>
            ${segmented('lock-delay', Object.fromEntries(lock.LOCK_DELAYS.map(([ms, l]) => [String(ms), l])), String(lock.lockDelay()))}</div></div>` : ''}
      </section>
      ${lockOn ? '<p class="setting-note">앱 잠금은 다른 사람이 앱 화면을 보지 못하게 막는 기능이에요. PIN을 잊으면 모든 데이터를 지워야 하니, 백업 파일을 꼭 만들어 두세요.</p>' : ''}

      <h3 class="section-title">저장공간</h3>
      <section class="card list">
        <div class="row static">${icon('storage')}<div><strong>보관 중</strong><small>${fmtCounts(t)} · ${fmtBytes(t.bytes)}</small></div></div>
        ${t.edited ? `<div class="row static">${icon('tune')}<div><strong>편집한 사진의 원본</strong><small>${fmtNum(t.edited)}개 · ${fmtBytes(t.originalBytes)} · 사진 화면의 ⋮ → ‘원본으로 되돌리기’로 복원할 수 있어요</small></div></div>` : ''}
        <a class="row" href="#/trash">${icon('trash')}<div><strong>휴지통</strong><small>${fmtNum(lib.trashedMedia().length)}개 · ${lib.TRASH_DAYS}일 후 자동 삭제</small></div>${icon('chevronRight', 'row-chev')}</a>
        <button type="button" class="row danger" data-act="wipe">${icon('trash')}<div><strong>모든 데이터 삭제</strong><small>이 기기에 보관한 사진, 앨범, 설정을 모두 지워요</small></div></button>
      </section>

      <h3 class="section-title">정보</h3>
      <section class="card list">
        <div class="row static">${icon('info')}<div><strong>사진 보관함 ${APP_VERSION}</strong><small>모든 사진은 이 기기에만 저장되며 외부 서버로 전송되지 않아요.</small></div></div>
      </section>
    </div>`;
}

function albumCard(href, name, count, cover, ic) {
  const url = cover ? thumbURL(cover) : null;
  return `<a class="album-card" href="${href}">
    <div class="album-cover${url ? '' : ' empty'}">${url ? `<img src="${url}" alt="" draggable="false">` : icon(ic)}</div>
    <strong>${esc(name)}</strong><small>${count}</small></a>`;
}

function renderAlbums() {
  const active = lib.activeMedia();
  const favs = active.filter((m) => m.favorite);
  const vids = active.filter((m) => m.kind === 'video');
  const trash = lib.trashedMedia();
  const mine = store.albums.map((a) => {
    const items = active.filter((m) => m.albums.includes(a.id));
    const cover = items.find((m) => m.id === a.coverId) || items[0];
    return albumCard(`#/album/${encodeURIComponent(a.id)}`, a.name, `${fmtNum(items.length)}개`, cover, 'albums');
  }).join('');
  main.innerHTML = `
    <div class="page wide">
      <h2 class="section-title">모아보기</h2>
      <div class="album-grid">
        ${albumCard('#/favorites', '즐겨찾기', `${fmtNum(favs.length)}개`, favs[0], 'heart')}
        ${albumCard('#/videos', '동영상', `${fmtNum(vids.length)}개`, vids[0], 'video')}
      </div>
      <h2 class="section-title">내 앨범</h2>
      <div class="album-grid">
        ${mine}
        <button type="button" class="album-card new" data-act="new-album">
          <div class="album-cover empty">${icon('add')}</div><strong>새 앨범</strong><small>${store.albums.length ? '' : '사진을 주제별로 정리해 보세요'}</small>
        </button>
      </div>
      <div class="card list">
        <a class="row" href="#/trash">${icon('trash')}<div><strong>휴지통</strong><small>${fmtNum(trash.length)}개 · ${lib.TRASH_DAYS}일 후 자동 삭제</small></div>${icon('chevronRight', 'row-chev')}</a>
      </div>
    </div>`;
}

function row(act, ic, title, text) {
  return `<button type="button" class="row" data-act="${act}">${icon(ic)}<div><strong>${title}</strong><small>${text}</small></div>${icon('chevronRight', 'row-chev')}</button>`;
}

function renderBackup() {
  const active = lib.activeMedia();
  const t = lib.totals(active);
  const pending = active.filter((m) => !m.exportedAt);
  const pt = lib.totals(pending);
  const trash = lib.trashedMedia();

  let install = '';
  if (isStandalone()) {
    install = `<div class="row static">${icon('phone')}<div><strong>앱으로 설치되어 있어요</strong><small>홈 화면에서 바로 열 수 있어요</small></div></div>`;
  } else if (installEvent) {
    install = row('install', 'phone', '홈 화면에 설치', '앱처럼 전체 화면으로 쓰고, 보관한 사진도 더 안정적으로 지켜져요');
  } else if (isIOS) {
    install = `<div class="row static">${icon('phone')}<div><strong>홈 화면에 추가하기</strong><small>Safari 아래쪽 공유 버튼 → ‘홈 화면에 추가’를 누르면 앱처럼 쓸 수 있어요. iPhone은 홈 화면에 추가해야 사진이 오래 보관돼요.</small></div></div>`;
  } else {
    install = `<div class="row static">${icon('phone')}<div><strong>홈 화면에 설치하기</strong><small>브라우저 메뉴(⋮)에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 눌러 주세요.</small></div></div>`;
  }

  let status = '';
  if (!t.count) status = '보관한 항목이 생기면 여기서 백업 파일로 내보낼 수 있어요.';
  else if (pending.length) status = `<strong>${fmtNum(pending.length)}개</strong>(${fmtBytes(pt.bytes)})가 아직 백업 파일로 내보내지지 않았어요.`;
  else status = `${icon('check', 'ok-ic')} 모든 항목이 백업 파일에 들어 있어요.`;

  main.innerHTML = `
    <div class="page">
      <section class="card hero">
        <div class="hero-top">
          <div class="hero-icon">${icon('shield')}</div>
          <div>
            <h2>${t.count ? `${fmtNum(t.count)}개 보관 중` : '보관함이 비어 있어요'}</h2>
            <p>${t.count ? `${fmtCounts(t)} · ${fmtBytes(t.bytes)}` : '사진을 추가해서 백업을 시작하세요'}</p>
          </div>
        </div>
        <div id="storage-box" class="storage"><div class="bar"><i></i></div><small>저장공간 확인 중…</small></div>
      </section>

      <h3 class="section-title">사진 추가</h3>
      <section class="card list">
        ${row('add', 'image', '사진·동영상 선택', '여러 장을 한 번에 고를 수 있어요. 이미 보관한 사진은 자동으로 건너뛰어요')}
        ${canPickFolder ? row('pick-folder', 'folder', '폴더 통째로 추가', 'PC의 사진 폴더를 하위 폴더까지 한 번에 보관해요') : ''}
        ${isTouch && !isIOS ? `<div class="row static">${icon('share')}<div><strong>갤러리에서 바로 보내기</strong><small>앱을 홈 화면에 설치하면, 갤러리 앱에서 사진 선택 → 공유 → ‘사진 보관함’으로 바로 보관할 수 있어요.</small></div></div>` : ''}
        ${!isTouch ? `<div class="row static">${icon('upload')}<div><strong>끌어다 놓기</strong><small>사진이나 폴더를 이 창에 끌어다 놓아도 보관돼요.</small></div></div>` : ''}
      </section>

      <h3 class="section-title">백업 파일 (ZIP)</h3>
      <section class="card">
        <p class="note">보관함의 사진은 <b>이 기기의 브라우저 안</b>에 저장돼요. 기기를 잃어버리거나 초기화·브라우저 데이터 삭제를 해도 사진을 지킬 수 있도록, 백업 파일을 PC·외장 드라이브·클라우드(구글 드라이브 등)에 따로 보관해 주세요.</p>
        <div class="export-status"><p>${status}</p>${store.lastExportAt ? `<small>마지막 내보내기: ${fmtDateTime(store.lastExportAt)}</small>` : ''}</div>
        <div class="btn-row">
          <button type="button" class="btn primary" data-act="export-new"${pending.length ? '' : ' disabled'}>${icon('download')}새 항목만 내보내기</button>
          <button type="button" class="btn" data-act="export-all"${t.count ? '' : ' disabled'}>전체 내보내기</button>
        </div>
      </section>
      <section class="card list">
        ${row('restore-zip', 'restore', '백업 파일에서 복원', '내보낸 ZIP 파일(여러 개 가능)을 고르면 앨범·즐겨찾기까지 그대로 되살려요')}
      </section>

      <h3 class="section-title">앱</h3>
      <section class="card list">
        ${install}
        <a class="row" href="#/trash">${icon('trash')}<div><strong>휴지통</strong><small>${fmtNum(trash.length)}개 · ${lib.TRASH_DAYS}일 후 자동 삭제</small></div>${icon('chevronRight', 'row-chev')}</a>
      </section>
      <p class="footer-note">사진 보관함 v1.0 · 모든 사진은 이 기기에만 저장되며 외부 서버로 전송되지 않아요.</p>
    </div>`;
  fillStorage();
}

async function fillStorage() {
  let est = null;
  let persisted = null;
  try {
    est = await navigator.storage?.estimate?.();
  } catch {
    est = null;
  }
  try {
    persisted = await navigator.storage?.persisted?.();
  } catch {
    persisted = null;
  }
  const box = $('#storage-box');
  if (!box) return;
  const used = est?.usage || 0;
  const quota = est?.quota || 0;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const pill = persisted === true
    ? `<span class="pill ok">${icon('shield')}저장공간 보호 중</span>`
    : persisted === false
      ? `<button type="button" class="pill warn" data-act="persist">${icon('info')}저장공간 보호 켜기</button>`
      : '';
  box.innerHTML = `
    <div class="storage-head"><span>브라우저 저장공간</span>${pill}</div>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <small>${quota ? `${fmtBytes(used)} 사용 · 최대 약 ${fmtBytes(quota)}까지 쓸 수 있어요` : '이 브라우저는 저장공간 정보를 알려주지 않아요'}</small>`;
}

/* ---------- 선택 모드 ---------- */

function enterSelection() {
  if (sel.active) return;
  sel.active = true;
  sel.ids.clear();
  sel.anchor = -1;
  pushLayer(exitSelectionNow);
  updateSelectionUI();
}

function exitSelection() {
  if (sel.active) popLayer();
}

function exitSelectionNow() {
  sel.active = false;
  sel.ids.clear();
  updateSelectionUI();
}

function updateSelectionUI() {
  for (const t of main.querySelectorAll('.tile')) t.classList.toggle('sel', sel.ids.has(t.dataset.id));
  updateDayChecks(main, sel.ids);
  renderAppbar();
  renderSelbar();
}

function toggleDay(key) {
  const ids = list.filter((m) => dayKey(m.takenAt) === key).map((m) => m.id);
  const all = ids.every((id) => sel.ids.has(id));
  if (!sel.active) enterSelection();
  ids.forEach((id) => (all ? sel.ids.delete(id) : sel.ids.add(id)));
  updateSelectionUI();
}

/* ---------- 타일 입력 (탭, 길게 누르기) ---------- */

let lp = null;

main.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (lp) clearTimeout(lp.timer);
  const press = { tile, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
  press.timer = setTimeout(() => {
    press.fired = true;
    navigator.vibrate?.(15);
    if (!sel.active) enterSelection();
    sel.ids.add(tile.dataset.id);
    sel.anchor = +tile.dataset.i;
    updateSelectionUI();
  }, 420);
  lp = press;
});
main.addEventListener('pointermove', (e) => {
  if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) {
    clearTimeout(lp.timer);
    lp = null;
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  main.addEventListener(type, () => {
    if (lp && !lp.fired) clearTimeout(lp.timer);
  });
}
window.addEventListener('scroll', () => {
  if (lp && !lp.fired) {
    clearTimeout(lp.timer);
    lp = null;
  }
}, { passive: true });
main.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tile')) e.preventDefault();
});

main.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) {
    onTileClick(tile, e);
    return;
  }
  const dc = e.target.closest('.day-check');
  if (dc) {
    toggleDay(dc.dataset.day);
    return;
  }
  const a = e.target.closest('[data-act]');
  if (a) handleAction(a.dataset.act, a);
});

main.addEventListener('keydown', (e) => {
  const tile = e.target.closest?.('.tile');
  if (tile && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    onTileClick(tile, e);
  }
});

function onTileClick(tile, e) {
  if (lp?.fired && lp.tile === tile) {
    lp = null;
    return;
  }
  const i = +tile.dataset.i;
  const id = tile.dataset.id;
  if (sel.active) {
    if (e.shiftKey && sel.anchor >= 0) {
      const [a, b] = [Math.min(sel.anchor, i), Math.max(sel.anchor, i)];
      for (let k = a; k <= b; k++) sel.ids.add(list[k].id);
    } else if (sel.ids.has(id)) sel.ids.delete(id);
    else sel.ids.add(id);
    sel.anchor = i;
    updateSelectionUI();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.target.closest('.tick')) {
    enterSelection();
    sel.ids.add(id);
    sel.anchor = i;
    updateSelectionUI();
    return;
  }
  openViewerAt(i);
}

/* ---------- 뷰어 ---------- */

function openViewerAt(i) {
  if (!list[i]) return;
  openViewer(list.map((m) => m.id), i);
}

function openViewer(ids, index, { slideshow = false } = {}) {
  if (viewer || !ids[index]) return;
  lastViewedId = ids[index];
  viewer = new Viewer({
    ids,
    index,
    mode: route.name === 'trash' ? 'trash' : 'normal',
    ctx: {
      loadDetails: loadPhotoDetails,
      get: (id) => store.byId.get(id),
      thumbURL,
      loadOriginal: lib.getOriginal,
      onAction: onViewerAction,
      onRequestClose: popLayer,
      onIndexChange: (id) => { lastViewedId = id; },
      albumNames: (m) => m.albums.map((a) => lib.getAlbum(a)?.name).filter(Boolean),
    },
  });
  pushLayer(() => {
    const v = viewer;
    viewer = null;
    v?.destroy();
    revealTile(lastViewedId);
  });
  if (slideshow) setTimeout(() => viewer?.startSlideshow(), 400);
}

async function loadPhotoDetails(m) {
  const blob = await lib.getExifSource(m.id);
  const ex = blob ? await readExifDetails(blob) : null;
  if (!ex) return [];
  const rows = [];
  const camera = ex.model && ex.make && !ex.model.toLowerCase().startsWith(ex.make.toLowerCase())
    ? `${ex.make} ${ex.model}` : ex.model || ex.make;
  if (camera) rows.push(['카메라', camera]);
  if (ex.lens && ex.lens !== camera) rows.push(['렌즈', ex.lens]);
  const shot = [];
  if (ex.fNumber) shot.push(`f/${Math.round(ex.fNumber * 10) / 10}`);
  if (ex.exposure) shot.push(ex.exposure >= 1 ? `${Math.round(ex.exposure * 10) / 10}초` : `1/${Math.round(1 / ex.exposure)}초`);
  if (ex.iso) shot.push(`ISO ${ex.iso}`);
  if (ex.focal) shot.push(`${Math.round(ex.focal * 10) / 10}mm`);
  if (shot.length) rows.push(['촬영 설정', shot.join(' · ')]);
  if (ex.lat !== null) {
    const lat = ex.lat.toFixed(5);
    const lon = ex.lon.toFixed(5);
    rows.push(['위치', `${lat}, ${lon}`, `https://www.google.com/maps?q=${lat},${lon}`]);
  }
  return rows;
}

/* ---------- 편집기 ---------- */

async function openEditor(id) {
  const m = store.byId.get(id);
  if (!m || m.kind !== 'image' || editor) return;
  const blob = await lib.getOriginal(id);
  if (!blob) return;
  let instance = null;
  let allowClose = false;
  const closeLayer = () => {
    if (instance && instance.dirty && !allowClose) {
      // 뒤로가기로 닫으려 할 때 저장하지 않은 내용이 있으면 물어봅니다.
      pushLayer(closeLayer);
      instance.confirmDiscard().then((ok) => {
        if (ok) {
          allowClose = true;
          popLayer();
        }
      });
      return;
    }
    instance?.destroy();
    editor = null;
  };
  try {
    editor = 'opening';
    instance = await Editor.open({
      blob,
      type: m.type,
      name: m.name,
      onCancel: () => {
        allowClose = true;
        popLayer();
      },
      onSave: async (out, asCopy) => {
        const saved = await lib.saveEdit(id, out, { asCopy });
        allowClose = true;
        popLayer();
        if (asCopy) {
          toast('사본으로 저장했어요', {
            action: '보기',
            onAction: () => {
              if (!viewer) return;
              viewer.ids.splice(viewer.index, 0, saved.id);
              viewer.fill(true);
            },
          });
        } else {
          viewer?.reloadCurrent();
          toast('편집한 사진을 저장했어요. 원본은 ⋮ 메뉴에서 되돌릴 수 있어요.');
        }
      },
    });
    editor = instance;
    pushLayer(closeLayer);
  } catch (err) {
    editor = null;
    toast(err.message || '편집기를 열지 못했어요');
  }
}

async function viewerMore(id) {
  const m = store.byId.get(id);
  if (!m) return;
  const items = [];
  if (route.name !== 'trash') {
    items.push({ label: '앨범에 추가', icon: 'albums', value: 'album' });
    items.push({ label: '기기에 저장', icon: 'download', value: 'download' });
    if (viewer && viewer.ids.length > 1) items.push({ label: '슬라이드쇼', icon: 'slideshow', value: 'slideshow' });
    items.push({ label: '날짜 및 시간 변경', icon: 'event', value: 'date' });
    if (route.name === 'album') items.push({ label: '앨범 표지로 설정', icon: 'image', value: 'cover' });
    if (m.edited) items.push({ label: '원본으로 되돌리기', icon: 'restore', value: 'revert', hint: '편집하기 전 사진으로 돌아가요' });
  } else {
    items.push({ label: '기기에 저장', icon: 'download', value: 'download' });
  }
  const v = await actionSheet({ items });
  if (v) onViewerAction(v, id);
}

function revealTile(id) {
  if (!id) return;
  const tile = main.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  const r = tile.getBoundingClientRect();
  if (r.top < 70 || r.bottom > window.innerHeight - 80) tile.scrollIntoView({ block: 'center' });
}

async function onViewerAction(act, id) {
  const m = store.byId.get(id);
  if (!m) return;
  switch (act) {
    case 'favorite':
      await lib.setFavorite([id], !m.favorite);
      viewer?.refresh();
      toast(m.favorite ? '즐겨찾기에 추가했어요' : '즐겨찾기에서 뺐어요');
      break;
    case 'share':
      await shareItems([m]);
      break;
    case 'download':
      await downloadItems([m]);
      break;
    case 'album':
      await addToAlbumFlow([id]);
      viewer?.refresh();
      break;
    case 'more':
      await viewerMore(id);
      break;
    case 'edit':
      await openEditor(id);
      break;
    case 'slideshow':
      viewer?.startSlideshow();
      break;
    case 'date': {
      const t = await dateTimeDialog({ title: '날짜 및 시간 변경', value: m.takenAt });
      if (t === null) return;
      await lib.setTakenAt([id], t);
      viewer?.refresh();
      toast(`${fmtDateTime(t)}(으)로 바꿨어요`);
      break;
    }
    case 'cover':
      await lib.setAlbumCover(route.id, id);
      toast('앨범 표지로 설정했어요');
      break;
    case 'revert': {
      const ok = await confirmDialog({ title: '원본으로 되돌릴까요?', message: '편집한 내용이 사라지고 편집하기 전 사진으로 돌아가요.', ok: '되돌리기' });
      if (!ok) return;
      await lib.revertEdit(id);
      viewer?.reloadCurrent();
      toast('원본으로 되돌렸어요');
      break;
    }
    case 'delete':
      if (!(await confirmDialog({ title: '휴지통으로 이동할까요?', message: `${lib.TRASH_DAYS}일 동안 휴지통에서 복원할 수 있어요.`, ok: '삭제', danger: true }))) return;
      await lib.moveToTrash([id]);
      viewer?.removeCurrent();
      toast('휴지통으로 이동했어요', { action: '실행 취소', onAction: () => lib.restore([id]) });
      break;
    case 'restore':
      await lib.restore([id]);
      viewer?.removeCurrent();
      toast('복원했어요');
      break;
    case 'delete-forever':
      if (!(await confirmDialog({ title: '영구 삭제할까요?', message: '이 기기에서 완전히 지워지며 되돌릴 수 없어요.', ok: '영구 삭제', danger: true }))) return;
      await lib.deleteForever([id]);
      viewer?.removeCurrent();
      toast('영구 삭제했어요');
      break;
    default:
  }
}

/* ---------- 공유 · 저장 ---------- */

async function shareItems(items) {
  if (!navigator.share || !navigator.canShare) {
    toast('이 브라우저는 파일 공유를 지원하지 않아요. ‘저장’을 이용해 주세요.');
    return;
  }
  const files = [];
  for (const m of items) {
    const blob = await lib.getOriginal(m.id);
    if (blob) files.push(new File([blob], m.name, { type: m.type, lastModified: m.takenAt }));
  }
  if (!files.length || !navigator.canShare({ files })) {
    toast('이 파일은 공유할 수 없어요. ‘저장’을 이용해 주세요.');
    return;
  }
  try {
    await navigator.share({ files });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('공유하지 못했어요');
  }
}

function stamp(withTime = true) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${withTime ? `-${p(d.getHours())}${p(d.getMinutes())}` : ''}`;
}

async function downloadItems(items) {
  if (items.length === 1) {
    const blob = await lib.getOriginal(items[0].id);
    if (blob) downloadBlob(blob, items[0].name);
    return;
  }
  busy++;
  progress.show(`${fmtNum(items.length)}개를 ZIP으로 묶는 중`);
  try {
    const zip = await lib.buildArchive(items, { withManifest: false }, (d, t) => progress.update(d, t, `${fmtBytes(d)} / ${fmtBytes(t)}`, `${Math.round((d / (t || 1)) * 100)}%`));
    downloadBlob(zip, `photos-${stamp()}.zip`);
    toast('ZIP 파일로 저장했어요');
  } catch (err) {
    toast(`저장하지 못했어요: ${err.message}`);
  } finally {
    progress.hide();
    busy--;
  }
}

/* ---------- 앨범 ---------- */

async function addToAlbumFlow(ids) {
  const v = await actionSheet({
    title: '앨범에 추가',
    items: [
      { label: '새 앨범 만들기', icon: 'add', value: '__new' },
      ...store.albums.map((a) => ({ label: a.name, icon: 'albums', value: a.id, hint: `${fmtNum(lib.albumMedia(a.id).length)}개` })),
    ],
  });
  if (!v) return false;
  let albumId = v;
  if (v === '__new') {
    const name = await promptDialog({ title: '새 앨범', placeholder: '앨범 이름', ok: '만들기' });
    if (!name) return false;
    albumId = (await lib.createAlbum(name)).id;
  }
  const n = await lib.addToAlbum(albumId, ids);
  const name = lib.getAlbum(albumId)?.name || '';
  toast(n ? `‘${name}’에 ${fmtNum(n)}개를 추가했어요` : `이미 ‘${name}’에 있는 항목이에요`);
  return true;
}

function pickFromLibrary({ title, exclude }) {
  return new Promise((resolve) => {
    const items = lib.activeMedia().filter((m) => !exclude.has(m.id));
    const chosen = new Set();
    const loader = createThumbLoader();
    const modal = openModal({
      className: 'picker',
      html: `
        <header class="picker-bar">
          <button type="button" class="icon-btn" data-x aria-label="닫기">${icon('close')}</button>
          <h2>${esc(title)}</h2>
          <button type="button" class="btn primary sm" data-ok disabled>추가</button>
        </header>
        <div class="picker-body selecting-grid">${items.length ? galleryHTML(items, { selected: chosen }) : emptyHTML({ ic: 'photos', title: '고를 수 있는 사진이 없어요', text: '보관함의 모든 사진이 이미 이 앨범에 있어요.' })}</div>`,
      onClose: (v) => {
        loader.reset();
        resolve(Array.isArray(v) ? v : null);
      },
    });
    const body = modal.el.querySelector('.picker-body');
    const ok = modal.el.querySelector('[data-ok]');
    const sync = () => {
      body.querySelectorAll('.tile').forEach((t) => t.classList.toggle('sel', chosen.has(t.dataset.id)));
      updateDayChecks(body, chosen);
      ok.disabled = !chosen.size;
      ok.textContent = chosen.size ? `추가 (${fmtNum(chosen.size)})` : '추가';
    };
    modal.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) return modal.close();
      if (e.target.closest('[data-ok]')) return modal.close([...chosen]);
      const tile = e.target.closest('.tile');
      if (tile) {
        const id = tile.dataset.id;
        if (chosen.has(id)) chosen.delete(id);
        else chosen.add(id);
        sync();
        return;
      }
      const dc = e.target.closest('.day-check');
      if (dc) {
        const ids = items.filter((m) => dayKey(m.takenAt) === dc.dataset.day).map((m) => m.id);
        const all = ids.every((id) => chosen.has(id));
        ids.forEach((id) => (all ? chosen.delete(id) : chosen.add(id)));
        sync();
      }
    });
    loader.observe(body);
  });
}

async function albumPickFlow() {
  const album = lib.getAlbum(route.id);
  if (!album) return;
  const exclude = new Set(lib.albumMedia(album.id).map((m) => m.id));
  const ids = await pickFromLibrary({ title: `‘${album.name}’에 추가`, exclude });
  if (!ids?.length) return;
  const n = await lib.addToAlbum(album.id, ids);
  toast(`${fmtNum(n)}개를 추가했어요`);
}

function albumUploadFlow() {
  uploadAlbumId = route.name === 'album' ? route.id : null;
  fileInput.click();
}

/* ---------- 백업 파일 내보내기 ---------- */

function exportFlow(onlyNew) {
  const items = lib.activeMedia().filter((m) => !onlyNew || !m.exportedAt);
  if (!items.length) {
    toast('내보낼 항목이 없어요');
    return;
  }
  const { parts, tooLarge } = lib.planExport(items);
  const total = lib.totals(items);
  const date = stamp(false);
  const range = (p) => {
    const a = fmtDay(p[0].takenAt);
    const b = fmtDay(p[p.length - 1].takenAt);
    return a === b ? a : `${a} ~ ${b}`;
  };
  const modal = openModal({
    className: 'dialog export',
    html: `
      <h2>${onlyNew ? '새 항목 내보내기' : '전체 내보내기'}</h2>
      <p>${fmtCounts(total)} · ${fmtBytes(total.bytes)}<br>${parts.length > 1
        ? `용량이 커서 ZIP 파일 <b>${parts.length}개</b>로 나눠요. 하나씩 눌러 저장해 주세요.`
        : '아래 버튼을 누르면 ZIP 파일이 만들어지고 바로 저장돼요.'}</p>
      ${tooLarge.length ? `<p class="warn">4GB가 넘는 동영상 ${tooLarge.length}개는 ZIP에 넣을 수 없어 제외했어요. 뷰어의 다운로드 버튼으로 따로 저장해 주세요.</p>` : ''}
      <div class="parts">${parts.map((p, i) => `
        <div class="part" data-i="${i}">
          <div class="part-info">
            <strong>${parts.length > 1 ? `파일 ${i + 1} / ${parts.length}` : 'ZIP 파일'}</strong>
            <small>${fmtNum(p.length)}개 · ${fmtBytes(lib.totals(p).bytes)} · ${esc(range(p))}</small>
            <div class="bar"><i></i></div>
          </div>
          <button type="button" class="btn sm primary" data-part="${i}">만들기</button>
        </div>`).join('')}
      </div>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-close>닫기</button></div>`,
  });
  const built = new Map();
  modal.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) {
      modal.close();
      return;
    }
    const btn = e.target.closest('[data-part]');
    if (!btn || btn.disabled) return;
    const i = +btn.dataset.part;
    const name = `photo-backup-${date}${parts.length > 1 ? `-${i + 1}of${parts.length}` : ''}.zip`;
    if (built.has(i)) {
      downloadBlob(built.get(i), name);
      return;
    }
    const partEl = btn.closest('.part');
    const bar = partEl.querySelector('.bar i');
    btn.disabled = true;
    btn.textContent = '만드는 중…';
    modal.el.querySelector('[data-close]').disabled = true;
    modal.setDismissible(false);
    busy++;
    try {
      const zip = await lib.buildArchive(parts[i], { part: i + 1, parts: parts.length }, (d, t) => {
        bar.style.width = `${t ? (d / t) * 100 : 100}%`;
      });
      built.set(i, zip);
      downloadBlob(zip, name);
      await lib.markExported(parts[i].map((m) => m.id));
      partEl.classList.add('done');
      btn.classList.remove('primary');
      btn.textContent = '다시 저장';
    } catch (err) {
      toast(`백업 파일을 만들지 못했어요: ${err.message}`);
      btn.textContent = '다시 시도';
    } finally {
      busy--;
      btn.disabled = false;
      modal.el.querySelector('[data-close]').disabled = false;
      modal.setDismissible(true);
    }
  });
}

/* ---------- 가져오기 ---------- */

function filesToItems(files, extra = {}) {
  return [...files].map((f) => ({ blob: f, name: f.name, type: f.type, lastModified: f.lastModified, ...extra }));
}

function importSummary(r) {
  if (r.quota) return '기기 저장공간이 부족해서 중단했어요. 공간을 확보한 뒤 다시 시도해 주세요.';
  const parts = [];
  if (r.stopped) parts.push('중지했어요');
  if (r.added) parts.push(`${fmtNum(r.added)}개 보관 완료`);
  if (r.restored) parts.push(`휴지통에서 ${fmtNum(r.restored)}개 복원`);
  if (r.duplicates) parts.push(`이미 있는 ${fmtNum(r.duplicates)}개 건너뜀`);
  if (r.skipped) parts.push(`지원하지 않는 파일 ${fmtNum(r.skipped)}개 제외`);
  if (r.failed) parts.push(`실패 ${fmtNum(r.failed)}개`);
  return parts.join(' · ') || '추가된 항목이 없어요';
}

function runImport(items, title = '사진 보관하는 중') {
  importChain = importChain.then(() => doImport(items, title)).catch(() => {});
  return importChain;
}

async function doImport(items, title) {
  if (!items.length) return;
  busy++;
  let stop = false;
  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
  progress.show(title, () => { stop = true; });
  try {
    const result = await lib.importFiles(items, (d, t, name) => progress.update(d, t, name || ''), () => stop);
    toast(importSummary(result), { duration: 4500 });
    if (result.added && !askedPersist) {
      askedPersist = true;
      navigator.storage?.persist?.().catch(() => {});
    }
  } catch (err) {
    console.error(err);
    toast('보관하는 중 문제가 생겼어요');
  } finally {
    progress.hide();
    wakeLock?.release?.().catch(() => {});
    busy--;
  }
}

async function restoreFromZips(files) {
  if (!files.length) return;
  busy++;
  progress.show('백업 파일 읽는 중');
  let result;
  try {
    result = await lib.readBackupFiles(files);
  } finally {
    progress.hide();
    busy--;
  }
  const { items, errors } = result;
  if (errors.length) toast(errors[0], { duration: 5000 });
  if (!items.length) {
    if (!errors.length) toast('백업 파일에 사진이나 동영상이 없어요');
    return;
  }
  const bytes = items.reduce((s, it) => s + (it.size || 0), 0);
  const ok = await confirmDialog({
    title: `${fmtNum(items.length)}개 항목을 복원할까요?`,
    message: `약 ${fmtBytes(bytes)} · 이미 보관 중인 사진은 자동으로 건너뛰어요.`,
    ok: '복원',
  });
  if (ok) await runImport(items, '복원하는 중');
}

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  const albumId = uploadAlbumId;
  uploadAlbumId = null;
  if (files.length) runImport(filesToItems(files, albumId ? { albumIds: [albumId] } : {}));
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files].filter((f) => kindOf(detectType(f.name, f.type)));
  folderInput.value = '';
  if (files.length) runImport(filesToItems(files));
  else toast('폴더에 사진이나 동영상이 없어요');
});

zipInput.addEventListener('change', () => {
  const files = [...zipInput.files];
  zipInput.value = '';
  restoreFromZips(files);
});

/* 끌어다 놓기 (PC) */
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = await collectDropped(e.dataTransfer);
  const zips = files.filter((f) => extOf(f.name) === 'zip');
  const media = files.filter((f) => kindOf(detectType(f.name, f.type)));
  const albumId = route.name === 'album' && lib.getAlbum(route.id) ? route.id : null;
  if (media.length) await runImport(filesToItems(media, albumId ? { albumIds: [albumId] } : {}));
  if (zips.length) await restoreFromZips(zips);
  if (!media.length && !zips.length) toast('사진이나 동영상 파일이 아니에요');
});

async function collectDropped(dt) {
  const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  };
  for (const entry of entries) {
    try {
      await walk(entry);
    } catch {
      /* 읽을 수 없는 항목은 건너뜀 */
    }
  }
  return out;
}

/* 공유하기로 받은 파일 (안드로이드 설치 앱) */
async function checkInbox() {
  let rows = [];
  try {
    rows = await readInbox();
  } catch {
    return;
  }
  if (!rows.length) return;
  const items = rows.filter((r) => r.file).map((r) => ({
    blob: r.file, name: r.name || r.file.name, type: r.type || r.file.type, lastModified: r.lastModified || r.file.lastModified,
  }));
  await runImport(items, '공유받은 사진 보관하는 중');
  try {
    await clearInbox(rows.map((r) => r.key));
  } catch {
    /* 다음 실행 때 중복으로 걸러짐 */
  }
}

/* ---------- 동작 처리 ---------- */

async function galleryMenu() {
  const items = [];
  if (list.length) items.push({ label: '선택하기', icon: 'select', value: 'select' });
  for (const [k, label] of Object.entries(GRID_SIZES)) {
    items.push({ label: `보기 크기: ${label}`, icon: 'grid', value: `grid:${k}`, checked: prefs.grid === k });
  }
  if (list.length > 1) items.push({ label: '슬라이드쇼', icon: 'slideshow', value: 'slideshow-all' });
  if (route.name === 'photos' && canPickFolder) items.push({ label: '폴더 통째로 추가', icon: 'folder', value: 'pick-folder' });
  if (route.name === 'album') {
    items.push({ label: '앨범 이름 바꾸기', icon: 'edit', value: 'rename-album' });
    items.push({ label: '앨범 삭제', icon: 'trash', value: 'delete-album', danger: true });
  }
  if (route.name === 'photos') items.push({ label: '설정', icon: 'settings', value: 'settings' });
  const v = await actionSheet({ items });
  if (!v) return;
  if (v.startsWith('grid:')) {
    setGrid(v.slice(5));
    return;
  }
  handleAction(v);
}

/** 그리드 크기 바꾸기. 화면 가운데 있던 사진이 계속 가운데 보이게 합니다. */
function setGrid(size) {
  if (!GRID_SIZES[size] || size === prefs.grid) return;
  const anchor = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest?.('.tile');
  prefs.grid = size;
  savePrefs();
  document.documentElement.dataset.grid = size;
  if (anchor?.isConnected) anchor.scrollIntoView({ block: 'center' });
  scroller.refresh(main);
}

function stepGrid(dir) {
  const i = GRID_ORDER.indexOf(prefs.grid);
  setGrid(GRID_ORDER[Math.min(GRID_ORDER.length - 1, Math.max(0, i + dir))]);
}

/* 두 손가락으로 그리드 크기 조절 (휴대폰), Ctrl + 휠 (PC) */
let pinch = null;
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
main.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && isGalleryRoute()) pinch = { d0: touchDist(e.touches), done: false };
}, { passive: true });
main.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2 || pinch.done) return;
  const r = touchDist(e.touches) / pinch.d0;
  if (r > 1.25 || r < 0.8) {
    pinch.done = true;
    stepGrid(r > 1 ? 1 : -1);
  }
}, { passive: true });
main.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinch = null;
});
main.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !isGalleryRoute()) return;
  e.preventDefault();
  if (Math.abs(e.deltaY) < 4) return;
  const now = performance.now();
  if (now - (main.lastZoom || 0) < 250) return;
  main.lastZoom = now;
  stepGrid(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

async function handleAction(act, el) {
  switch (act) {
    case 'search':
      searchQuery = '';
      location.hash = '#/search';
      break;
    case 'clear-search':
      setSearch('');
      appbar.querySelector('#search-input')?.focus();
      break;
    case 'search-chip':
      setSearch(el?.dataset.q || '');
      break;
    case 'settings':
      location.hash = '#/settings';
      break;
    case 'memory': {
      const g = memoryGroups[+el?.dataset.i];
      if (g) openViewer(g.items.map((m) => m.id), 0);
      break;
    }
    case 'slideshow-all':
      if (list.length) openViewer(list.map((m) => m.id), 0, { slideshow: true });
      break;
    case 'set-theme':
      prefs.theme = el.dataset.v;
      savePrefs();
      applyTheme();
      render();
      break;
    case 'set-grid':
      prefs.grid = el.dataset.v;
      savePrefs();
      document.documentElement.dataset.grid = prefs.grid;
      render();
      break;
    case 'lock-toggle':
      if (lock.isLockEnabled()) {
        if (!(await lock.verifyPin('앱 잠금 끄기'))) return;
        await lock.disableLock();
        toast('앱 잠금을 껐어요');
      } else {
        const pin = await lock.askNewPin();
        if (!pin) return;
        await lock.setPin(pin);
        toast('앱 잠금을 켰어요. 다음에 앱을 열 때 PIN을 입력해요.');
      }
      render();
      break;
    case 'lock-change': {
      if (!(await lock.verifyPin('PIN 변경'))) return;
      const pin = await lock.askNewPin();
      if (!pin) return;
      await lock.setPin(pin);
      toast('PIN을 바꿨어요');
      break;
    }
    case 'lock-delay':
      await lock.setDelay(+el.dataset.v);
      render();
      break;
    case 'wipe':
      await wipeFlow();
      break;
    case 'add':
      uploadAlbumId = null;
      fileInput.click();
      break;
    case 'pick-folder':
      folderInput.click();
      break;
    case 'restore-zip':
      zipInput.click();
      break;
    case 'menu':
      galleryMenu();
      break;
    case 'back':
      goBack();
      break;
    case 'select':
      enterSelection();
      break;
    case 'sel-exit':
      exitSelection();
      break;
    case 'sel-all': {
      const all = list.length > 0 && sel.ids.size === list.length;
      sel.ids.clear();
      if (!all) list.forEach((m) => sel.ids.add(m.id));
      updateSelectionUI();
      break;
    }
    case 'new-album': {
      const name = await promptDialog({ title: '새 앨범', placeholder: '앨범 이름', ok: '만들기' });
      if (!name) return;
      const album = await lib.createAlbum(name);
      location.hash = `#/album/${encodeURIComponent(album.id)}`;
      break;
    }
    case 'album-add': {
      const v = await actionSheet({
        title: '앨범에 사진 추가',
        items: [
          { label: '보관함에서 고르기', icon: 'photos', value: 'pick' },
          { label: '기기에서 올리기', icon: 'upload', value: 'upload', hint: '보관함과 이 앨범에 함께 저장돼요' },
        ],
      });
      if (v === 'pick') albumPickFlow();
      else if (v === 'upload') albumUploadFlow();
      break;
    }
    case 'album-pick':
      albumPickFlow();
      break;
    case 'album-upload':
      albumUploadFlow();
      break;
    case 'rename-album': {
      const album = lib.getAlbum(route.id);
      if (!album) return;
      const name = await promptDialog({ title: '앨범 이름 바꾸기', value: album.name, ok: '저장' });
      if (name) await lib.renameAlbum(album.id, name);
      break;
    }
    case 'delete-album': {
      const album = lib.getAlbum(route.id);
      if (!album) return;
      const ok = await confirmDialog({ title: `‘${album.name}’ 앨범을 삭제할까요?`, message: '앨범만 삭제되고 사진은 보관함에 그대로 남아요.', ok: '삭제', danger: true });
      if (!ok) return;
      await lib.deleteAlbum(album.id);
      location.replace('#/albums');
      toast('앨범을 삭제했어요');
      break;
    }
    case 'empty-trash': {
      const ids = lib.trashedMedia().map((m) => m.id);
      if (!ids.length) return;
      const ok = await confirmDialog({ title: '휴지통을 비울까요?', message: `${fmtNum(ids.length)}개 항목이 이 기기에서 완전히 지워지며 되돌릴 수 없어요.`, ok: '모두 삭제', danger: true });
      if (!ok) return;
      await lib.deleteForever(ids);
      toast('휴지통을 비웠어요');
      break;
    }
    case 'export-new':
      exportFlow(true);
      break;
    case 'export-all':
      exportFlow(false);
      break;
    case 'persist': {
      let granted = false;
      try {
        granted = await navigator.storage.persist();
      } catch {
        granted = false;
      }
      toast(granted ? '저장공간 보호를 켰어요. 공간이 부족해도 브라우저가 사진을 지우지 않아요.' : '브라우저가 요청을 받아들이지 않았어요. 앱을 홈 화면에 설치하면 보호될 가능성이 높아요.', { duration: 5000 });
      fillStorage();
      break;
    }
    case 'install':
      if (installEvent) {
        installEvent.prompt();
        await installEvent.userChoice.catch(() => null);
        installEvent = null;
        if (route.name === 'backup') render();
      }
      break;
    default:
      if (sel.active) await onSelectionAction(act);
  }
}

async function onSelectionAction(act) {
  const ids = [...sel.ids];
  const items = ids.map((id) => store.byId.get(id)).filter(Boolean);
  const n = items.length;
  if (!n) return;
  switch (act) {
    case 'share':
      await shareItems(items);
      break;
    case 'favorite': {
      const allFav = items.every((m) => m.favorite);
      await lib.setFavorite(ids, !allFav);
      exitSelection();
      toast(allFav ? `${fmtNum(n)}개를 즐겨찾기에서 뺐어요` : `${fmtNum(n)}개를 즐겨찾기에 추가했어요`);
      break;
    }
    case 'add-to-album':
      if (await addToAlbumFlow(ids)) exitSelection();
      break;
    case 'remove-from-album':
      await lib.removeFromAlbum(route.id, ids);
      exitSelection();
      toast(`앨범에서 ${fmtNum(n)}개를 뺐어요 (보관함에는 남아 있어요)`);
      break;
    case 'download':
      await downloadItems(items);
      break;
    case 'delete': {
      const ok = await confirmDialog({ title: `${fmtNum(n)}개 항목을 삭제할까요?`, message: `휴지통으로 이동하며 ${lib.TRASH_DAYS}일 동안 복원할 수 있어요.`, ok: '삭제', danger: true });
      if (!ok) return;
      await lib.moveToTrash(ids);
      exitSelection();
      toast('휴지통으로 이동했어요', { action: '실행 취소', onAction: () => lib.restore(ids) });
      break;
    }
    case 'restore':
      await lib.restore(ids);
      exitSelection();
      toast(`${fmtNum(n)}개를 복원했어요`);
      break;
    case 'delete-forever': {
      const ok = await confirmDialog({ title: `${fmtNum(n)}개 항목을 영구 삭제할까요?`, message: '이 기기에서 완전히 지워지며 되돌릴 수 없어요.', ok: '영구 삭제', danger: true });
      if (!ok) return;
      await lib.deleteForever(ids);
      exitSelection();
      toast('영구 삭제했어요');
      break;
    }
    default:
  }
}

appbar.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) handleAction(a.dataset.act, a);
});
selbar.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a && !a.disabled) handleAction(a.dataset.act, a);
});
tabbar.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && TAB_OF[route.name] === tab.dataset.tab && routeKey(route) === tab.dataset.tab) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

document.addEventListener('keydown', (e) => {
  if (viewer || editor || isModalOpen() || lock.isLocked()) return;
  if (e.key === 'Escape' && sel.active) exitSelection();
  else if ((e.ctrlKey || e.metaKey) && e.key === 'a' && isGalleryRoute() && list.length && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    if (!sel.active) enterSelection();
    list.forEach((m) => sel.ids.add(m.id));
    updateSelectionUI();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (busy > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (route.name === 'backup') render();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  toast('홈 화면에 설치했어요');
});

/* ---------- 시작 ---------- */

function buildTabbar() {
  tabbar.innerHTML = [
    ['photos', 'photos', '사진'],
    ['albums', 'albums', '앨범'],
    ['backup', 'cloud', '백업'],
  ].map(([k, ic, label]) => `<a class="tab" href="#/${k}" data-tab="${k}">${icon(ic)}<span>${label}</span></a>`).join('');
}

async function wipeFlow({ fromLock = false } = {}) {
  const ok = await confirmDialog({
    title: fromLock ? 'PIN을 잊으셨나요?' : '모든 데이터를 삭제할까요?',
    message: fromLock
      ? 'PIN은 되찾을 수 없어요. 이 기기에 보관한 사진·앨범·설정을 모두 지우고 처음 상태로 되돌리면 다시 쓸 수 있어요. 백업 파일이 있다면 나중에 복원할 수 있어요.'
      : '이 기기에 보관한 사진, 앨범, 휴지통, 설정이 모두 지워지며 되돌릴 수 없어요. 먼저 백업 파일을 만들어 두세요.',
    ok: '모두 삭제',
    danger: true,
  });
  if (!ok) return;
  const again = await confirmDialog({ title: '정말 삭제할까요?', message: '마지막 확인이에요. 삭제한 사진은 복구할 수 없어요.', ok: '영구 삭제', danger: true });
  if (!again) return;
  await lib.wipeAll();
  try {
    localStorage.removeItem('pv-prefs');
  } catch {
    /* 무시 */
  }
  location.replace(`${location.pathname}#/photos`);
  location.reload();
}

function showFatal(message) {
  main.innerHTML = emptyHTML({ ic: 'info', title: '보관함을 열 수 없어요', text: esc(message) });
}

async function start() {
  buildTabbar();
  render();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  if (!('indexedDB' in window)) {
    showFatal('이 브라우저는 사진 저장 기능(IndexedDB)을 지원하지 않아요. 최신 Chrome, Safari, Edge, 삼성 인터넷을 이용해 주세요.');
    return;
  }
  lib.subscribe(() => {
    cleanupThumbs();
    scheduleRender();
  });
  let unlocked = Promise.resolve();
  try {
    if (await lock.initLock({ forgot: () => wipeFlow({ fromLock: true }) })) unlocked = lock.lock();
  } catch {
    /* 잠금 설정을 읽지 못하면 잠그지 않음 */
  }
  try {
    await lib.load();
  } catch (err) {
    console.error(err);
    showFatal('브라우저 저장소를 열지 못했어요. 시크릿(비공개) 모드라면 일반 모드로 열어 주세요.');
    return;
  }
  await unlocked;
  checkInbox();
  window.addEventListener('resize', () => {
    if (isGalleryRoute()) scroller.refresh(main);
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('새 버전이 준비됐어요', { action: '새로고침', onAction: () => location.reload() });
    });
  }
}

start();
