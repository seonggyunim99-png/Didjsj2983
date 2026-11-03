// 사진 편집기: 보정(자동·장면) · 자르기/원근 · 필터 · 조정(빛·색상·효과·디테일·톤 커브·색상별·컬러 그레이딩)
//             · 인물(얼굴 인식 뷰티 · 잡티 제거) · 성형(손으로 밀기·크게·작게) · 부분(칠해서 보정) · 그리기
import { icon, esc, toast, confirmDialog, actionSheet, isModalOpen, promptDialog } from './ui.js';
import * as looks from './looks.js';
import * as dv from './develop.js';
import * as im from './imaging.js';
import { createRenderer, measure, renderFinal, drawStrokes, drawItems, FRAME_ASPECTS, frameOn, frameDims } from './glrender.js';
import { detectFaces, detectPoses, segmentPerson, AUTO_BEAUTY, LIP_COLORS, BLUSH_COLORS, SHADOW_COLORS, HAIR_COLORS, CLOTH_COLORS } from './face.js';
import { SKIES, detectSky } from './sky.js';
import { LIQ_TOOLS, LOCAL_TOOLS } from './retouch.js';
import { removeArea } from './inpaint.js';
import { upscale2x } from './upscale.js';

const TABS = [
  ['enhance', 'auto', '보정'],
  ['crop', 'crop', '자르기'],
  ['filter', 'filter', '필터'],
  ['adjust', 'tune', '조정'],
  ['beauty', 'face', '인물'],
  ['reshape', 'touch', '성형'],
  ['local', 'magic', '부분'],
  ['draw', 'brush', '꾸미기'],
];
const ASPECTS = [['free', '자유'], ['orig', '원본'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16']];
const TOOLS = [
  ['text', 'edit', '글자'], ['sticker', 'face', '스티커'], ['date', 'event', '날짜'], ['cover', 'mosaic', '얼굴 가리기'],
  ['frame', 'crop', '비율·여백'], ['pen', 'edit', '펜'], ['marker', 'brush', '형광펜'], ['mosaic', 'mosaic', '모자이크'],
];
const STICKERS = ['😊', '😍', '🥰', '😎', '🤩', '😂', '🥺', '😋', '❤️', '💕', '💖', '✨', '⭐', '🌟', '🔥', '🎉', '🎂', '🌸', '🌷', '🌈', '☀️', '🌙', '☁️', '🍀', '🐶', '🐱', '🐰', '🐻', '🍓', '🍰', '☕', '🍺', '👍', '✌️', '👑', '💯', '📍', '📸', '🎵', '🎀'];
const TEXT_COLORS = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ff7eb6'];
const TEXT_FONTS = [['sans', '고딕'], ['serif', '명조'], ['hand', '손글씨'], ['round', '둥근']];
const TEXT_STYLES = [['plain', '기본'], ['outline', '테두리'], ['box', '배경']];
const COVER_MODES = [['mosaic', '모자이크'], ['blur', '흐림'], ['emoji', '스마일']];
const ITEM_TOOLS = ['text', 'sticker', 'date', 'cover'];
const COLORS = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];
const CURVE_CH = [['rgb', 'RGB', '#e5e7eb'], ['r', '빨강', '#ef4444'], ['g', '초록', '#22c55e'], ['b', '파랑', '#3b82f6']];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TRACKS = {
  temp: 'linear-gradient(to right, #4a7dff, #d8dbe0, #ffb43a)',
  tint: 'linear-gradient(to right, #3fbf5a, #d8dbe0, #d35bd3)',
  saturation: 'linear-gradient(to right, #8a8f98, #ff5a5a)',
  vibrance: 'linear-gradient(to right, #8a8f98, #ffb03a)',
  hue: 'linear-gradient(to right, #ff4040, #ffd040, #40ff60, #40e0ff, #4060ff, #e040ff, #ff4040)',
};
const WORK_MAX = 2048;
const AUTO_GROUPS = ['skin', 'shape', 'parts'];
const FACE_GROUPS = ['skin', 'shape', 'parts', 'makeup'];
const MK_COLORS = { lip: LIP_COLORS, blush: BLUSH_COLORS, shadow: SHADOW_COLORS, hair: HAIR_COLORS, cloth: CLOTH_COLORS };
const MK_KEY = { lip: 'mkLip', blush: 'mkBlush', shadow: 'mkShadow', hair: 'hairAmt', cloth: 'clothAmt' };
const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
const MIN_CROP = 0.06;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);
const { decode, dimsOf } = im;

function aspectValue(aspect, fw, fh) {
  if (aspect === 'free') return null;
  if (aspect === 'orig') return fw / fh;
  const [a, b] = aspect.split(':').map(Number);
  return a / b;
}

function resizeRect(r0, hd, dx, dy, ratio) {
  let x1 = r0.x;
  let y1 = r0.y;
  let x2 = r0.x + r0.w;
  let y2 = r0.y + r0.h;
  if (hd.includes('w')) x1 = clamp(r0.x + dx, 0, x2 - MIN_CROP);
  if (hd.includes('e')) x2 = clamp(x2 + dx, x1 + MIN_CROP, 1);
  if (hd.includes('n')) y1 = clamp(r0.y + dy, 0, y2 - MIN_CROP);
  if (hd.includes('s')) y2 = clamp(y2 + dy, y1 + MIN_CROP, 1);
  if (!ratio) return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  let w = x2 - x1;
  let h = y2 - y1;
  if (hd === 'e' || hd === 'w') h = w / ratio;
  else if (hd === 'n' || hd === 's') w = h * ratio;
  else if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  const ax = hd.includes('w') ? r0.x + r0.w : hd.includes('e') ? r0.x : r0.x + r0.w / 2;
  const ay = hd.includes('n') ? r0.y + r0.h : hd.includes('s') ? r0.y : r0.y + r0.h / 2;
  const maxW = hd.includes('w') ? ax : hd.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
  const maxH = hd.includes('n') ? ay : hd.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  if (w < MIN_CROP || h < MIN_CROP) return r0;
  return {
    x: hd.includes('w') ? ax - w : hd.includes('e') ? ax : ax - w / 2,
    y: hd.includes('n') ? ay - h : hd.includes('s') ? ay : ay - h / 2,
    w,
    h,
  };
}

