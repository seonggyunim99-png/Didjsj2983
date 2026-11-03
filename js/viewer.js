// 전체화면 뷰어: 좌우 스와이프, 핀치/더블탭/휠 확대, 아래로 밀어서 닫기
import {
  icon, esc, fmtDay, fmtTime, fmtDateTime, fmtBytes, fmtDuration, isModalOpen,
} from './ui.js';

const GAP = 16;
const MAX_SCALE = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Viewer {
  /**
   * @param {{ids:string[], index:number, mode:'normal'|'trash', ctx:{
   *   get:(id:string)=>any, thumbURL:(m:any)=>string|null, loadOriginal:(id:string)=>Promise<Blob>,
   *   onAction:(action:string, id:string)=>void, onRequestClose:()=>void, onIndexChange?:(id:string)=>void,
   *   albumNames:(m:any)=>string[] }}} opts
   */
  constructor({ ids, index, mode, ctx }) {
    this.ids = ids.slice();
    this.index = clamp(index, 0, ids.length - 1);
    this.mode = mode;
    this.ctx = ctx;
    this.urls = new Map();
    this.loading = new Map();
    this.pointers = new Map();
    this.g = null;
    this.z = { s: 1, x: 0, y: 0 };
    this.animating = false;

    const root = document.createElement('div');
    root.className = 'viewer';
    root.innerHTML = `
      <div class="v-stage">
        <div class="v-track"><div class="v-slide"></div><div class="v-slide"></div><div class="v-slide"></div></div>
      </div>
      <div class="v-top">
        <button type="button" class="v-btn" data-act="close" aria-label="닫기">${icon('back')}</button>
        <div class="v-title"><strong></strong><small></small></div>
        <button type="button" class="v-btn" data-act="more" aria-label="더보기" title="더보기">${icon('more')}</button>
      </div>
      <button type="button" class="v-nav prev" data-act="prev" aria-label="이전">${icon('chevronLeft')}</button>
      <button type="button" class="v-nav next" data-act="next" aria-label="다음">${icon('chevronRight')}</button>
      <div class="v-bottom">${this.mode === 'trash' ? `
        <button type="button" class="v-btn labeled" data-act="restore">${icon('restore')}<span>복원</span></button>
        <button type="button" class="v-btn labeled" data-act="info">${icon('info')}<span>정보</span></button>
        <button type="button" class="v-btn labeled" data-act="delete-forever">${icon('trash')}<span>영구 삭제</span></button>` : `
        <button type="button" class="v-btn labeled" data-act="favorite">${icon('heartOutline')}<span>즐겨찾기</span></button>
        <button type="button" class="v-btn labeled" data-act="edit">${icon('tune')}<span>편집</span></button>
        <button type="button" class="v-btn labeled" data-act="share">${icon('share')}<span>공유</span></button>
        <button type="button" class="v-btn labeled" data-act="info">${icon('info')}<span>정보</span></button>
        <button type="button" class="v-btn labeled" data-act="delete">${icon('trash')}<span>삭제</span></button>`}
      </div>
      <div class="v-info" hidden></div>`;
    this.root = root;
    this.stage = root.querySelector('.v-stage');
    this.track = root.querySelector('.v-track');
    this.slots = [...this.track.children];
    document.getElementById('viewer-root').appendChild(root);
    document.body.classList.add('viewer-open');

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onResize = () => {
      this.positionSlots();
      this.resetZoom(false);
    };
    this.stage.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    this.stage.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    root.addEventListener('click', (e) => this.onClick(e));

    this.positionSlots();
    this.fill();
    requestAnimationFrame(() => root.classList.add('open'));
  }

  get current() {
    return this.ctx.get(this.ids[this.index]);
  }

  get slot() {
    return this.slots[1];
  }

  get img() {
    return this.slot.querySelector('.v-img');
  }

  /* ---------- 슬라이드 구성 ---------- */

  positionSlots() {
    this.slots.forEach((s, k) => {
      s.style.transform = `translate3d(calc(${(k - 1) * 100}% + ${(k - 1) * GAP}px), 0, 0)`;
    });
  }

  setTrack(x, animate, y = 0, scale = 1) {
    this.track.style.transition = animate ? 'transform .3s cubic-bezier(.2,.8,.2,1)' : 'none';
    this.track.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  }

  original(id) {
    if (this.urls.has(id)) return Promise.resolve(this.urls.get(id));
    if (!this.loading.has(id)) {
      const p = this.ctx.loadOriginal(id).then((blob) => {
        this.loading.delete(id);
        if (!blob || this.destroyed) return null;
        const url = URL.createObjectURL(blob);
        this.urls.set(id, url);
        return url;
      });
      this.loading.set(id, p);
    }
    return this.loading.get(id);
  }

  renderSlot(slot, idx) {
    const id = this.ids[idx];
    if (!id) {
      slot.dataset.id = '';
      slot.innerHTML = '';
      return;
    }
    if (slot.dataset.id === id) return;
    slot.dataset.id = id;
    slot.classList.remove('unsupported');
    const m = this.ctx.get(id);
    if (!m) {
      slot.innerHTML = '';
      return;
    }
    const thumb = this.ctx.thumbURL(m);
    if (m.kind === 'video') {
      slot.innerHTML = `<video class="v-video" controls playsinline preload="metadata"${thumb ? ` poster="${thumb}"` : ''}></video>`;
      this.original(id).then((url) => {
        if (url && slot.dataset.id === id) slot.querySelector('video').src = url;
      });
    } else {
      slot.innerHTML = `<img class="v-img" alt="${esc(m.name)}" draggable="false"${thumb ? ` src="${thumb}"` : ''}>
        <div class="v-unsupported">${icon('image')}<p>이 형식(${esc(m.type.split('/')[1] || '')})은 브라우저에서 미리 볼 수 없어요.<br>원본은 안전하게 보관돼 있어요. 다운로드해서 확인하세요.</p></div>`;
      const img = slot.querySelector('img');
      if (!thumb) img.style.visibility = 'hidden';
      this.original(id).then((url) => {
        if (!url || slot.dataset.id !== id) return;
        const probe = new Image();
        probe.onload = () => {
          if (slot.dataset.id !== id) return;
          img.src = url;
          img.style.visibility = '';
        };
        probe.onerror = () => {
          if (slot.dataset.id === id && !thumb) slot.classList.add('unsupported');
        };
        probe.src = url;
      });
    }
  }

  fill(force = false) {
    if (force) this.slots.forEach((s) => { s.dataset.id = ''; });
    this.renderSlot(this.slots[0], this.index - 1);
    this.renderSlot(this.slots[1], this.index);
    this.renderSlot(this.slots[2], this.index + 1);
    this.slots.forEach((s, k) => {
      if (k !== 1) s.querySelector('video')?.pause();
    });
    this.z = { s: 1, x: 0, y: 0 };
    this.slots.forEach((s) => {
      const img = s.querySelector('.v-img');
      if (img) {
        img.style.transition = 'none';
        img.style.transform = '';
      }
    });
    this.root.classList.remove('zoomed');
    this.gcUrls();
    this.updateChrome();
    this.ctx.onIndexChange?.(this.ids[this.index]);
  }

  gcUrls() {
    const keep = new Set([this.ids[this.index - 1], this.ids[this.index], this.ids[this.index + 1]]);
    for (const [id, url] of this.urls) {
      if (!keep.has(id)) {
        URL.revokeObjectURL(url);
        this.urls.delete(id);
      }
    }
  }

  updateChrome() {
    const m = this.current;
    if (!m) return;
    this.root.querySelector('.v-title strong').textContent = fmtDay(m.takenAt);
    this.root.querySelector('.v-title small').textContent = `${fmtTime(m.takenAt)} · ${this.index + 1} / ${this.ids.length}`;
    const fav = this.root.querySelector('[data-act="favorite"]');
    if (fav) {
      fav.innerHTML = `${icon(m.favorite ? 'heart' : 'heartOutline')}<span>즐겨찾기</span>`;
      fav.classList.toggle('active', !!m.favorite);
    }
    const edit = this.root.querySelector('[data-act="edit"]');
    if (edit) {
      // 동영상은 '편집' 대신 지금 장면을 사진으로 저장하는 '캡처'
      edit.innerHTML = m.kind === 'video' ? `${icon('camera')}<span>캡처</span>` : `${icon('tune')}<span>편집</span>`;
      edit.title = m.kind === 'video' ? '지금 장면을 사진으로 저장' : '편집';
    }
    this.root.querySelector('.v-nav.prev').hidden = this.index <= 0;
    this.root.querySelector('.v-nav.next').hidden = this.index >= this.ids.length - 1;
    if (!this.root.querySelector('.v-info').hidden) this.renderInfo();
  }

  /** 외부에서 데이터가 바뀌었을 때 (예: 즐겨찾기) */
  refresh() {
    this.updateChrome();
  }

  /** 편집 등으로 현재 사진 파일이 바뀌었을 때 다시 불러옵니다. */
  reloadCurrent() {
    const id = this.ids[this.index];
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.loading.delete(id);
    this.slot.dataset.id = '';
    this.renderSlot(this.slot, this.index);
    this.resetZoom(false);
    this.updateChrome();
  }

  /** 동영상의 지금 장면을 캔버스로 */
  captureFrame() {
    const v = this.slot.querySelector('video');
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { canvas: c, time: v.currentTime };
  }

  /* ---------- 슬라이드쇼 ---------- */

  startSlideshow() {
    if (this.slideTimer || this.ids.length < 2) return;
    this.root.classList.add('chrome-hidden', 'slideshow');
    this.toggleInfo(false);
    this.slideTimer = setInterval(() => {
      if (this.index >= this.ids.length - 1) this.stopSlideshow();
      else this.go(1);
    }, 3500);
    navigator.wakeLock?.request('screen').then((w) => { this.wake = w; }).catch(() => {});
  }

  stopSlideshow() {
    if (!this.slideTimer) return;
    clearInterval(this.slideTimer);
    this.slideTimer = 0;
    this.root.classList.remove('chrome-hidden', 'slideshow');
    this.wake?.release?.().catch(() => {});
    this.wake = null;
  }

  /** 현재 항목을 목록에서 빼고 다음 항목으로 넘어갑니다. */
  removeCurrent() {
    this.ids.splice(this.index, 1);
    if (!this.ids.length) {
      this.ctx.onRequestClose();
      return;
    }
    if (this.index >= this.ids.length) this.index = this.ids.length - 1;
    this.fill(true);
  }

  go(dir) {
    if (this.animating) return;
    const next = this.index + dir;
    if (next < 0 || next >= this.ids.length) {
      this.setTrack(0, true);
      return;
    }
    this.animating = true;
    const w = this.stage.clientWidth + GAP;
    this.setTrack(-dir * w, true);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.index = next;
      if (dir > 0) this.slots.push(this.slots.shift());
      else this.slots.unshift(this.slots.pop());
      this.positionSlots();
      this.setTrack(0, false);
      this.fill();
      this.animating = false;
    };
    this.track.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 380);
  }

  /* ---------- 확대/축소 ---------- */

  contentBox() {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const img = this.img;
    const m = this.current;
    const nw = img?.naturalWidth || m?.width || W;
    const nh = img?.naturalHeight || m?.height || H;
    const r = Math.min(W / nw, H / nh);
    const cw = nw * r;
    const ch = nh * r;
    return { W, H, x0: (W - cw) / 2, y0: (H - ch) / 2, cw, ch };
  }

  clampZoom() {
    const z = this.z;
    const { W, H, x0, y0, cw, ch } = this.contentBox();
    if (cw * z.s <= W) z.x = (W / 2) * (1 - z.s);
    else z.x = clamp(z.x, W - (x0 + cw) * z.s, -x0 * z.s);
    if (ch * z.s <= H) z.y = (H / 2) * (1 - z.s);
    else z.y = clamp(z.y, H - (y0 + ch) * z.s, -y0 * z.s);
  }

  applyZoom(animate) {
    const img = this.img;
    if (!img) return;
    img.style.transition = animate ? 'transform .25s cubic-bezier(.2,.8,.2,1)' : 'none';
    img.style.transform = `translate3d(${this.z.x}px, ${this.z.y}px, 0) scale(${this.z.s})`;
    this.root.classList.toggle('zoomed', this.z.s > 1.01);
  }

  zoomAt(px, py, s) {
    const z = this.z;
    const ns = clamp(s, 1, MAX_SCALE);
    z.x = px - ((px - z.x) * ns) / z.s;
    z.y = py - ((py - z.y) * ns) / z.s;
    z.s = ns;
  }

  resetZoom(animate) {
    this.z = { s: 1, x: 0, y: 0 };
    this.applyZoom(animate);
  }

  local(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ---------- 제스처 ---------- */

  onDown(e) {
    if (this.slideTimer) {
      this.stopSlideshow();
      return;
    }
    if (this.animating || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const video = e.target.closest('video');
    if (video) {
      const r = video.getBoundingClientRect();
      if (e.clientY > r.bottom - 72) return; // 재생바 영역은 동영상 컨트롤에 양보
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (this.pointers.size === 1) {
      this.g = {
        mode: 'pending', sx: e.clientX, sy: e.clientY, t: now, lx: e.clientX, ly: e.clientY, lt: now,
        vx: 0, vy: 0, z0: { ...this.z }, onVideo: !!video, target: e.target,
      };
    } else if (this.pointers.size === 2 && this.img) {
      const [a, b] = [...this.pointers.values()];
      const r = this.stage.getBoundingClientRect();
      const c = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      this.setTrack(0, true);
      this.g = {
        mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: { ...this.z },
        p: { x: (c.x - this.z.x) / this.z.s, y: (c.y - this.z.y) / this.z.s },
      };
    }
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.g;
    if (!g) return;

    if (g.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const r = this.stage.getBoundingClientRect();
      const c = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const s = clamp((g.z0.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, 0.7, MAX_SCALE);
      this.z = { s, x: c.x - g.p.x * s, y: c.y - g.p.y * s };
      this.applyZoom(false);
      return;
    }

    const now = performance.now();
    const dt = Math.max(1, now - g.lt);
    g.vx = (e.clientX - g.lx) / dt;
    g.vy = (e.clientY - g.ly) / dt;
    g.lx = e.clientX;
    g.ly = e.clientY;
    g.lt = now;

    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      if (this.z.s > 1.01 && !g.onVideo) g.mode = 'pan';
      else if (Math.abs(dx) > Math.abs(dy)) g.mode = 'swipe';
      else if (dy > 0) g.mode = 'dismiss';
      else g.mode = 'none';
      if (g.mode !== 'none') this.root.classList.add('dragging');
    }

    if (g.mode === 'pan') {
      this.z.x = g.z0.x + dx;
      this.z.y = g.z0.y + dy;
      this.clampZoom();
      this.applyZoom(false);
    } else if (g.mode === 'swipe') {
      const atEdge = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.ids.length - 1);
      this.setTrack(atEdge ? dx / 3 : dx, false);
    } else if (g.mode === 'dismiss') {
      const p = Math.max(0, dy);
      const H = this.stage.clientHeight || 1;
      this.setTrack(dx * 0.4, false, p, 1 - Math.min(p / H, 1) * 0.3);
      this.root.style.setProperty('--v-bg', String(1 - Math.min(p / (H * 0.6), 1) * 0.85));
    }
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g) return;

    if (g.mode === 'pinch') {
      if (this.pointers.size === 1) {
        const [p] = [...this.pointers.values()];
        const now = performance.now();
        this.g = { mode: 'pan', sx: p.x, sy: p.y, t: now, lx: p.x, ly: p.y, lt: now, vx: 0, vy: 0, z0: { ...this.z } };
        return;
      }
      if (this.pointers.size === 0) {
        if (this.z.s <= 1.01) this.resetZoom(true);
        else {
          this.clampZoom();
          this.applyZoom(true);
        }
        this.g = null;
      }
      return;
    }
    if (this.pointers.size > 0) return;
    this.g = null;
    this.root.classList.remove('dragging');
    if (e.type === 'pointercancel') {
      this.setTrack(0, true);
      this.root.style.removeProperty('--v-bg');
      return;
    }

    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.mode === 'pending') {
      if (performance.now() - g.t < 400) this.onTap(e, g);
    } else if (g.mode === 'swipe') {
      const w = this.stage.clientWidth;
      if ((dx < -w * 0.2 || g.vx < -0.45) && this.index < this.ids.length - 1) this.go(1);
      else if ((dx > w * 0.2 || g.vx > 0.45) && this.index > 0) this.go(-1);
      else this.setTrack(0, true);
    } else if (g.mode === 'dismiss') {
      if (dy > 120 || g.vy > 0.7) {
        this.ctx.onRequestClose();
      } else {
        this.setTrack(0, true);
        this.root.style.removeProperty('--v-bg');
      }
    } else if (g.mode === 'pan') {
      this.clampZoom();
      this.applyZoom(true);
    }
  }

  onTap(e, g) {
    if (g.onVideo) return; // 동영상은 자체 컨트롤로 재생/정지
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.t < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      if (!this.img) return;
      if (this.z.s > 1.01) this.resetZoom(true);
      else {
        const p = this.local(e);
        this.zoomAt(p.x, p.y, 2.5);
        this.clampZoom();
        this.applyZoom(true);
      }
      return;
    }
    this.lastTap = { t: now, x: e.clientX, y: e.clientY };
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      this.root.classList.toggle('chrome-hidden');
    }, 280);
  }

  onWheel(e) {
    if (!this.img) return;
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, this.z.s * Math.exp(-e.deltaY * 0.0018));
    this.clampZoom();
    this.applyZoom(false);
  }

  onKey(e) {
    if (isModalOpen() || document.body.classList.contains('editor-open') || document.body.classList.contains('locked')) return;
    if (this.slideTimer) {
      this.stopSlideshow();
      if (e.key !== 'Escape') return;
    }
    if (e.key === 'ArrowRight') this.go(1);
    else if (e.key === 'ArrowLeft') this.go(-1);
    else if (e.key === 'Escape') {
      if (!this.root.querySelector('.v-info').hidden) this.toggleInfo(false);
      else this.ctx.onRequestClose();
    } else return;
    e.preventDefault();
  }

  onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      if (e.target.closest('.v-info-backdrop')) this.toggleInfo(false);
      return;
    }
    const act = btn.dataset.act;
    const id = this.ids[this.index];
    if (act === 'close') this.ctx.onRequestClose();
    else if (act === 'prev') this.go(-1);
    else if (act === 'next') this.go(1);
    else if (act === 'info') this.toggleInfo();
    else if (act === 'info-close') this.toggleInfo(false);
    else this.ctx.onAction(act, id);
  }

  /* ---------- 정보 패널 ---------- */

  toggleInfo(force) {
    const panel = this.root.querySelector('.v-info');
    const show = force ?? panel.hidden;
    panel.hidden = !show;
    if (show) this.renderInfo();
  }

  renderInfo() {
    const m = this.current;
    if (!m) return;
    const rows = [
      ['촬영 일시', fmtDateTime(m.takenAt)],
      ['파일 이름', m.name],
      ['형식', m.type],
      ['크기', fmtBytes(m.size)],
    ];
    if (m.width && m.height) rows.push(['해상도', `${m.width} × ${m.height} (${((m.width * m.height) / 1e6).toFixed(1)}MP)`]);
    if (m.kind === 'video' && m.duration) rows.push(['길이', fmtDuration(m.duration)]);
    const albums = this.ctx.albumNames(m);
    if (albums.length) rows.push(['앨범', albums.join(', ')]);
    if (m.edited) rows.push(['편집', `${fmtDateTime(m.editedAt)}에 편집함 · 원본 보관 중`]);
    rows.push(['보관한 날', fmtDateTime(m.addedAt)]);
    rows.push(['백업 파일', m.exportedAt ? `${fmtDateTime(m.exportedAt)}에 내보냄` : '아직 내보내지 않음']);
    this.root.querySelector('.v-info').innerHTML = `
      <div class="v-info-backdrop"></div>
      <div class="v-info-card">
        <div class="v-info-head"><strong>상세 정보</strong>
          <button type="button" class="v-btn" data-act="info-close" aria-label="닫기">${icon('close')}</button></div>
        <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <dl class="v-exif"></dl>
      </div>`;
    if (m.kind !== 'image' || !this.ctx.loadDetails) return;
    const token = (this.infoToken = (this.infoToken || 0) + 1);
    this.ctx.loadDetails(m).then((extra) => {
      const box = this.root.querySelector('.v-exif');
      if (!box || token !== this.infoToken || !extra?.length) return;
      box.innerHTML = extra.map(([k, v, link]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">지도에서 보기</a>` : ''}</dd></div>`).join('');
    }).catch(() => {});
  }

  /* ---------- 종료 ---------- */

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSlideshow();
    clearTimeout(this.tapTimer);
    this.stage.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.slots.forEach((s) => s.querySelector('video')?.pause());
    this.root.classList.remove('open');
    this.root.classList.add('closing');
    document.body.classList.remove('viewer-open');
    setTimeout(() => {
      this.root.remove();
      for (const url of this.urls.values()) URL.revokeObjectURL(url);
      this.urls.clear();
    }, 220);
  }
}