function fitAspect(ratio) {
  if (!ratio) return { ...dv.FULL };
  let w = 1;
  let h = 1 / ratio;
  if (h > 1) {
    h = 1;
    w = ratio;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

const fmtAdj = (a, v) => (a.fmt ? a.fmt(v) : signed(v));

export class Editor {
  /** @param {{blob:Blob, type:string, name:string, onSave:(blob:Blob, asCopy:boolean)=>Promise<void>, onCancel:()=>void}} opts */
  static async open(opts) {
    const ed = new Editor(opts);
    await ed.load();
    return ed;
  }

  constructor({ blob, type, name, state = null, takenAt = 0, onSave, onCancel }) {
    this.blob = blob;
    this.initState = state;
    this.type = type;
    this.name = name;
    this.onSave = onSave;
    this.onCancel = onCancel;
    this.st = dv.defaultState();
    this.history = [JSON.stringify(this.st)];
    this.hIndex = 0;
    this.tab = 'enhance';
    this.group = 'light';
    this.curveCh = 'rgb';
    this.band = 'red';
    this.gradeRange = 'shadows';
    this.color = '#ff3b30';
    this.sizes = { pen: 6, marker: 18, mosaic: 26 };
    this.tool = 'text';
    this.selItem = -1; // 고른 글자·스티커
    this.sticker = '😊';
    this.coverMode = 'mosaic';
    this.takenAt = takenAt || Date.now();
    this.healMode = false;
    this.healSize = 12;
    this.bgroup = 'skin';
    // 성형(손으로 모양 다듬기) · 부분 보정 브러시
    this.liq = { tool: 'push', size: 40, strength: 60 };
    this.lc = { tool: 'light', size: 24, strength: 40 };
    this.er = { tool: 'fx', size: 26, strength: 100 }; // 보정 지우개
    this.eraseMode = false;
    this.showLocal = false;
    this.op = null;
    this.faces = undefined; // undefined 아직 · null 찾는 중 실패 · [] 없음 · [...] 찾음
    this.faceState = 'idle';
    this.poses = null;
    this.poseState = 'idle';
    this.person = null;
    this.segState = 'idle';
    this.sky = null;
    this.skyState = 'idle';
    this.faceSel = -1; // 얼굴별 따로 보정: -1 = 모든 얼굴
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.baseDirty = true;
    this.cur = null;
    this.appliedHeals = '[]';

    const root = document.createElement('div');
    root.className = 'editor loading';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '사진 편집');
    root.innerHTML = `
      <header class="ed-top">
        <button type="button" class="ed-icon" data-act="cancel" aria-label="편집 닫기" title="닫기">${icon('close')}</button>
        <div class="ed-history">
          <button type="button" class="ed-icon" data-act="undo" aria-label="실행 취소" title="실행 취소">${icon('undo')}</button>
          <button type="button" class="ed-icon" data-act="redo" aria-label="다시 실행" title="다시 실행">${icon('redo')}</button>
          <button type="button" class="ed-icon" data-act="compare" aria-label="원본과 비교 (누르면 나눠 보기, 누르고 있으면 원본)" title="누르면 반반 비교 · 누르고 있으면 원본">${icon('compare')}</button>
        </div>
        <button type="button" class="btn primary sm" data-act="save">저장</button>
      </header>
      <div class="ed-stage">
        <canvas class="ed-frame" width="2" height="2" hidden></canvas>
        <canvas class="ed-canvas"></canvas>
        <div class="ed-crop" hidden><i class="ed-grid"></i>${HANDLES.map((h) => `<span class="ed-h ed-h-${h}" data-h="${h}"></span>`).join('')}</div>
        <canvas class="ed-hist" width="160" height="70" hidden></canvas>
        <button type="button" class="ed-zoom" data-act="zoom-reset" hidden></button>
        <div class="ed-ring" hidden></div>
        <div class="ed-split" hidden><i></i><b>${icon('compare')}</b><span class="l">원본</span><span class="r">보정</span></div>
        <div class="ed-busy"><i></i><span></span></div>
      </div>
      <div class="ed-panel"></div>
      <nav class="ed-tabs">${TABS.map(([k, ic, label]) => `<button type="button" class="ed-tab" data-tab="${k}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>`;
    this.root = root;
    this.stage = root.querySelector('.ed-stage');
    this.canvas = root.querySelector('.ed-canvas');
    this.cropEl = root.querySelector('.ed-crop');
    this.histEl = root.querySelector('.ed-hist');
    this.zoomEl = root.querySelector('.ed-zoom');
    this.ringEl = root.querySelector('.ed-ring');
    this.frameEl = root.querySelector('.ed-frame');
    this.splitEl = root.querySelector('.ed-split');
    this.splitPos = 0.5;
    this.panel = root.querySelector('.ed-panel');
    document.body.appendChild(root);
    document.body.classList.add('editor-open');
    requestAnimationFrame(() => root.classList.add('open'));

    this.onResize = () => this.layout();
    this.onKey = (e) => this.handleKey(e);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKey);
    root.addEventListener('click', (e) => this.handleClick(e));
    root.addEventListener('input', (e) => this.handleInput(e));
    root.addEventListener('change', (e) => {
      if (e.target.matches('input[type=range]')) this.commit();
    });
    root.addEventListener('dblclick', (e) => {
      const label = e.target.closest('[data-reset]');
      if (!label) return;
      const input = label.parentElement.querySelector('input[type=range]');
      if (!input) return;
      input.value = input.dataset.grade === 'h' ? 0 : 0;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    this.bindCompare();
    this.bindCrop();
    this.bindDraw();
    this.bindZoom();
  }

  async load() {
    try {
      const src = await decode(this.blob);
      const [W, H] = dimsOf(src);
      if (!W || !H) throw new Error('empty');
      const k = Math.min(1, WORK_MAX / Math.max(W, H));
      this.pristine = im.makeCanvas(W * k, H * k);
      const pctx = this.pristine.getContext('2d');
      pctx.imageSmoothingQuality = 'high';
      pctx.drawImage(src, 0, 0, this.pristine.width, this.pristine.height);
      src.close?.();
      this.work = im.makeCanvas(this.pristine.width, this.pristine.height);
      this.work.getContext('2d', { willReadFrequently: true }).drawImage(this.pristine, 0, 0);
      this.Ww = this.work.width;
      this.Hw = this.work.height;
      this.renderer = createRenderer();
      this.renderer.setSource(this.work, this.Ww, this.Hw);
    } catch {
      this.destroy();
      throw new Error('이 사진은 브라우저에서 열 수 없어 편집할 수 없어요.');
    }
    if (!this.renderer.gpu) toast('이 기기에서는 고급 보정 일부를 쓸 수 없어 기본 보정만 적용돼요', { duration: 5000 });
    this.root.classList.toggle('no-gpu', !this.renderer.gpu);
    if (this.initState) this.resumeState(this.initState);
    this.root.classList.remove('loading');
    this.renderPanel();
    this.layout();
  }

  /** 저장할 때 보관한 편집 값으로 이어서 편집 (원본에서 다시 계산) */
  resumeState(saved) {
    const d = dv.defaultState();
    const st = { ...d, ...JSON.parse(JSON.stringify(saved)) };
    st.adj = { ...d.adj, ...st.adj };
    st.geo = { ...d.geo, ...st.geo };
    this.st = st;
    this.history = [JSON.stringify(this.st)];
    this.hIndex = 0;
    this.savedSnap = this.history[0];
    if (st.heals?.length) {
      this.appliedHeals = '[]';
      this.syncHeals();
    }
    const need = looks.styleNeeds(st.adj);
    if (need.faces || Object.keys(st.faceAdj || {}).length) this.ensureFaces();
    if (need.poses) this.ensurePose();
    if (need.person) this.ensureSeg();
    if (need.sky) this.ensureSky();
    if (dv.isEdited(st)) toast('지난번 편집을 이어서 고칠 수 있어요 · 모든 값이 그대로 남아 있어요', { duration: 3500 });
  }

  /** 저장 전에 진행 중인 인식이 끝나기를 기다림 (얼굴·몸·배경 보정이 빠지지 않게) */
  async waitDetect() {
    const need = looks.styleNeeds(this.st.adj);
    if (need.faces || Object.keys(this.st.faceAdj || {}).length) this.ensureFaces();
    if (need.poses) this.ensurePose();
    if (need.person) this.ensureSeg();
    if (need.sky) this.ensureSky();
    for (let i = 0; i < 600 && [this.faceState, this.poseState, this.segState, this.skyState].includes('busy'); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  get dirty() {
    // 이어서 편집하는 경우: 열었을 때와 같으면 바뀐 것 없음
    if (this.savedSnap && this.history[this.hIndex] === this.savedSnap && !this.op) return false;
    return dv.isEdited(this.st);
  }

  region() {
    return this.tab === 'crop' ? dv.FULL : this.st.geo.crop;
  }

  frame() {
    return dv.frameDims(this.Ww, this.Hw, this.st.geo);
  }

  /* ---------- 배치 · 확대 ---------- */

  layout() {
    if (!this.work) return;
    if (this.tab === 'crop') {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
    }
    const pad = this.tab === 'crop' ? 26 : 12;
    const sw = Math.max(40, this.stage.clientWidth - pad * 2);
    const sh = Math.max(40, this.stage.clientHeight - pad * 2);
    const region = this.region();
    const [fw, fh] = this.frame();
    const rw = region.w * fw;
    const rh = region.h * fh;
    // 비율 맞추기(여백)가 있으면 여백까지 화면에 들어오게
    const fr = this.tab !== 'crop' && frameOn(this.st.frame) ? frameDims(rw, rh, this.st.frame) : null;
    const fit = fr ? Math.min(sw / fr[0], sh / fr[1]) : Math.min(sw / rw, sh / rh);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxPx = (this.renderer?.maxTex || 4096) / Math.max(rw, rh);
    const pxScale = Math.min(fit * this.zoom * dpr, 1, maxPx);
    this.canvas.width = Math.max(1, Math.round(rw * pxScale));
    this.canvas.height = Math.max(1, Math.round(rh * pxScale));
    this.view = { rw, rh, fit, pxScale: this.canvas.width / rw, region, frame: fr };
    this.applyView();
    this.cropEl.hidden = this.tab !== 'crop';
    this.baseDirty = true;
    this.paint();
  }

  /** 확대/이동은 먼저 CSS로 바로 보여주고, 잠시 뒤 선명한 해상도로 다시 그립니다. */
  applyView() {
    const { rw, rh, fit } = this.view;
    const cssW = rw * fit * this.zoom;
    const cssH = rh * fit * this.zoom;
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const mx = Math.max(0, (cssW - W) / 2);
    const my = Math.max(0, (cssH - H) / 2);
    this.pan.x = clamp(this.pan.x, -mx, mx);
    this.pan.y = clamp(this.pan.y, -my, my);
    Object.assign(this.canvas.style, {
      width: `${cssW}px`,
      height: `${cssH}px`,
      left: `${(W - cssW) / 2 + this.pan.x}px`,
      top: `${(H - cssH) / 2 + this.pan.y}px`,
    });
    this.view.cssW = cssW;
    this.view.cssH = cssH;
    const fr = this.view.frame;
    this.frameEl.hidden = !fr;
    if (fr) {
      const fwc = fr[0] * fit * this.zoom;
      const fhc = fr[1] * fit * this.zoom;
      Object.assign(this.frameEl.style, {
        width: `${fwc}px`,
        height: `${fhc}px`,
        left: `${(W - fwc) / 2 + this.pan.x}px`,
        top: `${(H - fhc) / 2 + this.pan.y}px`,
      });
    }
    this.zoomEl.hidden = this.zoom <= 1.01;
    this.zoomEl.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this.tab === 'crop') this.positionCrop();
    if (this.split) this.positionSplit();
  }

  zoomAt(clientX, clientY, z) {
    if (this.tab === 'crop' || !this.view) return;
    const nz = clamp(z, 1, 8);
    const rect = this.stage.getBoundingClientRect();
    const dx = clientX - rect.left - rect.width / 2 - this.pan.x;
    const dy = clientY - rect.top - rect.height / 2 - this.pan.y;
    const f = nz / this.zoom;
    this.pan.x += dx * (1 - f);
    this.pan.y += dy * (1 - f);
    this.zoom = nz;
    if (nz <= 1.01) this.pan = { x: 0, y: 0 };
    this.applyView();
    clearTimeout(this.hiResTimer);
    this.hiResTimer = setTimeout(() => this.layout(), 160);
  }

  bindZoom() {
    this.stage.addEventListener('wheel', (e) => {
      if (this.tab === 'crop' || !this.view) return;
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, this.zoom * Math.exp(-e.deltaY * 0.0018));
    }, { passive: false });
    const ptrs = new Map();
    let pinch = null;
    let panDrag = null;
    const canPan = () => this.zoom > 1.01 && !this.paintTab();
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ed-crop, .ed-zoom')) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && this.tab !== 'crop') {
        // 두 손가락: 그리던 것은 취소하고 확대/이동
        this.cur = null;
        this.healing = false;
        this.cancelOp();
        panDrag = null;
        const [a, b] = [...ptrs.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        e.stopPropagation();
      } else if (ptrs.size === 1 && canPan()) {
        panDrag = { x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y };
      }
    }, true);
    this.stage.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        this.pan.x += cx - pinch.cx;
        this.pan.y += cy - pinch.cy;
        pinch.cx = cx;
        pinch.cy = cy;
        this.zoomAt(cx, cy, pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
        e.stopPropagation();
      } else if (panDrag) {
        this.pan.x = panDrag.px + e.clientX - panDrag.x;
        this.pan.y = panDrag.py + e.clientY - panDrag.y;
        this.applyView();
      }
    }, true);
    const end = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) panDrag = null;
    };
    this.stage.addEventListener('pointerup', end, true);
    this.stage.addEventListener('pointercancel', end, true);
    this.stage.addEventListener('dblclick', (e) => {
      if (this.tab === 'crop' || this.paintTab()) return;
      this.zoomAt(e.clientX, e.clientY, this.zoom > 1.01 ? 1 : 2.5);
    });
  }

  /* ---------- 그리기 ---------- */

  requestPaint() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  paint() {
    if (!this.work || this.destroyed) return;
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (this.comparing) {
      ctx.clearRect(0, 0, c.width, c.height);
      const r = Math.min(c.width / this.Ww, c.height / this.Hw);
      ctx.drawImage(this.pristine, (c.width - this.Ww * r) / 2, (c.height - this.Hw * r) / 2, this.Ww * r, this.Hw * r);
      return;
    }
    const { pxScale, region } = this.view;
    if (this.baseDirty || !this.glCanvas) {
      try {
        const res = this.renderer.render(this.st, { region, outW: c.width, outH: c.height, outScale: pxScale });
        this.glCanvas = res.canvas;
        this.matrix = res.matrix;
      } catch (err) {
        // GPU 연결이 끊긴 경우 새로 만들어 다시 그림
        console.warn(err);
        this.renderer = createRenderer();
        this.renderer.setSource(this.work, this.Ww, this.Hw);
        this.renderer.setFaces(this.faces);
        this.renderer.showLocal = this.showLocal;
        const res = this.renderer.render(this.st, { region, outW: c.width, outH: c.height, outScale: pxScale });
        this.glCanvas = res.canvas;
        this.matrix = res.matrix;
      }
      this.baseDirty = false;
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.glCanvas, 0, 0);
    if (this.split && this.tab !== 'crop') {
      try {
        const orig = this.originalLayer(region, c.width, c.height, pxScale);
        const x = Math.round(c.width * this.splitPos);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, x, c.height);
        ctx.clip();
        ctx.drawImage(orig, 0, 0);
        ctx.restore();
      } catch (err) {
        console.warn(err);
      }
      this.positionSplit();
    }
    const strokes = this.cur ? [...this.st.strokes, this.cur] : this.st.strokes;
    drawStrokes(ctx, this.glCanvas, strokes, this.matrix, this.Ww, this.Hw);
    this.itemBoxes = drawItems(ctx, this.glCanvas, this.st.items, this.matrix, this.Ww, this.Hw);
    if (this.tab === 'draw' && this.selItem >= 0) {
      const b = this.itemBoxes.find((x) => x.i === this.selItem);
      if (b) {
        const pad = Math.max(4, c.width / 120);
        ctx.save();
        ctx.setLineDash([pad, pad * 0.7]);
        ctx.lineWidth = Math.max(1.5, c.width / 400);
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 3;
        ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
        ctx.restore();
      }
    }
    if (this.frameEl) this.drawFramePreview();
    if (this.tab === 'beauty' && this.faces?.length > 1 && FACE_GROUPS.includes(this.bgroup) && !this.healMode && !this.eraseMode) this.drawFaceBadges(ctx);
    if (this.tab === 'crop') this.positionCrop();
    this.updateTop();
    this.scheduleHistogram();
  }

  /** 단체 사진: 얼굴마다 번호 표시 (고른 얼굴은 파랗게) */
  drawFaceBadges(ctx) {
    const r = Math.max(9, Math.min(this.canvas.width, this.canvas.height) * 0.028);
    ctx.save();
    ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.faces.forEach((f, i) => {
      const top = f[10];
      const [x, y] = dv.mapPoint(this.matrix, top[0] * this.Ww, top[1] * this.Hw);
      const cy = y - r * 1.6;
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = this.faceSel === i ? '#3b82f6' : 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.14);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(i + 1), x, cy + r * 0.05);
    });
    ctx.restore();
  }

  invalidate() {
    this.baseDirty = true;
    this.requestPaint();
  }

  updateTop() {
    const q = (a) => this.root.querySelector(`[data-act="${a}"]`);
    q('undo').disabled = this.hIndex <= 0;
    q('redo').disabled = this.hIndex >= this.history.length - 1;
    q('save').disabled = !this.dirty;
  }

  scheduleHistogram() {
    const show = this.tab === 'adjust' || this.tab === 'enhance';
    this.histEl.hidden = !show;
    if (!show) return;
    clearTimeout(this.histTimer);
    this.histTimer = setTimeout(() => this.drawHistogram(), 120);
  }

  /** 밝기 분포(히스토그램): 왼쪽은 어두운 곳, 오른쪽은 밝은 곳 */
  drawHistogram() {
    if (this.destroyed) return;
    const src = this.canvas;
    const k = Math.min(1, 160 / Math.max(src.width, src.height));
    const t = im.makeCanvas(src.width * k, src.height * k);
    const tctx = t.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(src, 0, 0, t.width, t.height);
    const d = tctx.getImageData(0, 0, t.width, t.height).data;
    const bins = 64;
    const h = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      h[0][d[i] >> 2]++;
      h[1][d[i + 1] >> 2]++;
      h[2][d[i + 2] >> 2]++;
      h[3][Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) >> 2]++;
    }
    this.hist = h;
    const max = Math.max(...h[3], ...h[0], ...h[1], ...h[2]) || 1;
    const c = this.histEl;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'lighter';
    [['rgba(255,70,70,0.55)', 0], ['rgba(70,220,90,0.55)', 1], ['rgba(80,130,255,0.55)', 2]].forEach(([col, ch]) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, c.height);
      for (let b = 0; b < bins; b++) ctx.lineTo((b / (bins - 1)) * c.width, c.height - (Math.sqrt(h[ch][b] / max) * (c.height - 4)));
      ctx.lineTo(c.width, c.height);
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
    if (this.tab === 'adjust' && this.group === 'curve') this.drawCurve();
  }

  /* ---------- 기록 (실행 취소) ---------- */

  commit() {
    const snap = JSON.stringify(this.st);
    if (snap === this.history[this.hIndex]) return;
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(snap);
    if (this.history.length > 80) this.history.shift();
    this.hIndex = this.history.length - 1;
    this.updateTop();
  }

  restore() {
    this.st = JSON.parse(this.history[this.hIndex]);
    this.syncHeals();
    this.renderPanel();
    this.layout();
  }

  undo() {
    if (this.hIndex <= 0) return;
    this.hIndex--;
    this.restore();
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex++;
    this.restore();
  }

  /** 실행 취소 등으로 잡티 제거 목록이 바뀌면 작업용 이미지를 다시 만듭니다. */
  syncHeals() {
    const key = JSON.stringify(this.st.heals);
    if (key === this.appliedHeals) return;
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.pristine, 0, 0);
    dv.applyHeals(this.work, this.st.heals);
    this.renderer.setSource(this.work, this.Ww, this.Hw);
    this.appliedHeals = key;
  }

  /* ---------- 패널 ---------- */

  sliderRow({ attrs, label, value, min, max, step = 1, text, changed = false, track = '', reset = true }) {
    return `<div class="ed-slider-row${changed ? ' changed' : ''}">
      <span class="ed-slider-label"${reset ? ' data-reset title="두 번 누르면 처음 값으로"' : ''}>${label}</span>
      <input type="range" ${attrs} min="${min}" max="${max}" step="${step}" value="${value}"${track ? ` data-track="${track}"` : ''}${min < 0 ? ' data-bipolar' : ''} aria-label="${label}">
      <output>${text}</output>
    </div>`;
  }

  adjRow(a) {
    const v = this.st.adj[a.key];
    const track = TRACKS[a.key] ? a.key : '';
    return this.sliderRow({ attrs: `data-adj="${a.key}"`, label: a.label, value: v, min: a.min, max: a.max, text: fmtAdj(a, v), changed: !!v, track });
  }

  /** 지금 값이 자동 뷰티 값 그대로인지 */
  beautyAuto() {
    const adj = this.st.adj;
    const faceOk = !!this.faces?.length;
    let any = false;
    for (const a of dv.ADJ) {
      if (a.g !== 'beauty' || !AUTO_GROUPS.includes(a.bg)) continue;
      const want = a.face && !faceOk ? 0 : AUTO_BEAUTY[a.key] || 0;
      if (adj[a.key] !== want) return false;
      if (want) any = true;
    }
    return any;
  }

  /** 인물 탭을 처음 열 때 한 번 얼굴을 찾습니다 (기기 안에서만 처리) */
  async ensureFaces() {
    if (this.faceState !== 'idle' || !this.work || !this.renderer?.gpu) {
      if (this.renderer && !this.renderer.gpu && this.faceState === 'idle') this.faceState = 'error';
      return;
    }
    this.faceState = 'busy';
    try {
      const faces = await detectFaces(this.work);
      if (this.destroyed) return;
      this.faces = faces;
      this.faceState = 'done';
      this.renderer.setFaces(faces);
      this.invalidate();
    } catch (err) {
      console.warn('얼굴 인식 실패', err);
      this.faces = [];
      this.faceState = 'error';
    }
    if (!this.destroyed && this.tab === 'beauty') this.renderPanel();
  }

  /** 몸매 묶음을 처음 열 때 한 번 자세(어깨·골반·다리)를 찾습니다 */
  async ensurePose() {
    if (this.poseState !== 'idle' || !this.work || !this.renderer?.gpu) return;
    this.poseState = 'busy';
    try {
      const poses = await detectPoses(this.work);
      if (this.destroyed) return;
      this.poses = poses;
      this.renderer.setPoses(poses);
      this.poseState = 'done';
      this.invalidate();
    } catch (err) {
      console.warn('자세 인식 실패', err);
      this.poses = [];
      this.poseState = 'error';
    }
    if (!this.destroyed && this.tab === 'beauty') this.renderPanel();
  }

  /** 배경 묶음을 처음 열 때 한 번 사람 영역을 찾습니다 */
  async ensureSeg() {
    if (this.segState !== 'idle' || !this.work || !this.renderer?.gpu) return;
    this.segState = 'busy';
    try {
      const person = await segmentPerson(this.work, this.Ww, this.Hw);
      if (this.destroyed) return;
      this.person = person;
      this.renderer.setPerson(person);
      this.segState = 'done';
      this.invalidate();
    } catch (err) {
      console.warn('사람 영역 찾기 실패', err);
      this.person = null;
      this.segState = 'error';
    }
    if (!this.destroyed && this.tab === 'beauty') this.renderPanel();
  }

  /** 지금 묶음에 필요한 인식 시작 */
  ensureDetect() {
    this.ensureFaces();
    if (this.bgroup === 'body') this.ensurePose();
    if (this.bgroup === 'bg' || this.bgroup === 'color') this.ensureSeg();
  }

  /** 하늘 묶음을 처음 열 때 한 번 하늘을 찾습니다 (사람은 빼고) */
  async ensureSky() {
    if (this.skyState !== 'idle' || !this.work || !this.renderer?.gpu) return;
    this.skyState = 'busy';
    if (this.tab === 'adjust') this.renderPanel();
    try {
      await this.ensureSeg();
      while (this.segState === 'busy') await new Promise((r) => setTimeout(r, 100));
      if (this.destroyed) return;
      this.sky = detectSky(this.work, this.Ww, this.Hw, this.person);
      this.renderer.setSky(this.sky);
      this.skyState = 'done';
      this.invalidate();
    } catch (err) {
      console.warn('하늘 찾기 실패', err);
      this.sky = null;
      this.skyState = 'error';
    }
    if (!this.destroyed && this.tab === 'adjust') this.renderPanel();
  }

  /** 인물 탭 슬라이더 값 (얼굴을 골랐으면 그 얼굴 값) */
  beautyValue(key) {
    if (this.faceSel >= 0 && dv.FACE_KEYS.includes(key)) return dv.faceAdj(this.st.adj, this.st, this.faceSel)[key];
    return this.st.adj[key];
  }

  /** 인물 탭 값 바꾸기 (얼굴을 골랐으면 그 얼굴만) */
  setBeauty(key, v) {
    const st = this.st;
    if (this.faceSel >= 0 && dv.FACE_KEYS.includes(key)) {
      st.faceAdj = st.faceAdj || {};
      st.faceAdj[this.faceSel] = { ...(st.faceAdj[this.faceSel] || {}), [key]: v };
    } else st.adj[key] = v;
  }

  beautyRow(a) {
    const v = this.beautyValue(a.key);
    const ok = a.face ? !!this.faces?.length : a.pose ? !!this.poses?.length : a.seg ? !!this.person : true;
    let row = this.sliderRow({ attrs: `data-adj="${a.key}"`, label: a.label, value: v, min: a.min, max: a.max, text: fmtAdj(a, v), changed: !!v });
    if (!ok) row = row.replace('<input', '<input disabled').replace('ed-slider-row', 'ed-slider-row disabled');
    if (a.color && ok) {
      const cur = this.st.makeup?.[a.color];
      row += `<div class="ed-mks">${MK_COLORS[a.color].map(([id, name, rgb]) => `<button type="button" class="ed-mk${cur === id ? ' on' : ''}" data-mk="${a.color}:${id}" style="--c:${css(rgb)}" aria-label="${esc(name)}" title="${esc(name)}"><i></i><span>${esc(name)}</span></button>`).join('')}</div>`;
    }
    return row;
  }

  groupChanged(g) {
    const st = this.st;
    if (g === 'curve') return dv.curveChanged(st.curve);
    if (g === 'hsl') return dv.hslChanged(st.hsl);
    if (g === 'grading') return !!dv.gradingChanged(st.grading);
    return dv.ADJ.some((a) => a.g === g && st.adj[a.key]);
  }

  renderPanel() {
    this.root.querySelectorAll('.ed-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === this.tab));
    this.root.dataset.tab = this.tab;
    const st = this.st;
    const gpu = this.renderer?.gpu !== false;
    let html = '';
    if (this.tab === 'enhance') {
      const en = st.enhance;
      const one = !!this.oneShotPrev;
      html = `
        <button type="button" class="ed-auto-big ed-oneshot${one ? ' on' : ''}" data-act="one-shot" aria-pressed="${one}">
          ${icon('magic')}<span><strong>원클릭 인생샷${one ? ' 켜짐' : ''}</strong><small>${one ? '한 번 더 누르면 원래대로 · 각 탭에서 세부 값을 바꿀 수 있어요' : '자동 보정 + 자연스러운 뷰티 + 인물이면 배경 살짝 흐림을 한 번에'}</small></span>
        </button>
        <button type="button" class="ed-auto-big${en.on ? ' on' : ''}" data-act="auto" aria-pressed="${en.on}">
          ${icon('auto')}<span><strong>자동 보정${en.on ? ' 켜짐' : ''}</strong><small>${en.on ? '한 번 더 누르면 꺼져요 · 세부 값은 ‘조정’ 탭에서 바꿀 수 있어요' : '사진을 분석해서 노출·대비·화이트밸런스·색감을 알맞게 맞춰요'}</small></span>
        </button>
        <div class="ed-chips">${dv.SCENES.map((sc) => `<button type="button" class="ed-chip${en.on && en.scene === sc.id ? ' on' : ''}" data-scene="${sc.id}" title="${esc(sc.hint)}">${esc(sc.name)}</button>`).join('')}</div>
        ${en.on ? this.sliderRow({ attrs: 'data-slider="strength"', label: '강도', value: Math.round(en.strength * 100), min: 0, max: 150, step: 5, text: `${Math.round(en.strength * 100)}`, reset: false }) : '<p class="ed-hint">장면을 고르면 그 장면에 맞게 보정해요</p>'}
        <div class="ed-chips"><button type="button" class="ed-chip" data-act="ai-upscale"${this.renderer?.gpu === false ? ' disabled' : ''}>${icon('auto')}AI 화질 개선 · 2배로 키우기</button></div>`;
    } else if (this.tab === 'crop') {
      const g = st.geo;
      html = `
        <div class="ed-chips">${ASPECTS.map(([k, label]) => `<button type="button" class="ed-chip${g.aspect === k ? ' on' : ''}" data-aspect="${k}">${label}</button>`).join('')}</div>
        ${this.sliderRow({ attrs: 'data-slider="angle"', label: '기울기', value: g.angle, min: -45, max: 45, step: 0.5, text: `${signed(g.angle)}°`, changed: !!g.angle })}
        ${gpu ? this.sliderRow({ attrs: 'data-slider="pv"', label: '세로 원근', value: g.pv, min: -100, max: 100, text: signed(g.pv), changed: !!g.pv }) : ''}
        ${gpu ? this.sliderRow({ attrs: 'data-slider="ph"', label: '가로 원근', value: g.ph, min: -100, max: 100, text: signed(g.ph), changed: !!g.ph }) : ''}
        <div class="ed-btns">
          <button type="button" class="ed-btn" data-act="rotate">${icon('rotate')}<span>회전</span></button>
          <button type="button" class="ed-btn" data-act="flip">${icon('flip')}<span>좌우 반전</span></button>
          <button type="button" class="ed-btn" data-act="flipv">${icon('flip', 'rot90')}<span>상하 반전</span></button>
          <button type="button" class="ed-btn" data-act="reset-geo">${icon('restore')}<span>초기화</span></button>
        </div>`;
    } else if (this.tab === 'filter') {
      const presets = looks.listPresets();
      const clip = looks.getClip();
      html = `
        <div class="ed-chips ed-mylooks">
          <button type="button" class="ed-chip" data-act="copy-style"${this.dirty ? '' : ' disabled'}>${icon('copy')}보정 복사</button>
          <button type="button" class="ed-chip" data-act="paste-style"${clip ? '' : ' disabled'}>${icon('check')}붙여넣기</button>
          <button type="button" class="ed-chip ed-auto" data-act="save-preset"${this.dirty ? '' : ' disabled'}>${icon('add')}내 보정 저장</button>
          ${presets.map((p) => `<button type="button" class="ed-chip ed-preset" data-preset="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
          ${presets.length ? `<button type="button" class="ed-chip" data-act="manage-presets">${icon('settings')}관리</button>` : ''}
        </div>
        <div class="ed-filters">${dv.LOOKS.map((f) => `
          <button type="button" class="ed-filter${st.look === f.id ? ' on' : ''}" data-filter="${f.id}">
            <canvas width="2" height="2"></canvas><span>${esc(f.name)}</span>
          </button>`).join('')}
        </div>
        ${st.look === 'none' ? '<p class="ed-hint">필터를 고르면 강도를 조절할 수 있어요</p>' : this.sliderRow({ attrs: 'data-slider="filterAmt"', label: '강도', value: Math.round(st.lookAmt * 100), min: 0, max: 100, text: `${Math.round(st.lookAmt * 100)}`, reset: false })}`;
    } else if (this.tab === 'adjust') {
      const groups = gpu ? dv.GROUPS : dv.GROUPS.filter(([k]) => ['light', 'color', 'effects', 'detail'].includes(k));
      if (!groups.some(([k]) => k === this.group)) this.group = 'light';
      html = `
        <div class="ed-chips ed-groups">
          ${groups.map(([k, label]) => `<button type="button" class="ed-chip${k === this.group ? ' on' : ''}${this.groupChanged(k) ? ' changed' : ''}" data-group="${k}">${label}</button>`).join('')}
          <button type="button" class="ed-chip ed-auto${st.enhance.on ? ' on' : ''}" data-act="auto">${icon('auto')}자동</button>
          <button type="button" class="ed-chip" data-act="reset-adj">${icon('restore')}모두 초기화</button>
        </div>
        <div class="ed-group-body">${this.groupBody()}</div>`;
    } else if (this.tab === 'beauty') {
      const fs = this.faceState;
      const n = this.faces?.length || 0;
      const bg = this.bgroup;
      let status = fs === 'busy' ? '얼굴을 찾는 중…'
        : fs === 'error' ? '얼굴 인식을 불러오지 못했어요 · 피부 보정만 쓸 수 있어요'
          : fs === 'done' && !n ? '얼굴을 찾지 못했어요 · 피부 보정만 쓸 수 있어요'
            : fs === 'done' ? `얼굴 ${n}명을 찾았어요` : '';
      let busy = fs === 'busy';
      if (bg === 'body') {
        const ps = this.poseState;
        const np = this.poses?.length || 0;
        busy = ps === 'busy';
        status = busy ? '몸을 찾는 중… (처음 한 번 약 6MB 내려받아요)' : ps === 'error' ? '자세 인식을 불러오지 못했어요'
          : !np ? '몸(어깨·골반)을 찾지 못했어요 · 전신이나 상반신이 보이는 사진에서 쓸 수 있어요' : `${np}명의 몸을 찾았어요 · 다리 길게는 골반과 무릎이 보여야 해요`;
      } else if (bg === 'bg' || bg === 'color') {
        const ss = this.segState;
        busy = ss === 'busy';
        status = busy ? '사람과 배경을 나누는 중… (처음 한 번 약 16MB 내려받아요)' : ss === 'error' ? '배경 나누기를 불러오지 못했어요'
          : !this.person ? '사람을 찾지 못했어요' : bg === 'color' ? '머리카락·옷·피부를 찾았어요 · 색을 고르면 바로 바뀌어요' : '사람과 배경을 나눴어요';
      }
      const rows = dv.ADJ.filter((a) => a.g === 'beauty' && a.bg === bg);
      const autoOn = this.beautyAuto();
      const faceTabs = n > 1 && FACE_GROUPS.includes(bg)
        ? `<div class="ed-chips ed-face-sel">
            <button type="button" class="ed-chip${this.faceSel < 0 ? ' on' : ''}" data-face-sel="-1">모든 얼굴</button>
            ${this.faces.map((_, i) => `<button type="button" class="ed-chip${this.faceSel === i ? ' on' : ''}${Object.values(st.faceAdj?.[i] || {}).some((v) => v) ? ' changed' : ''}" data-face-sel="${i}">${i + 1}번 얼굴</button>`).join('')}
          </div>` : '';
      html = `
        <div class="ed-chips ed-groups">
          ${dv.BEAUTY_GROUPS.map(([k, label]) => `<button type="button" class="ed-chip${k === this.bgroup ? ' on' : ''}${dv.ADJ.some((a) => a.bg === k && st.adj[a.key]) ? ' changed' : ''}" data-bgroup="${k}">${label}</button>`).join('')}
          <button type="button" class="ed-chip ed-auto${autoOn ? ' on' : ''}" data-act="auto-beauty"${fs === 'busy' ? ' disabled' : ''}>${icon('face')}자동 뷰티</button>
          <button type="button" class="ed-chip" data-act="reset-beauty">${icon('restore')}초기화</button>
        </div>
        <p class="ed-face-status${busy ? ' busy' : ''}" aria-live="polite">${esc(status)}</p>
        ${faceTabs}
        <div class="ed-chips">
          <button type="button" class="ed-chip${this.healMode ? ' on' : ''}" data-act="heal-toggle" aria-pressed="${this.healMode}">${icon('healing')}잡티 제거</button>
          <button type="button" class="ed-chip${this.eraseMode ? ' on' : ''}" data-act="erase-toggle" aria-pressed="${this.eraseMode}">${icon('erase')}보정 지우개</button>
        </div>
        <div class="ed-group-body">
          ${this.healMode ? `
            ${this.sliderRow({ attrs: 'data-slider="healSize"', label: '브러시 크기', value: this.healSize, min: 4, max: 40, text: `${this.healSize}`, reset: false })}
            <div class="ed-chips"><button type="button" class="ed-chip" data-act="undo-heal"${st.heals.length ? '' : ' disabled'}>${icon('undo')}잡티 하나 되돌리기</button></div>`
    : this.eraseMode ? `
            <div class="ed-chips">
              <button type="button" class="ed-chip${this.er.tool === 'fx' ? ' on' : ''}" data-er-tool="fx">지우기</button>
              <button type="button" class="ed-chip${this.er.tool === 'unfx' ? ' on' : ''}" data-er-tool="unfx">되살리기</button>
              <button type="button" class="ed-chip" data-act="undo-erase"${st.erase.length ? '' : ' disabled'}>${icon('undo')}한 획 되돌리기</button>
              <button type="button" class="ed-chip" data-act="clear-erase"${st.erase.length ? '' : ' disabled'}>${icon('restore')}모두 되살리기</button>
            </div>
            ${this.sliderRow({ attrs: 'data-slider="erSize"', label: '브러시 크기', value: this.er.size, min: 4, max: 100, text: `${this.er.size}`, reset: false })}
            ${this.sliderRow({ attrs: 'data-slider="erStrength"', label: '세기', value: this.er.strength, min: 10, max: 100, text: `${this.er.strength}`, reset: false })}`
      : rows.map((a) => this.beautyRow(a)).join('')}
        </div>
        <p class="ed-hint">${this.healMode ? '사진을 확대한 뒤 잡티·여드름·점을 톡 누르거나 문지르세요. 주변 피부로 자연스럽게 메워요.'
    : this.eraseMode ? (this.er.tool === 'fx' ? '문지른 곳은 얼굴형·피부·입술 등 인물 보정과 성형·부분 보정이 빠지고 원래 모습으로 돌아가요. (밝기·색감·필터는 그대로)' : '지웠던 곳을 문지르면 보정이 다시 살아나요.')
      : {
        makeup: '색을 고르고 슬라이더로 진하기를 정해요. 원래 입술·피부의 명암은 그대로 살려요.',
        body: '다리 길게는 머리 위·발 아래 여백을 조금 줄여 사진 크기는 그대로 둬요.',
        bg: '배경 흐림은 인물 사진(아웃포커싱)처럼 사람만 또렷하게 남겨요.',
      }[bg] || (n > 1 ? '얼굴을 골라 사람마다 따로 보정할 수 있어요. 사진은 기기 밖으로 나가지 않아요.' : '얼굴을 찾아 피부·눈·코·입·얼굴형을 자연스럽게 다듬어요. 사진은 기기 밖으로 나가지 않아요.')}</p>`;
    } else if (this.tab === 'reshape') {
      const L = this.liq;
      html = `
        <div class="ed-chips">
          ${LIQ_TOOLS.map(([k, label]) => `<button type="button" class="ed-chip${L.tool === k ? ' on' : ''}" data-liq-tool="${k}">${label}</button>`).join('')}
        </div>
        ${this.sliderRow({ attrs: 'data-slider="liqSize"', label: '브러시 크기', value: L.size, min: 8, max: 120, text: `${L.size}`, reset: false })}
        ${this.sliderRow({ attrs: 'data-slider="liqStrength"', label: '세기', value: L.strength, min: 10, max: 100, text: `${L.strength}`, reset: false })}
        <div class="ed-chips">
          <button type="button" class="ed-chip" data-act="undo-liq"${st.liquify.length ? '' : ' disabled'}>${icon('undo')}한 번 되돌리기</button>
          <button type="button" class="ed-chip" data-act="clear-liq"${st.liquify.length ? '' : ' disabled'}>${icon('restore')}모두 원래대로</button>
        </div>
        <p class="ed-hint">${{
    push: '손가락으로 밀어서 턱선·볼·허리·팔 라인을 다듬어요. 두 손가락으로 확대하면 더 섬세하게 할 수 있어요.',
    bloat: '누르고 있으면 그 부분이 점점 커져요 (눈·입술·가슴 등).',
    pinch: '누르고 있으면 그 부분이 점점 작아져요 (코·얼굴·팔 등).',
    restore: '문지른 곳만 원래 모양으로 돌아가요.',
  }[L.tool]}</p>`;
    } else if (this.tab === 'local') {
      const C = this.lc;
      const removing = C.tool === 'remove';
      const fills = st.heals.filter((h) => h.t === 'fill').length;
      html = `
        <div class="ed-chips ed-lc-tools">
          <button type="button" class="ed-chip ed-auto${removing ? ' on' : ''}" data-lc-tool="remove">${icon('erase')}사물 지우기</button>
          ${LOCAL_TOOLS.map(([k, label]) => `<button type="button" class="ed-chip${C.tool === k ? ' on' : ''}" data-lc-tool="${k}">${label}</button>`).join('')}
        </div>
        ${removing ? `
        ${this.sliderRow({ attrs: 'data-slider="lcSize"', label: '브러시 크기', value: C.size, min: 4, max: 100, text: `${C.size}`, reset: false })}
        <div class="ed-chips">
          <button type="button" class="ed-chip" data-act="undo-fill"${fills ? '' : ' disabled'}>${icon('undo')}한 번 되돌리기</button>
        </div>
        <p class="ed-hint">지우고 싶은 사람·물건·전선·글자를 빈틈없이 덮어 칠하면, 주변 배경으로 자연스럽게 채워요. 배경이 단순할수록 깔끔해요.</p>` : `
        ${this.sliderRow({ attrs: 'data-slider="lcSize"', label: '브러시 크기', value: C.size, min: 4, max: 100, text: `${C.size}`, reset: false })}
        ${this.sliderRow({ attrs: 'data-slider="lcStrength"', label: '세기', value: C.strength, min: 5, max: 100, text: `${C.strength}`, reset: false })}
        <div class="ed-chips">
          <button type="button" class="ed-chip${this.showLocal ? ' on' : ''}" data-act="show-local" aria-pressed="${this.showLocal}">${icon('select')}칠한 곳 보기</button>
          <button type="button" class="ed-chip" data-act="undo-local"${st.local.length ? '' : ' disabled'}>${icon('undo')}한 획 되돌리기</button>
          <button type="button" class="ed-chip" data-act="clear-local"${st.local.length ? '' : ' disabled'}>${icon('trash')}모두 지우기</button>
        </div>
        <p class="ed-hint">${C.tool === 'erase' ? '문지른 곳의 부분 보정을 지워요.' : '보정하고 싶은 곳만 문질러 주세요. 같은 곳을 여러 번 문지르면 더 강해져요.'}</p>`}`;
    } else if (this.tab === 'draw') {
      html = this.decoPanel();
    }
    this.panel.innerHTML = html;
    this.panel.scrollTop = 0;
    this.panel.querySelectorAll('input[type=range]').forEach((r) => this.paintSlider(r));
    if (this.tab === 'filter') this.buildFilterThumbs();
    if (this.tab === 'adjust' && this.group === 'curve') this.bindCurve();
    this.scheduleHistogram();
  }

  groupBody() {
    const st = this.st;
    const g = this.group;
    if (g === 'curve') {
      return `
        <div class="ed-chips">${CURVE_CH.map(([k, label, col]) => `<button type="button" class="ed-chip${k === this.curveCh ? ' on' : ''}" data-curve-ch="${k}" style="--dot:${col}"><i class="ed-dotmark"></i>${label}</button>`).join('')}
          <button type="button" class="ed-chip" data-act="curve-reset">${icon('restore')}커브 초기화</button></div>
        <div class="ed-curve-wrap"><canvas class="ed-curve" width="300" height="220" aria-label="톤 커브"></canvas></div>
        <p class="ed-hint">선을 눌러 점을 추가하고 끌어서 조절해요. 점을 두 번 누르면 지워져요.</p>`;
    }
    if (g === 'hsl') {
      const [h, s, l] = st.hsl[this.band];
      return `
        <div class="ed-dots">${dv.HSL_BANDS.map(([k, name, col]) => `<button type="button" class="ed-dot${k === this.band ? ' on' : ''}${st.hsl[k].some((x) => x) ? ' changed' : ''}" data-band="${k}" style="--c:${col}" aria-label="${name}" title="${name}"></button>`).join('')}</div>
        ${this.sliderRow({ attrs: 'data-hsl="0"', label: '색조', value: h, min: -100, max: 100, text: signed(h), changed: !!h })}
        ${this.sliderRow({ attrs: 'data-hsl="1"', label: '채도', value: s, min: -100, max: 100, text: signed(s), changed: !!s })}
        ${this.sliderRow({ attrs: 'data-hsl="2"', label: '밝기', value: l, min: -100, max: 100, text: signed(l), changed: !!l })}`;
    }
    if (g === 'grading') {
      const [h, s] = st.grading[this.gradeRange];
      return `
        <div class="ed-chips">${dv.GRADE_RANGES.map(([k, label]) => {
          const [hh, ss] = st.grading[k];
          return `<button type="button" class="ed-chip${k === this.gradeRange ? ' on' : ''}" data-grade-range="${k}"><i class="ed-swatch" style="--c:hsl(${hh} ${Math.min(100, ss * 1.5)}% 55%)"></i>${label}</button>`;
        }).join('')}</div>
        ${this.sliderRow({ attrs: 'data-grade="h"', label: '색', value: h, min: 0, max: 360, text: `${h}°`, track: 'hue' })}
        ${this.sliderRow({ attrs: 'data-grade="s"', label: '강도', value: s, min: 0, max: 100, text: `${s}`, changed: !!s })}
        ${this.sliderRow({ attrs: 'data-grade="balance"', label: '균형', value: st.grading.balance, min: -100, max: 100, text: signed(st.grading.balance), changed: !!st.grading.balance })}`;
    }
    if (g === 'sky') {
      this.ensureSky();
      const ss = this.skyState;
      const status = ss === 'busy' ? '하늘을 찾는 중… (처음 한 번 약 16MB 내려받아요)' : ss === 'error' ? '하늘을 찾지 못했어요'
        : !this.sky ? '이 사진에서는 하늘을 찾지 못했어요 · 하늘이 위쪽에 넓게 보이는 야외 사진에서 쓸 수 있어요' : '하늘을 찾았어요 · 원하는 하늘을 골라 보세요';
      const a = dv.ADJ_BY_KEY.skyAmt;
      let row = this.adjRow(a);
      if (!this.sky) row = row.replace('<input', '<input disabled').replace('ed-slider-row', 'ed-slider-row disabled');
      return `
        <p class="ed-face-status${ss === 'busy' ? ' busy' : ''}" aria-live="polite">${esc(status)}</p>
        ${row}
        ${this.sky ? `<div class="ed-mks">${SKIES.map(([id, name, d]) => `<button type="button" class="ed-mk ed-sky${st.sky === id ? ' on' : ''}" data-sky="${id}" style="--c:linear-gradient(${css(d.top)}, ${css(d.hor)})" aria-label="${esc(name)}"><i></i><span>${esc(name)}</span></button>`).join('')}</div>` : ''}
        <p class="ed-hint">나무·철탑처럼 가는 물체가 많은 곳은 경계가 어색할 수 있어요. 앞쪽 색감도 하늘에 맞게 살짝 바뀌어요.</p>`;
    }
    return dv.ADJ.filter((a) => a.g === g).map((a) => this.adjRow(a)).join('');
  }

  paintSlider(r) {
    if (r.dataset.track) {
      r.style.background = TRACKS[r.dataset.track];
      return;
    }
    const min = +r.min;
    const max = +r.max;
    const pct = ((+r.value - min) / (max - min)) * 100;
    const zero = r.dataset.bipolar !== undefined ? ((0 - min) / (max - min)) * 100 : 0;
    const lo = Math.min(pct, zero);
    const hi = Math.max(pct, zero);
    r.style.background = `linear-gradient(to right, var(--ed-track) ${lo}%, var(--ed-fill) ${lo}%, var(--ed-fill) ${hi}%, var(--ed-track) ${hi}%)`;
  }

  buildFilterThumbs() {
    const region = this.st.geo.crop;
    const [fw, fh] = this.frame();
    const rw = region.w * fw;
    const rh = region.h * fh;
    const k = 140 / Math.max(rw, rh);
    this.panel.querySelectorAll('.ed-filter').forEach((btn) => {
      const st = { ...this.st, look: btn.dataset.filter, lookAmt: 1, strokes: [] };
      const { canvas } = this.renderer.render(st, { region, outW: rw * k, outH: rh * k, outScale: k });
      const c = btn.querySelector('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, 0, 0);
    });
    this.baseDirty = true;
    this.requestPaint();
  }

  /* ---------- 톤 커브 편집 ---------- */

  curvePts() {
    return this.st.curve[this.curveCh];
  }

  drawCurve() {
    const c = this.panel.querySelector('.ed-curve');
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 300;
    const H = c.clientHeight || 220;
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, W, H);
    const col = CURVE_CH.find(([k]) => k === this.curveCh)[2];
    // 히스토그램 바탕
    if (this.hist) {
      const ch = { rgb: 3, r: 0, g: 1, b: 2 }[this.curveCh];
      const hh = this.hist[ch];
      const max = Math.max(...hh) || 1;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(0, H);
      hh.forEach((v, i) => ctx.lineTo((i / (hh.length - 1)) * W, H - Math.sqrt(v / max) * H * 0.9));
      ctx.lineTo(W, H);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((W * i) / 4, 0);
      ctx.lineTo((W * i) / 4, H);
      ctx.moveTo(0, (H * i) / 4);
      ctx.lineTo(W, (H * i) / 4);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(W, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    const pts = this.curvePts();
    const f = dv.curveFn(pts);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const y = clamp(f(x), 0, 1);
      if (i) ctx.lineTo(x * W, H - y * H);
      else ctx.moveTo(x * W, H - y * H);
    }
    ctx.stroke();
    pts.forEach(([x, y], i) => {
      ctx.fillStyle = i === this.curveDrag?.i && this.curveDrag.remove ? 'rgba(255,255,255,0.3)' : '#fff';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x * W, H - y * H, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  bindCurve() {
    const c = this.panel.querySelector('.ed-curve');
    if (!c) return;
    requestAnimationFrame(() => this.drawCurve());
    const toXY = (e) => {
      const r = c.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, r];
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const [x, y, r] = toXY(e);
      const pts = this.curvePts();
      let i = pts.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 18);
      if (i < 0) {
        // 선 위(또는 근처)를 누르면 새 점
        const f = dv.curveFn(pts);
        const yy = Math.abs(f(x) - y) * r.height < 30 ? f(x) : y;
        pts.push([clamp(x, 0.005, 0.995), clamp(yy, 0, 1)]);
        pts.sort((a, b) => a[0] - b[0]);
        i = pts.findIndex((p) => p[0] === clamp(x, 0.005, 0.995));
      }
      this.curveDrag = { i, remove: false };
      this.drawCurve();
      this.invalidate();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.curveDrag) return;
      const [x, y] = toXY(e);
      const pts = this.curvePts();
      const i = this.curveDrag.i;
      const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0;
      const hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
      pts[i] = [clamp(x, lo, hi), clamp(y, 0, 1)];
      // 가운데 점을 바깥으로 멀리 끌어내면 지우기
      this.curveDrag.remove = i > 0 && i < pts.length - 1 && (y < -0.15 || y > 1.15);
      this.drawCurve();
      this.invalidate();
    });
    const end = () => {
      if (!this.curveDrag) return;
      const pts = this.curvePts();
      if (this.curveDrag.remove) pts.splice(this.curveDrag.i, 1);
      this.curveDrag = null;
      this.drawCurve();
      this.invalidate();
      this.commit();
      this.refreshGroupChips();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      const [x, y, r] = toXY(e);
      const pts = this.curvePts();
      const i = pts.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 18);
      if (i > 0 && i < pts.length - 1) {
        pts.splice(i, 1);
        this.drawCurve();
        this.invalidate();
        this.commit();
      }
    });
  }

  refreshGroupChips() {
    this.panel.querySelectorAll('[data-group]').forEach((b) => b.classList.toggle('changed', this.groupChanged(b.dataset.group)));
  }

  /* ---------- 입력 처리 ---------- */

  handleInput(e) {
    const r = e.target;
    if (!r.matches('input[type=range]')) return;
    this.paintSlider(r);
    const v = +r.value;
    const out = r.parentElement.querySelector('output');
    const row = r.closest('.ed-slider-row');
    const st = this.st;
    if (r.dataset.adj) {
      const a = dv.ADJ_BY_KEY[r.dataset.adj];
      if (this.tab === 'beauty') this.setBeauty(a.key, v);
      else st.adj[a.key] = v;
      out.textContent = fmtAdj(a, v);
      row.classList.toggle('changed', !!v);
      this.refreshGroupChips();
      this.invalidate();
      return;
    }
    if (r.dataset.hsl) {
      st.hsl[this.band][+r.dataset.hsl] = v;
      out.textContent = signed(v);
      row.classList.toggle('changed', !!v);
      this.panel.querySelector(`[data-band="${this.band}"]`)?.classList.toggle('changed', st.hsl[this.band].some((x) => x));
      this.refreshGroupChips();
      this.invalidate();
      return;
    }
    if (r.dataset.grade) {
      const g = st.grading;
      if (r.dataset.grade === 'h') {
        g[this.gradeRange][0] = v;
        out.textContent = `${v}°`;
        if (!g[this.gradeRange][1]) {
          // 색을 고르면 바로 보이도록 강도를 조금 올려 줌
          g[this.gradeRange][1] = 25;
          const sIn = this.panel.querySelector('[data-grade="s"]');
          sIn.value = 25;
          sIn.parentElement.querySelector('output').textContent = '25';
          this.paintSlider(sIn);
        }
      } else if (r.dataset.grade === 's') {
        g[this.gradeRange][1] = v;
        out.textContent = `${v}`;
      } else {
        g.balance = v;
        out.textContent = signed(v);
      }
      const sw = this.panel.querySelector(`[data-grade-range="${this.gradeRange}"] .ed-swatch`);
      if (sw) sw.style.setProperty('--c', `hsl(${g[this.gradeRange][0]} ${Math.min(100, g[this.gradeRange][1] * 1.5)}% 55%)`);
      this.refreshGroupChips();
      this.invalidate();
      return;
    }
    const g = st.geo;
    switch (r.dataset.slider) {
      case 'angle':
        g.angle = v;
        out.textContent = `${signed(v)}°`;
        this.invalidate();
        break;
      case 'pv':
      case 'ph':
        g[r.dataset.slider] = v;
        out.textContent = signed(v);
        this.invalidate();
        break;
      case 'filterAmt':
        st.lookAmt = v / 100;
        out.textContent = `${v}`;
        this.invalidate();
        break;
      case 'strength':
        st.enhance.strength = v / 100;
        out.textContent = `${v}`;
        this.applyEnhance();
        this.invalidate();
        break;
      case 'size':
        this.sizes[this.tool] = v;
        out.textContent = `${v}`;
        break;
      case 'healSize':
        this.healSize = v;
        out.textContent = `${v}`;
        break;
      case 'liqSize':
      case 'liqStrength':
        this.liq[r.dataset.slider === 'liqSize' ? 'size' : 'strength'] = v;
        out.textContent = `${v}`;
        break;
      case 'itemSize': {
        const it = st.items[this.selItem];
        out.textContent = `${v}`;
        if (!it) break;
        const nv = 0.3 * (v / 100) ** 2;
        if (it.t === 'cover') {
          const k = nv / (it.rx || it.s);
          it.rx = (it.rx || it.s) * k;
          it.ry = (it.ry || it.s) * k;
          it.s = Math.max(it.rx, it.ry);
        } else it.s = nv;
        this.requestPaint();
        break;
      }
      case 'framePad':
        st.frame = { ...st.frame, pad: v };
        out.textContent = `${v}%`;
        this.layout();
        break;
      case 'erSize':
      case 'erStrength':
        this.er[r.dataset.slider === 'erSize' ? 'size' : 'strength'] = v;
        out.textContent = `${v}`;
        break;
      case 'lcSize':
      case 'lcStrength':
        this.lc[r.dataset.slider === 'lcSize' ? 'size' : 'strength'] = v;
        out.textContent = `${v}`;
        break;
      default:
    }
  }

  handleClick(e) {
    const t = e.target;
    const tab = t.closest('.ed-tab');
    if (tab) {
      if (this.tab !== tab.dataset.tab) {
        this.tab = tab.dataset.tab;
        if (this.tab !== 'beauty') {
          this.healMode = false;
          this.eraseMode = false;
        }
        else this.ensureDetect();
        if (this.tab !== 'local' && this.showLocal) {
          this.showLocal = false;
          this.renderer.showLocal = false;
          this.invalidate();
        }
        this.ringEl.hidden = true;
        this.renderPanel();
        this.layout();
        this.positionSplit();
      }
      return;
    }
    const st = this.st;
    const pick = (sel) => t.closest(sel);
    let el;
    if ((el = pick('[data-aspect]'))) {
      st.geo.aspect = el.dataset.aspect;
      const [fw, fh] = this.frame();
      const ratio = aspectValue(st.geo.aspect, fw, fh);
      st.geo.crop = fitAspect(ratio ? (ratio * fh) / fw : null);
      this.commit();
      this.renderPanel();
      this.paint();
      return;
    }
    if ((el = pick('[data-scene]'))) {
      const en = st.enhance;
      if (!en.on) {
        en.prev = { ...st.adj };
        en.on = true;
      }
      en.scene = el.dataset.scene;
      this.applyEnhance();
      this.commit();
      this.renderPanel();
      this.invalidate();
      return;
    }
    if ((el = pick('[data-filter]'))) {
      st.look = el.dataset.filter;
      if (st.look !== 'none' && !st.lookAmt) st.lookAmt = 1;
      this.commit();
      this.panel.querySelectorAll('.ed-filter').forEach((b) => b.classList.toggle('on', b === el));
      const old = this.panel.querySelector('.ed-slider-row, .ed-hint');
      old.outerHTML = st.look === 'none'
        ? '<p class="ed-hint">필터를 고르면 강도를 조절할 수 있어요</p>'
        : this.sliderRow({ attrs: 'data-slider="filterAmt"', label: '강도', value: Math.round(st.lookAmt * 100), min: 0, max: 100, text: `${Math.round(st.lookAmt * 100)}`, reset: false });
      this.panel.querySelectorAll('input[type=range]').forEach((r) => this.paintSlider(r));
      this.invalidate();
      return;
    }
    if ((el = pick('[data-liq-tool]'))) {
      this.liq.tool = el.dataset.liqTool;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-preset]'))) {
      const p = looks.getPreset(el.dataset.preset);
      if (p) this.useStyle(p.style, `‘${p.name}’ 보정을 적용했어요`);
      return;
    }
    if ((el = pick('[data-face-sel]'))) {
      this.faceSel = +el.dataset.faceSel;
      this.renderPanel();
      this.requestPaint();
      return;
    }
    if ((el = pick('[data-sky]'))) {
      st.sky = el.dataset.sky;
      if (!st.adj.skyAmt) st.adj.skyAmt = 100;
      this.commit();
      this.renderPanel();
      this.invalidate();
      return;
    }
    if ((el = pick('[data-mk]'))) {
      const [kind, id] = el.dataset.mk.split(':');
      st.makeup = { ...(st.makeup || {}), [kind]: id };
      // 색을 고르면 바로 보이도록 진하기를 조금 올려 줌
      const key = MK_KEY[kind];
      if (!this.beautyValue(key)) this.setBeauty(key, kind === 'hair' || kind === 'cloth' ? 80 : 50);
      this.commit();
      this.renderPanel();
      this.invalidate();
      return;
    }
    if ((el = pick('[data-er-tool]'))) {
      this.er.tool = el.dataset.erTool;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-lc-tool]'))) {
      this.lc.tool = el.dataset.lcTool;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-bgroup]'))) {
      this.bgroup = el.dataset.bgroup;
      this.healMode = false;
      this.eraseMode = false;
      this.ensureDetect();
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-group]'))) {
      this.group = el.dataset.group;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-curve-ch]'))) {
      this.curveCh = el.dataset.curveCh;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-band]'))) {
      this.band = el.dataset.band;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-grade-range]'))) {
      this.gradeRange = el.dataset.gradeRange;
      this.renderPanel();
      return;
    }
    if ((el = pick('[data-tool]'))) {
      this.tool = el.dataset.tool;
      const it = st.items[this.selItem];
      if (it && it.t !== this.tool) this.selItem = -1;
      this.renderPanel();
      this.layout();
      return;
    }
    if ((el = pick('[data-sticker]'))) {
      this.sticker = el.dataset.sticker;
      const it = st.items[this.selItem];
      if (it?.t === 'sticker') {
        it.emoji = this.sticker;
        this.commit();
        this.renderPanel();
      } else {
        const [x, y] = this.viewCenter();
        this.addItem({ t: 'sticker', x, y, s: this.viewSize(0.12), emoji: this.sticker });
      }
      this.requestPaint();
      return;
    }
    if ((el = pick('[data-item-color]')) || (el = pick('[data-item-font]')) || (el = pick('[data-item-style]'))) {
      const it = st.items[this.selItem];
      if (it) {
        if (el.dataset.itemColor) it.color = el.dataset.itemColor;
        if (el.dataset.itemFont) it.font = el.dataset.itemFont;
        if (el.dataset.itemStyle) it.style = el.dataset.itemStyle;
        this.commit();
        this.renderPanel();
        this.requestPaint();
      }
      return;
    }
    if ((el = pick('[data-cover-mode]'))) {
      this.coverMode = el.dataset.coverMode;
      const it = st.items[this.selItem];
      // 고른 것이 있으면 그것만, 없으면 모든 가리기를 바꿈
      for (const x of it?.t === 'cover' ? [it] : st.items.filter((y) => y.t === 'cover')) x.mode = this.coverMode;
      this.commit();
      this.renderPanel();
      this.requestPaint();
      return;
    }
    if ((el = pick('[data-frame-aspect]')) || (el = pick('[data-frame-fill]'))) {
      st.frame = { ...st.frame };
      if (el.dataset.frameAspect) st.frame.aspect = el.dataset.frameAspect;
      if (el.dataset.frameFill) st.frame.fill = el.dataset.frameFill;
      this.commit();
      this.renderPanel();
      this.layout();
      return;
    }
    if ((el = pick('[data-color]'))) {
      this.color = el.dataset.color;
      this.panel.querySelectorAll('.ed-color').forEach((b) => b.classList.toggle('on', b === el));
      return;
    }
    const btn = pick('[data-act]');
    if (!btn || btn.disabled) return;
    const geo = st.geo;
    switch (btn.dataset.act) {
      case 'cancel':
        this.requestCancel();
        break;
      case 'save':
        this.save();
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case 'zoom-reset':
        this.zoom = 1;
        this.pan = { x: 0, y: 0 };
        this.layout();
        break;
      case 'rotate': {
        geo.q = (geo.q + 3) % 4;
        const [fw, fh] = this.frame();
        const ratio = aspectValue(geo.aspect, fw, fh);
        geo.crop = fitAspect(ratio ? (ratio * fh) / fw : null);
        this.commit();
        this.layout();
        break;
      }
      case 'flip':
        geo.flipH = !geo.flipH;
        geo.crop.x = 1 - geo.crop.x - geo.crop.w;
        this.commit();
        this.invalidate();
        break;
      case 'flipv':
        geo.flipV = !geo.flipV;
        geo.crop.y = 1 - geo.crop.y - geo.crop.h;
        this.commit();
        this.invalidate();
        break;
      case 'reset-geo':
        st.geo = dv.defaultState().geo;
        this.commit();
        this.renderPanel();
        this.layout();
        break;
      case 'auto':
        this.toggleEnhance();
        break;
      case 'reset-adj': {
        const d = dv.defaultState();
        st.adj = d.adj;
        st.curve = d.curve;
        st.hsl = d.hsl;
        st.grading = d.grading;
        st.enhance = d.enhance;
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      }
      case 'curve-reset':
        st.curve[this.curveCh] = [[0, 0], [1, 1]];
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'auto-beauty': {
        const on = this.beautyAuto();
        const faceOk = !!this.faces?.length;
        for (const a of dv.ADJ) {
          if (a.g !== 'beauty' || !AUTO_GROUPS.includes(a.bg)) continue;
          st.adj[a.key] = on ? 0 : (a.face && !faceOk ? 0 : AUTO_BEAUTY[a.key] || 0);
        }
        // 자동 뷰티는 모든 얼굴에 같은 값 (얼굴별로 따로 정한 값은 비움)
        st.faceAdj = {};
        this.faceSel = -1;
        this.commit();
        this.renderPanel();
        this.invalidate();
        if (!on) toast(faceOk ? '자연스럽게 다듬었어요 · 슬라이더로 정도를 바꿀 수 있어요' : '얼굴을 찾지 못해 피부만 보정했어요');
        break;
      }
      case 'reset-beauty':
        for (const a of dv.ADJ) if (a.g === 'beauty') st.adj[a.key] = 0;
        st.faceAdj = {};
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'undo-liq':
      case 'clear-liq':
      case 'undo-local':
      case 'clear-local': {
        const act = btn.dataset.act;
        const list = act.endsWith('liq') ? st.liquify : st.local;
        if (act.startsWith('undo')) list.pop();
        else list.length = 0;
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      }
      case 'show-local':
        this.showLocal = !this.showLocal;
        this.renderer.showLocal = this.showLocal;
        this.renderPanel();
        this.invalidate();
        break;
      case 'erase-toggle':
        this.eraseMode = !this.eraseMode;
        this.er.tool = 'fx'; // 켤 때는 항상 '지우기'부터
        this.healMode = false;
        this.ringEl.hidden = true;
        this.renderPanel();
        break;
      case 'undo-erase':
        st.erase.pop();
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'clear-erase':
        st.erase.length = 0;
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'heal-toggle':
        this.eraseMode = false;
        this.healMode = !this.healMode;
        this.renderPanel();
        break;
      case 'one-shot':
        this.oneShot();
        break;
      case 'ai-upscale':
        this.aiUpscale();
        break;
      case 'add-text':
        this.addText();
        break;
      case 'item-edit': {
        const it = st.items[this.selItem];
        if (!it) break;
        promptDialog({ title: '글자 고치기', value: it.text, ok: '바꾸기' }).then((t) => {
          if (!t) return;
          it.text = String(t).slice(0, 80);
          this.commit();
          this.requestPaint();
        });
        break;
      }
      case 'item-delete':
        if (this.selItem >= 0) st.items.splice(this.selItem, 1);
        this.selItem = -1;
        this.commit();
        this.renderPanel();
        this.requestPaint();
        break;
      case 'item-done':
        this.selItem = -1;
        this.renderPanel();
        this.requestPaint();
        break;
      case 'toggle-date': {
        const i = st.items.findIndex((x) => x.t === 'date');
        if (i >= 0) {
          st.items.splice(i, 1);
          this.selItem = -1;
          this.commit();
          this.renderPanel();
          this.requestPaint();
        } else {
          // 오른쪽 아래 (보이는 사진 기준)
          const r = this.canvas.getBoundingClientRect();
          const [x, y] = this.toSource({ clientX: r.left + r.width * 0.8, clientY: r.top + r.height * 0.92 });
          this.addItem({ t: 'date', x, y, s: this.viewSize(0.05), text: this.dateText() });
        }
        break;
      }
      case 'cover-faces':
        this.coverFaces();
        break;
      case 'copy-style':
        looks.setClip(st);
        toast('보정을 복사했어요 · 다른 사진의 편집 화면이나 여러 장 선택 → 더보기에서 붙여넣을 수 있어요', { duration: 4000 });
        this.renderPanel();
        break;
      case 'paste-style': {
        const c = looks.getClip();
        if (c) this.useStyle(c.style, '복사한 보정을 붙여넣었어요');
        break;
      }
      case 'save-preset':
        this.savePresetFlow();
        break;
      case 'manage-presets':
        this.managePresets();
        break;
      case 'undo-fill': {
        const i = st.heals.map((h) => h.t).lastIndexOf('fill');
        if (i >= 0) st.heals.splice(i, 1);
        this.setBusy('되돌리는 중…');
        setTimeout(() => {
          this.syncHeals();
          this.setBusy('');
          this.commit();
          this.renderPanel();
          this.invalidate();
        }, 30);
        break;
      }
      case 'undo-heal':
        st.heals.pop();
        this.syncHeals();
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'undo-stroke':
        st.strokes.pop();
        this.commit();
        this.renderPanel();
        this.requestPaint();
        break;
      case 'clear-strokes':
        st.strokes = [];
        this.commit();
        this.renderPanel();
        this.requestPaint();
        break;
      default:
    }
  }

  /* ---------- 자동 보정 ---------- */

  applyEnhance() {
    const en = this.st.enhance;
    const stats = measure(this.renderer, this.st);
    const keep = Object.fromEntries(dv.ADJ.filter((a) => a.g === 'beauty').map((a) => [a.key, this.st.adj[a.key]]));
    this.st.adj = { ...dv.defaultState().adj, ...dv.autoAdjust(stats, { strength: en.strength, scene: en.scene }).adj, ...keep };
    this.baseDirty = true;
  }

  toggleEnhance() {
    const en = this.st.enhance;
    if (en.on) {
      en.on = false;
      const keep = Object.fromEntries(dv.ADJ.filter((a) => a.g === 'beauty').map((a) => [a.key, this.st.adj[a.key]]));
      this.st.adj = { ...(en.prev ? { ...en.prev } : dv.defaultState().adj), ...keep };
      en.prev = null;
    } else {
      en.prev = { ...this.st.adj };
      en.on = true;
      if (!en.strength) en.strength = 1;
      this.applyEnhance();
    }
    this.commit();
    this.renderPanel();
    this.invalidate();
  }

  handleKey(e) {
    if (isModalOpen() || this.destroyed) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.requestCancel();
    }
  }

  bindCompare() {
    const btn = this.root.querySelector('[data-act="compare"]');
    let timer = 0;
    let held = false;
    const on = (e) => {
      e.preventDefault();
      if (!this.work) return;
      held = false;
      clearTimeout(timer);
      // 누르고 있으면 원본 전체, 짧게 누르면 반반 비교 켜고 끄기
      timer = setTimeout(() => {
        held = true;
        this.comparing = true;
        this.root.classList.add('comparing');
        this.paint();
      }, 260);
    };
    const off = (e) => {
      clearTimeout(timer);
      if (this.comparing) {
        this.comparing = false;
        this.root.classList.remove('comparing');
        this.paint();
        return;
      }
      if (e.type === 'pointerup' && !held) this.toggleSplit();
    };
    btn.addEventListener('pointerdown', on);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, off));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // 가운데 손잡이를 끌어 비교 위치 바꾸기
    const el = this.splitEl;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.dataset.drag = '1';
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.dataset.drag) return;
      const r = this.canvas.getBoundingClientRect();
      this.splitPos = clamp((e.clientX - r.left) / r.width, 0, 1);
      this.positionSplit();
      this.requestPaint();
    });
    const end = () => delete el.dataset.drag;
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  toggleSplit() {
    this.split = !this.split;
    this.root.classList.toggle('splitting', this.split);
    if (!this.split) {
      this.origRenderer?.dispose();
      this.origRenderer = null;
      this.origCanvas = null;
      this.origKey = '';
    } else toast('가운데 손잡이를 좌우로 끌어 원본과 비교해 보세요', { duration: 2500 });
    this.positionSplit();
    this.requestPaint();
  }

  positionSplit() {
    const show = this.split && this.tab !== 'crop' && !!this.view;
    this.splitEl.hidden = !show;
    if (!show) return;
    const c = this.canvas;
    const left = parseFloat(c.style.left) || 0;
    const top = parseFloat(c.style.top) || 0;
    const w = parseFloat(c.style.width) || c.width;
    const h = parseFloat(c.style.height) || c.height;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    // 보이는 부분만큼만 (확대했을 때도 손잡이가 화면 안에)
    const vTop = Math.max(0, top);
    const vBot = Math.min(sh, top + h);
    Object.assign(this.splitEl.style, {
      left: `${clamp(left + w * this.splitPos, 0, sw)}px`,
      top: `${vTop}px`,
      height: `${Math.max(0, vBot - vTop)}px`,
    });
  }

  /** 반반 비교용: 같은 자르기·회전으로 원본(편집 전)을 그림 */
  originalLayer(region, outW, outH, outScale) {
    const key = JSON.stringify([this.st.geo, region, outW, outH]);
    if (this.origCanvas && this.origKey === key) return this.origCanvas;
    if (!this.origRenderer) {
      this.origRenderer = createRenderer();
      this.origRenderer.setSource(this.pristine, this.Ww, this.Hw);
    }
    const st = dv.defaultState();
    st.geo = JSON.parse(JSON.stringify(this.st.geo));
    const { canvas } = this.origRenderer.render(st, { region, outW, outH, outScale });
    const copy = im.makeCanvas(canvas.width, canvas.height);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    this.origCanvas = copy;
    this.origKey = key;
    return copy;
  }

  /* ---------- 자르기 ---------- */

  positionCrop() {
    const { cssW, cssH } = this.view;
    const c = this.st.geo.crop;
    const left = parseFloat(this.canvas.style.left) || 0;
    const top = parseFloat(this.canvas.style.top) || 0;
    Object.assign(this.cropEl.style, {
      left: `${left + c.x * cssW}px`,
      top: `${top + c.y * cssH}px`,
      width: `${c.w * cssW}px`,
      height: `${c.h * cssH}px`,
    });
  }

  bindCrop() {
    let drag = null;
    this.cropEl.addEventListener('pointerdown', (e) => {
      if (this.tab !== 'crop') return;
      e.preventDefault();
      this.cropEl.setPointerCapture(e.pointerId);
      drag = { h: e.target.closest('[data-h]')?.dataset.h || 'move', sx: e.clientX, sy: e.clientY, r0: { ...this.st.geo.crop } };
      this.root.classList.add('cropping');
    });
    this.cropEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.sx) / this.view.cssW;
      const dy = (e.clientY - drag.sy) / this.view.cssH;
      const r0 = drag.r0;
      if (drag.h === 'move') {
        this.st.geo.crop = { ...r0, x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 1 - r0.h) };
      } else {
        const [fw, fh] = this.frame();
        const ratio = aspectValue(this.st.geo.aspect, fw, fh);
        this.st.geo.crop = resizeRect(r0, drag.h, dx, dy, ratio ? (ratio * fh) / fw : null);
      }
      this.positionCrop();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.root.classList.remove('cropping');
      this.commit();
      this.updateTop();
    };
    this.cropEl.addEventListener('pointerup', end);
    this.cropEl.addEventListener('pointercancel', end);
  }

  /* ---------- 그리기 · 잡티 제거 ---------- */

  toSource(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    const [sx, sy] = dv.mapPoint(dv.inv3(this.matrix), x, y);
    return [sx / this.Ww, sy / this.Hw];
  }

  /** 화면에서 보이는 크기가 일정하도록 원본 기준 크기로 환산 */
  visibleToSource(size) {
    const visible = (size / 400) * Math.max(this.canvas.width, this.canvas.height) / this.zoom;
    return visible / dv.matrixScale(this.matrix, this.Ww / 2, this.Hw / 2);
  }

  healAt(nx, ny) {
    const W = this.Ww;
    const H = this.Hw;
    const r = Math.max(3, this.visibleToSource(this.healSize));
    const cx = nx * W;
    const cy = ny * H;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return;
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    if (!this.healImg) this.healImg = ctx.getImageData(0, 0, W, H);
    const [dx, dy] = dv.findHealOffset(this.healImg, cx, cy, r);
    dv.applyHeal(ctx, W, H, cx, cy, r, dx, dy);
    this.st.heals.push({ x: nx, y: ny, r: r / Math.max(W, H), dx: dx / W, dy: dy / H });
    this.appliedHeals = JSON.stringify(this.st.heals);
    this.lastHeal = { cx, cy, r };
    if (!this.uploadQueued) {
      this.uploadQueued = true;
      requestAnimationFrame(() => {
        this.uploadQueued = false;
        this.renderer.setSource(this.work, W, H);
        this.invalidate();
      });
    }
  }

  bindDraw() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.matrix || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (this.tab === 'beauty' && this.healMode) {
        e.preventDefault();
        c.setPointerCapture(e.pointerId);
        this.healing = true;
        this.healImg = null;
        const [nx, ny] = this.renderer.warpPoint(...this.toSource(e));
        this.healAt(nx, ny);
        return;
      }
      if (this.brushTab()) {
        e.preventDefault();
        c.setPointerCapture(e.pointerId);
        this.startOp(e);
        return;
      }
      if (this.tab !== 'draw' || this.tool === 'frame') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      // 글자·스티커·가리기를 누르면 고르고 끌어서 옮김
      const hit = this.hitItem(e);
      if (hit >= 0) {
        this.selItem = hit;
        const it = this.st.items[hit];
        const [sx, sy] = this.toSource(e);
        this.itemDrag = { dx: it.x - sx, dy: it.y - sy, moved: false };
        const t = it.t === 'cover' ? 'cover' : it.t;
        if (this.tool !== t) this.tool = t;
        this.renderPanel();
        this.requestPaint();
        return;
      }
      if (ITEM_TOOLS.includes(this.tool)) {
        const at = this.toSource(e);
        if (this.selItem >= 0) {
          // 고른 것이 있으면 먼저 선택만 해제
          this.selItem = -1;
          this.renderPanel();
          this.requestPaint();
          return;
        }
        if (this.tool === 'text') this.addText(at);
        else if (this.tool === 'sticker') this.addItem({ t: 'sticker', x: at[0], y: at[1], s: this.viewSize(0.12), emoji: this.sticker });
        else if (this.tool === 'date') this.addItem({ t: 'date', x: at[0], y: at[1], s: this.viewSize(0.05), text: this.dateText() });
        else if (this.tool === 'cover') {
          const r = this.viewSize(0.09);
          this.addItem({ t: 'cover', x: at[0], y: at[1], s: r, rx: r, ry: r * 1.15, mode: this.coverMode, emoji: '😊' });
        }
        return;
      }
      this.cur = {
        tool: this.tool,
        color: this.color,
        size: this.visibleToSource(this.sizes[this.tool]) / Math.max(this.Ww, this.Hw),
        pts: this.toSource(e),
      };
      this.requestPaint();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.brushTab()) {
        this.moveRing(e);
        if (this.op) this.moveOp(e);
        return;
      }
      if (this.healing) {
        const [nx, ny] = this.renderer.warpPoint(...this.toSource(e));
        const { cx, cy, r } = this.lastHeal || {};
        if (cx === undefined || Math.hypot(nx * this.Ww - cx, ny * this.Hw - cy) >= r * 0.7) this.healAt(nx, ny);
        return;
      }
      if (this.itemDrag) {
        const [sx, sy] = this.toSource(e);
        const it = this.st.items[this.selItem];
        if (it) {
          it.x = Math.round((sx + this.itemDrag.dx) * 1e5) / 1e5;
          it.y = Math.round((sy + this.itemDrag.dy) * 1e5) / 1e5;
          this.itemDrag.moved = true;
          this.requestPaint();
        }
        return;
      }
      if (!this.cur) return;
      const [x, y] = this.toSource(e);
      const p = this.cur.pts;
      if (Math.abs(x - p[p.length - 2]) + Math.abs(y - p[p.length - 1]) < 0.0015) return;
      p.push(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
      this.requestPaint();
    });
    const end = (e) => {
      if (this.itemDrag) {
        if (this.itemDrag.moved) this.commit();
        this.itemDrag = null;
        return;
      }
      if (this.op) {
        this.endOp();
        if (e.pointerType !== 'mouse') this.ringEl.hidden = true;
        return;
      }
      if (this.healing) {
        this.healing = false;
        this.healImg = null;
        this.lastHeal = null;
        this.commit();
        this.renderPanel();
        return;
      }
      if (!this.cur) return;
      this.st.strokes.push(this.cur);
      this.cur = null;
      this.commit();
      this.renderPanel();
      this.requestPaint();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.op) this.ringEl.hidden = true;
    });
  }

  /* ---------- 성형(손으로 모양 다듬기) · 부분 보정 브러시 ---------- */

  /** 사진 위를 문지르는 탭인지 (이때는 한 손가락으로 이동하지 않음) */
  paintTab() {
    return this.tab === 'draw' || this.brushTab() || (this.tab === 'beauty' && this.healMode);
  }

  /** 성형 · 부분 · 보정 지우개처럼 문질러서 획을 남기는 상태인지 */
  brushTab() {
    return this.tab === 'reshape' || this.tab === 'local' || (this.tab === 'beauty' && this.eraseMode);
  }

  /** 지금 브러시 설정 · 획 목록 · 실제 원본 자리로 옮길지(부분 보정만) */
  brushMode() {
    if (this.tab === 'reshape') return { cfg: this.liq, list: this.st.liquify, warp: false, hold: this.liq.tool !== 'push' };
    if (this.tab === 'local') return { cfg: this.lc, list: this.st.local, warp: true, hold: false };
    return { cfg: this.er, list: this.st.erase, warp: false, hold: false };
  }

  /** 원본 비율 좌표 → 긴 변 = 1 단위 */
  toUnit([nx, ny]) {
    const M = Math.max(this.Ww, this.Hw);
    return [Math.round(((nx * this.Ww) / M) * 1e5) / 1e5, Math.round(((ny * this.Hw) / M) * 1e5) / 1e5];
  }

  brushRadius() {
    const size = this.brushMode().cfg.size;
    return this.visibleToSource(size) / Math.max(this.Ww, this.Hw);
  }

  moveRing(e) {
    const rect = this.stage.getBoundingClientRect();
    const size = this.brushMode().cfg.size;
    // visibleToSource와 같은 기준: 화면 캔버스 픽셀 → CSS 픽셀
    const cr = this.canvas.getBoundingClientRect();
    const d = 2 * ((size / 400) * Math.max(this.canvas.width, this.canvas.height) / this.zoom) * (cr.width / this.canvas.width);
    Object.assign(this.ringEl.style, {
      width: `${d}px`,
      height: `${d}px`,
      left: `${e.clientX - rect.left - d / 2}px`,
      top: `${e.clientY - rect.top - d / 2}px`,
    });
    this.ringEl.hidden = false;
  }

  /** 성형은 보이는 화면 좌표 그대로, 부분 보정은 실제 원본 자리(변형 반영)로 */
  opPoint(e) {
    const p = this.toSource(e);
    return this.toUnit(this.brushMode().warp ? this.renderer.warpPoint(...p) : p);
  }

  startOp(e) {
    if (this.tab === 'local' && this.lc.tool === 'remove') {
      // 사물 지우기: 칠하는 동안은 빨간 표시만, 손을 떼면 채움
      const p = this.toSource(e);
      this.cur = { tool: 'marker', color: '#ff3b30', size: this.brushRadius() * 2, pts: [...p] };
      this.fillPts = [...this.renderer.warpPoint(...p)];
      this.op = { t: 'remove' };
      this.moveRing(e);
      this.requestPaint();
      return;
    }
    const { cfg, list, hold } = this.brushMode();
    const [x, y] = this.opPoint(e);
    this.op = { t: cfg.tool, r: Math.round(this.brushRadius() * 1e5) / 1e5, s: cfg.strength / 100, p: [x, y] };
    this.opList = list;
    this.opList.push(this.op);
    this.moveRing(e);
    // 크게 · 작게 · 지우개(성형): 누르고 있는 동안 계속 적용
    if (hold) {
      this.opHold = setInterval(() => {
        if (!this.op) return;
        const p = this.op.p;
        if (p.length < 4000) p.push(p[p.length - 2], p[p.length - 1]);
        this.invalidate();
      }, 45);
    }
    this.invalidate();
  }

  moveOp(e) {
    const op = this.op;
    if (op.t === 'remove') {
      const [x, y] = this.toSource(e);
      const p = this.cur.pts;
      if (Math.abs(x - p[p.length - 2]) + Math.abs(y - p[p.length - 1]) < 0.002) return;
      p.push(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
      const [sx, sy] = this.renderer.warpPoint(x, y);
      this.fillPts.push(Math.round(sx * 1e5) / 1e5, Math.round(sy * 1e5) / 1e5);
      this.requestPaint();
      return;
    }
    const [x, y] = this.opPoint(e);
    const p = op.p;
    const lx = p[p.length - 2];
    const ly = p[p.length - 1];
    const step = op.t === 'push' ? op.r * 0.04 : op.r * 0.2;
    if (Math.hypot(x - lx, y - ly) < step) return;
    p.push(x, y);
    this.invalidate();
  }

  endOp() {
    clearInterval(this.opHold);
    this.opHold = 0;
    const op = this.op;
    this.op = null;
    if (op.t === 'remove') {
      this.finishRemove();
      return;
    }
    // 밀기를 그냥 톡 누르기만 한 경우는 의미가 없으니 버림
    if (op.t === 'push' && op.p.length < 4) {
      this.opList.pop();
      this.invalidate();
      return;
    }
    this.commit();
    this.renderPanel();
  }

  /* ---------- 원클릭 인생샷 · AI 화질 개선 ---------- */

  async waitIdle(keys) {
    for (let i = 0; i < 900 && keys.some((k) => this[k] === 'busy'); i++) await new Promise((r) => setTimeout(r, 100));
  }

  /** 자동 보정 + 자동 뷰티(얼굴이 있으면) + 배경 살짝 흐림(인물 사진이면) */
  async oneShot() {
    const st = this.st;
    if (this.oneShotPrev) {
      this.st = JSON.parse(this.oneShotPrev);
      this.oneShotPrev = null;
      this.commit();
      this.renderPanel();
      this.invalidate();
      return;
    }
    const prev = JSON.stringify(st);
    this.setBusy('인생샷 만드는 중…');
    try {
      if (!st.enhance.on) this.toggleEnhance();
      if (this.renderer.gpu) {
        if (this.faceState === 'idle') this.ensureFaces();
        await this.waitIdle(['faceState']);
        const faces = this.faces || [];
        if (faces.length) {
          for (const a of dv.ADJ) if (a.g === 'beauty' && AUTO_GROUPS.includes(a.bg)) st.adj[a.key] = a.face || ['skinSmooth', 'skinTone'].includes(a.key) ? AUTO_BEAUTY[a.key] || 0 : st.adj[a.key];
          st.faceAdj = {};
          // 얼굴이 사진에서 충분히 크면 인물 사진 → 배경을 살짝 흐리게
          const big = faces.some((f) => Math.max(...f.map((p) => p[1])) - Math.min(...f.map((p) => p[1])) > 0.12);
          if (big && faces.length <= 3) {
            if (this.segState === 'idle') this.ensureSeg();
            await this.waitIdle(['segState']);
            if (this.person) st.adj.bgBlur = 30;
          }
        }
      }
      this.oneShotPrev = prev;
      this.commit();
      toast('인생샷 완성! 비교 버튼으로 전후를 확인해 보세요');
    } catch (err) {
      console.error(err);
    }
    this.setBusy('');
    this.renderPanel();
    this.invalidate();
  }

  /** 지금 보정을 원본 해상도로 적용한 결과 캔버스 */
  async renderOutput() {
    await this.waitDetect();
    const src = await decode(this.blob);
    const [W, H] = dimsOf(src);
    let source = src;
    if (this.st.heals.length) {
      source = im.makeCanvas(W, H);
      source.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
      dv.applyHeals(source, this.st.heals, 900);
    }
    const out = renderFinal(this.renderer, source, W, H, this.st);
    src.close?.();
    this.renderer.setSource(this.work, this.Ww, this.Hw);
    this.baseDirty = true;
    return out;
  }

  /** AI로 2배 키우기 (지금 보정까지 적용해 사본으로 저장) */
  async aiUpscale() {
    const src = await decode(this.blob);
    const [W, H] = dimsOf(src);
    src.close?.();
    if (W * H > 2_100_000) {
      toast(`이미 충분히 큰 사진이에요 (${Math.round((W * H) / 1e4)}만 화소) · 200만 화소 이하의 작은 사진에서 쓸 수 있어요`, { duration: 4000 });
      return;
    }
    const ok = await confirmDialog({ title: 'AI 화질 개선', message: `지금 보정을 적용한 뒤 AI로 2배(${W * 2}×${H * 2})로 키우고 선명하게 해서 사본으로 저장해요. 처음 한 번 약 2MB를 내려받고, 사진 크기에 따라 몇십 초 걸릴 수 있어요.`, ok: '시작' });
    if (!ok) return;
    this.setBusy('화질 개선 준비 중…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const out = await this.renderOutput();
      const big = await upscale2x(out, (p) => this.setBusy(`AI 화질 개선 중… ${Math.round(p * 100)}%`));
      const blob = await im.canvasToBlob(big, this.type === 'image/png' ? 'image/png' : 'image/jpeg');
      await this.onSave(blob, true, null);
    } catch (err) {
      console.error(err);
      this.setBusy('');
      toast(`화질 개선을 하지 못했어요: ${err.message}`);
    }
  }

  /* ---------- 꾸미기 ---------- */

  decoPanel() {
    const st = this.st;
    const tool = this.tool;
    const it = st.items[this.selItem];
    const tools = `<div class="ed-chips">${TOOLS.map(([k, ic, label]) => `<button type="button" class="ed-chip${tool === k ? ' on' : ''}" data-tool="${k}">${icon(ic)}${label}</button>`).join('')}</div>`;
    const sizeRow = (v) => this.sliderRow({ attrs: 'data-slider="itemSize"', label: '크기', value: v, min: 5, max: 100, text: `${v}`, reset: false });
    const itemBar = it ? `<div class="ed-chips"><button type="button" class="ed-chip" data-act="item-delete">${icon('trash')}지우기</button>${it.t === 'text' ? `<button type="button" class="ed-chip" data-act="item-edit">${icon('edit')}글자 고치기</button>` : ''}<button type="button" class="ed-chip" data-act="item-done">${icon('check')}선택 해제</button></div>` : '';
    const sizeOf = (x) => Math.round(Math.sqrt((x.t === 'cover' ? (x.rx || x.s) : x.s) / 0.3) * 100);
    if (tool === 'text') {
      const cur = it?.t === 'text' ? it : null;
      return `${tools}
        ${cur ? `${sizeRow(sizeOf(cur))}
        <div class="ed-colors">${TEXT_COLORS.map((c) => `<button type="button" class="ed-color${c === cur.color ? ' on' : ''}" data-item-color="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('')}</div>
        <div class="ed-chips">${TEXT_FONTS.map(([k, l]) => `<button type="button" class="ed-chip${cur.font === k ? ' on' : ''}" data-item-font="${k}">${l}</button>`).join('')}${TEXT_STYLES.map(([k, l]) => `<button type="button" class="ed-chip${(cur.style || 'plain') === k ? ' on' : ''}" data-item-style="${k}">${l}</button>`).join('')}</div>
        ${itemBar}` : `<div class="ed-chips"><button type="button" class="ed-chip ed-auto" data-act="add-text">${icon('add')}글자 넣기</button></div>`}
        <p class="ed-hint">${cur ? '글자를 끌어서 옮기고, 크기·색·글꼴을 바꿔 보세요.' : '‘글자 넣기’를 누르거나 사진을 눌러 그 자리에 글자를 넣어요.'}</p>`;
    }
    if (tool === 'sticker') {
      const cur = it?.t === 'sticker' ? it : null;
      return `${tools}
        ${cur ? `${sizeRow(sizeOf(cur))}${itemBar}` : ''}
        <div class="ed-stickers">${STICKERS.map((e) => `<button type="button" class="ed-stk${this.sticker === e ? ' on' : ''}" data-sticker="${e}">${e}</button>`).join('')}</div>
        <p class="ed-hint">스티커를 누르면 사진 가운데에 붙어요. 끌어서 옮기고 크기를 바꿀 수 있어요.</p>`;
    }
    if (tool === 'date') {
      const has = st.items.some((x) => x.t === 'date');
      const cur = it?.t === 'date' ? it : null;
      return `${tools}
        <div class="ed-chips"><button type="button" class="ed-chip${has ? ' on' : ''}" data-act="toggle-date">${icon('event')}${has ? '날짜 빼기' : '찍은 날짜 넣기'}</button></div>
        ${cur ? `${sizeRow(sizeOf(cur))}${itemBar}` : ''}
        <p class="ed-hint">필름 카메라처럼 오른쪽 아래에 주황색 날짜를 새겨요 (${esc(this.dateText())}). 끌어서 옮길 수 있어요.</p>`;
    }
    if (tool === 'cover') {
      const cur = it?.t === 'cover' ? it : null;
      return `${tools}
        <div class="ed-chips">
          <button type="button" class="ed-chip ed-auto" data-act="cover-faces"${this.renderer?.gpu === false ? ' disabled' : ''}>${icon('face')}얼굴 자동 가리기</button>
          ${COVER_MODES.map(([k, l]) => `<button type="button" class="ed-chip${(cur ? cur.mode : this.coverMode) === k ? ' on' : ''}" data-cover-mode="${k}">${l}</button>`).join('')}
        </div>
        ${cur ? `${sizeRow(sizeOf(cur))}${itemBar}` : ''}
        <p class="ed-hint">얼굴을 찾아 한 번에 가려요. 사진을 누르면 그 자리를 가리고, 가린 곳을 눌러 옮기거나 지울 수 있어요.</p>`;
    }
    if (tool === 'frame') {
      const f = st.frame;
      return `${tools}
        <div class="ed-chips">${FRAME_ASPECTS.map(([k, l]) => `<button type="button" class="ed-chip${f.aspect === k ? ' on' : ''}" data-frame-aspect="${k}">${l}</button>`).join('')}</div>
        <div class="ed-chips">${[['white', '흰 여백'], ['black', '검은 여백'], ['blur', '흐린 사진']].map(([k, l]) => `<button type="button" class="ed-chip${f.fill === k ? ' on' : ''}" data-frame-fill="${k}">${l}</button>`).join('')}</div>
        ${this.sliderRow({ attrs: 'data-slider="framePad"', label: '테두리', value: f.pad, min: 0, max: 20, text: `${f.pad}%`, reset: false })}
        <p class="ed-hint">사진을 자르지 않고 여백을 채워 인스타그램(4:5 · 1:1)이나 스토리(9:16) 비율로 맞춰요. 테두리를 올리면 폴라로이드처럼 돼요.</p>`;
    }
    return `${tools}
      <div class="ed-chips">
        <button type="button" class="ed-chip" data-act="undo-stroke"${st.strokes.length ? '' : ' disabled'}>${icon('undo')}한 획 지우기</button>
        <button type="button" class="ed-chip" data-act="clear-strokes"${st.strokes.length ? '' : ' disabled'}>${icon('trash')}모두 지우기</button>
      </div>
      <div class="ed-colors"${tool === 'mosaic' ? ' hidden' : ''}>${COLORS.map((c) => `<button type="button" class="ed-color${c === this.color ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('')}</div>
      ${this.sliderRow({ attrs: 'data-slider="size"', label: '굵기', value: this.sizes[tool], min: 1, max: 40, text: `${this.sizes[tool]}`, reset: false })}
      <p class="ed-hint">${tool === 'mosaic' ? '가리고 싶은 부분(얼굴, 번호판, 개인정보)을 문질러 주세요' : '사진 위에 손가락이나 마우스로 그려 보세요 (두 손가락으로 확대)'}</p>`;
  }

  /** 여백 미리보기 (흰색 · 검정 · 흐린 사진) */
  drawFramePreview() {
    const fr = this.view?.frame;
    if (!fr || !this.glCanvas) return;
    const f = this.st.frame;
    const el = this.frameEl;
    const k = 48 / Math.max(fr[0], fr[1]);
    const w = Math.max(2, Math.round(fr[0] * k));
    const h = Math.max(2, Math.round(fr[1] * k));
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext('2d');
    if (f.fill === 'blur') {
      const s = Math.max(w / this.glCanvas.width, h / this.glCanvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.glCanvas, (w - this.glCanvas.width * s) / 2, (h - this.glCanvas.height * s) / 2, this.glCanvas.width * s, this.glCanvas.height * s);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = f.fill === 'black' ? '#000' : '#fff';
      ctx.fillRect(0, 0, w, h);
    }
  }

  dateText() {
    const d = new Date(this.takenAt);
    const p2 = (v) => String(v).padStart(2, '0');
    return `'${p2(d.getFullYear() % 100)} ${p2(d.getMonth() + 1)} ${p2(d.getDate())}`;
  }

  /** 지금 화면 가운데의 원본 좌표 */
  viewCenter() {
    const r = this.canvas.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const cx = Math.min(Math.max(sr.left + sr.width / 2, r.left), r.right);
    const cy = Math.min(Math.max(sr.top + sr.height / 2, r.top), r.bottom);
    return this.toSource({ clientX: cx, clientY: cy });
  }

  /** 화면에서 보이는 크기(비율 0~1)를 원본 기준 크기로 */
  viewSize(frac) {
    return this.visibleToSource(frac * 400) / Math.max(this.Ww, this.Hw);
  }

  addItem(item) {
    this.st.items.push(item);
    this.selItem = this.st.items.length - 1;
    this.commit();
    this.renderPanel();
    this.requestPaint();
  }

  async addText(at) {
    const text = await promptDialog({ title: '글자 넣기', placeholder: '넣을 글자를 입력하세요', ok: '넣기' });
    if (!text) return;
    const [x, y] = at || this.viewCenter();
    this.addItem({ t: 'text', x, y, s: this.viewSize(0.07), text: String(text).slice(0, 80), color: '#ffffff', font: 'sans', style: 'plain' });
  }

  async coverFaces() {
    this.setBusy('얼굴을 찾는 중…');
    try {
      if (this.faceState === 'idle') await this.ensureFaces();
      while (this.faceState === 'busy') await new Promise((r) => setTimeout(r, 100));
    } finally {
      this.setBusy('');
    }
    const faces = this.faces || [];
    if (!faces.length) {
      toast('얼굴을 찾지 못했어요 · 사진을 눌러 직접 가릴 수 있어요');
      return;
    }
    const M = Math.max(this.Ww, this.Hw);
    for (const f of faces) {
      const xs = f.map((p) => p[0]);
      const ys = f.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const rx = (((x1 - x0) * this.Ww) / M) * 0.62;
      const ry = (((y1 - y0) * this.Hw) / M) * 0.68;
      this.st.items.push({ t: 'cover', x: (x0 + x1) / 2, y: (y0 + y1) / 2 - (y1 - y0) * 0.04, s: Math.max(rx, ry), rx, ry, mode: this.coverMode, emoji: '😊' });
    }
    this.selItem = -1;
    this.commit();
    this.renderPanel();
    this.requestPaint();
    toast(`얼굴 ${faces.length}개를 가렸어요`);
  }

  /** 화면 좌표에서 고를 수 있는 꾸미기 항목 */
  hitItem(e) {
    if (!this.itemBoxes?.length) return -1;
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    const pad = 10 * (this.canvas.width / r.width);
    for (let k = this.itemBoxes.length - 1; k >= 0; k--) {
      const b = this.itemBoxes[k];
      if (x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return b.i;
    }
    return -1;
  }

  /** 프리셋·복사한 보정 적용 (사진마다 다른 자르기·지우기 등은 그대로) */
  useStyle(style, msg) {
    looks.applyStyle(this.st, style);
    const need = looks.styleNeeds(this.st.adj);
    if (need.faces) this.ensureFaces();
    if (need.poses) this.ensurePose();
    if (need.person) this.ensureSeg();
    if (need.sky) this.ensureSky();
    this.faceSel = -1;
    this.commit();
    this.renderPanel();
    this.invalidate();
    toast(msg);
  }

  async savePresetFlow() {
    const name = await promptDialog({ title: '내 보정 저장', placeholder: '예: 따뜻한 카페 · 인생샷 피부', ok: '저장' });
    if (name === null || name === undefined) return;
    const item = looks.savePreset(String(name) || '내 보정', this.st);
    toast(item ? `‘${item.name}’을 저장했어요 · 다른 사진에도 한 번에 적용할 수 있어요` : '저장하지 못했어요 (브라우저 저장 공간을 확인해 주세요)');
    this.renderPanel();
  }

  async managePresets() {
    const list = looks.listPresets();
    const id = await actionSheet({ title: '지울 보정을 고르세요', items: list.map((p) => ({ label: p.name, icon: 'trash', value: p.id })) });
    if (!id) return;
    const p = looks.getPreset(id);
    if (!p || !(await confirmDialog({ title: `‘${p.name}’을 지울까요?`, ok: '지우기', danger: true }))) return;
    looks.deletePreset(id);
    this.renderPanel();
  }

  /** 사물 지우기: 칠한 곳을 주변 배경으로 채움 (작업용 이미지에 바로 적용, 저장할 때는 원본 해상도로 다시) */
  finishRemove() {
    const cur = this.cur;
    this.cur = null;
    if (!cur) return;
    const op = { t: 'fill', r: Math.round((cur.size / 2) * 1e5) / 1e5, p: this.fillPts, seed: this.st.heals.length + 1 };
    this.fillPts = null;
    this.setBusy('지우는 중…');
    setTimeout(() => {
      try {
        removeArea(this.work, op, 520);
        this.st.heals.push(op);
        this.appliedHeals = JSON.stringify(this.st.heals);
        this.renderer.setSource(this.work, this.Ww, this.Hw);
        this.commit();
      } catch (err) {
        console.error(err);
        toast('지우지 못했어요');
      }
      this.setBusy('');
      this.renderPanel();
      this.invalidate();
    }, 30);
  }

  /** 두 손가락 확대가 시작되면 그리던 획은 취소 */
  cancelOp() {
    if (this.op?.t === 'remove') {
      this.op = null;
      this.cur = null;
      this.fillPts = null;
      this.ringEl.hidden = true;
      this.requestPaint();
      return;
    }
    if (!this.op) return;
    clearInterval(this.opHold);
    this.opHold = 0;
    const i = this.opList.indexOf(this.op);
    if (i >= 0) this.opList.splice(i, 1);
    this.op = null;
    this.ringEl.hidden = true;
    this.invalidate();
  }

  /* ---------- 저장 · 닫기 ---------- */

  setBusy(text) {
    this.root.classList.toggle('busy', !!text);
    this.root.querySelector('.ed-busy span').textContent = text || '';
  }

  async save() {
    if (!this.dirty) return;
    const choice = await actionSheet({
      title: '편집한 사진 저장',
      items: [
        { label: '저장', icon: 'check', value: 'replace', hint: '편집 전 원본은 보관돼서 언제든 되돌릴 수 있어요' },
        { label: '사본으로 저장', icon: 'copy', value: 'copy', hint: '원본은 그대로 두고 새 사진으로 저장해요' },
      ],
    });
    if (!choice) return;
    this.setBusy('저장하는 중…');
    await this.waitDetect();
    await new Promise((r) => setTimeout(r, 30));
    try {
      const src = await decode(this.blob);
      const [W, H] = dimsOf(src);
      let source = src;
      if (this.st.heals.length) {
        // 잡티 제거는 원본 해상도에서 같은 위치·비율로 다시 적용
        source = im.makeCanvas(W, H);
        source.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
        dv.applyHeals(source, this.st.heals, 900);
      }
      const out = renderFinal(this.renderer, source, W, H, this.st);
      src.close?.();
      this.renderer.setSource(this.work, this.Ww, this.Hw);
      this.baseDirty = true;
      const blob = await im.canvasToBlob(out, this.type);
      looks.setClip(this.st); // 마지막으로 저장한 보정 → 다른 사진에 붙여넣기 가능
      await this.onSave(blob, choice === 'copy', JSON.parse(JSON.stringify(this.st)));
    } catch (err) {
      console.error(err);
      toast(`저장하지 못했어요: ${err.message}`);
      this.setBusy('');
      try {
        this.renderer.setSource(this.work, this.Ww, this.Hw);
        this.layout();
      } catch {
        /* 무시 */
      }
    }
  }

  async confirmDiscard() {
    if (!this.dirty) return true;
    return confirmDialog({ title: '편집을 그만둘까요?', message: '저장하지 않은 변경 내용은 사라져요.', ok: '그만두기', danger: true });
  }

  async requestCancel() {
    if (await this.confirmDiscard()) this.onCancel();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.opHold);
    this.origRenderer?.dispose();
    clearTimeout(this.histTimer);
    clearTimeout(this.hiResTimer);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey);
    document.body.classList.remove('editor-open');
    this.root.classList.remove('open');
    this.renderer?.dispose();
    setTimeout(() => this.root.remove(), 200);
  }
}
