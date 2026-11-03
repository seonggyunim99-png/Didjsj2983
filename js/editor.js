// 사진 편집기: 보정(자동·장면) · 자르기/원근 · 필터 · 조정(빛·색상·효과·디테일·톤 커브·색상별·컬러 그레이딩)
//             · 인물(피부·잡티 제거) · 그리기(펜·형광펜·모자이크)
import { icon, esc, toast, confirmDialog, actionSheet, isModalOpen } from './ui.js';
import * as dv from './develop.js';
import * as im from './imaging.js';
import { createRenderer, measure, renderFinal, drawStrokes } from './glrender.js';

const TABS = [
  ['enhance', 'auto', '보정'],
  ['crop', 'crop', '자르기'],
  ['filter', 'filter', '필터'],
  ['adjust', 'tune', '조정'],
  ['beauty', 'face', '인물'],
  ['draw', 'brush', '그리기'],
];
const ASPECTS = [['free', '자유'], ['orig', '원본'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16']];
const TOOLS = [['pen', 'edit', '펜'], ['marker', 'brush', '형광펜'], ['mosaic', 'mosaic', '모자이크']];
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

  constructor({ blob, type, name, onSave, onCancel }) {
    this.blob = blob;
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
    this.tool = 'pen';
    this.color = '#ff3b30';
    this.sizes = { pen: 6, marker: 18, mosaic: 26 };
    this.healMode = false;
    this.healSize = 12;
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
          <button type="button" class="ed-icon" data-act="compare" aria-label="원본과 비교 (누르고 있기)" title="누르고 있으면 원본을 보여줘요">${icon('compare')}</button>
        </div>
        <button type="button" class="btn primary sm" data-act="save">저장</button>
      </header>
      <div class="ed-stage">
        <canvas class="ed-canvas"></canvas>
        <div class="ed-crop" hidden><i class="ed-grid"></i>${HANDLES.map((h) => `<span class="ed-h ed-h-${h}" data-h="${h}"></span>`).join('')}</div>
        <canvas class="ed-hist" width="160" height="70" hidden></canvas>
        <button type="button" class="ed-zoom" data-act="zoom-reset" hidden></button>
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
    this.root.classList.remove('loading');
    this.renderPanel();
    this.layout();
  }

  get dirty() {
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
    const fit = Math.min(sw / rw, sh / rh);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const maxPx = (this.renderer?.maxTex || 4096) / Math.max(rw, rh);
    const pxScale = Math.min(fit * this.zoom * dpr, 1, maxPx);
    this.canvas.width = Math.max(1, Math.round(rw * pxScale));
    this.canvas.height = Math.max(1, Math.round(rh * pxScale));
    this.view = { rw, rh, fit, pxScale: this.canvas.width / rw, region };
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
    this.zoomEl.hidden = this.zoom <= 1.01;
    this.zoomEl.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this.tab === 'crop') this.positionCrop();
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
    const canPan = () => this.zoom > 1.01 && this.tab !== 'crop' && this.tab !== 'draw' && !(this.tab === 'beauty' && this.healMode);
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ed-crop, .ed-zoom')) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && this.tab !== 'crop') {
        // 두 손가락: 그리던 것은 취소하고 확대/이동
        this.cur = null;
        this.healing = false;
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
      if (this.tab === 'crop' || this.tab === 'draw' || (this.tab === 'beauty' && this.healMode)) return;
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
        const res = this.renderer.render(this.st, { region, outW: c.width, outH: c.height, outScale: pxScale });
        this.glCanvas = res.canvas;
        this.matrix = res.matrix;
      }
      this.baseDirty = false;
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.glCanvas, 0, 0);
    const strokes = this.cur ? [...this.st.strokes, this.cur] : this.st.strokes;
    drawStrokes(ctx, this.glCanvas, strokes, this.matrix, this.Ww, this.Hw);
    if (this.tab === 'crop') this.positionCrop();
    this.updateTop();
    this.scheduleHistogram();
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
      html = `
        <button type="button" class="ed-auto-big${en.on ? ' on' : ''}" data-act="auto" aria-pressed="${en.on}">
          ${icon('auto')}<span><strong>자동 보정${en.on ? ' 켜짐' : ''}</strong><small>${en.on ? '한 번 더 누르면 꺼져요 · 세부 값은 ‘조정’ 탭에서 바꿀 수 있어요' : '사진을 분석해서 노출·대비·화이트밸런스·색감을 알맞게 맞춰요'}</small></span>
        </button>
        <div class="ed-chips">${dv.SCENES.map((sc) => `<button type="button" class="ed-chip${en.on && en.scene === sc.id ? ' on' : ''}" data-scene="${sc.id}" title="${esc(sc.hint)}">${esc(sc.name)}</button>`).join('')}</div>
        ${en.on ? this.sliderRow({ attrs: 'data-slider="strength"', label: '강도', value: Math.round(en.strength * 100), min: 0, max: 150, step: 5, text: `${Math.round(en.strength * 100)}`, reset: false }) : '<p class="ed-hint">장면을 고르면 그 장면에 맞게 보정해요</p>'}`;
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
      html = `
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
      html = `
        ${dv.ADJ.filter((a) => a.g === 'beauty').map((a) => this.adjRow(a)).join('')}
        <div class="ed-chips">
          <button type="button" class="ed-chip${this.healMode ? ' on' : ''}" data-act="heal-toggle">${icon('healing')}잡티 제거 브러시</button>
          <button type="button" class="ed-chip" data-act="undo-heal"${st.heals.length ? '' : ' disabled'}>${icon('undo')}잡티 하나 되돌리기</button>
        </div>
        ${this.healMode ? this.sliderRow({ attrs: 'data-slider="healSize"', label: '브러시 크기', value: this.healSize, min: 4, max: 40, text: `${this.healSize}`, reset: false }) : ''}
        <p class="ed-hint">${this.healMode ? '사진을 확대한 뒤 잡티·여드름·점을 톡 누르거나 문지르세요. 주변 피부로 자연스럽게 메워요.' : '피부 보정은 얼굴과 피부색 부분에만 적용돼요. 잡티 제거 브러시로 점·뾰루지를 지울 수 있어요.'}</p>`;
    } else if (this.tab === 'draw') {
      html = `
        <div class="ed-chips">
          ${TOOLS.map(([k, ic, label]) => `<button type="button" class="ed-chip${this.tool === k ? ' on' : ''}" data-tool="${k}">${icon(ic)}${label}</button>`).join('')}
          <button type="button" class="ed-chip" data-act="undo-stroke"${st.strokes.length ? '' : ' disabled'}>${icon('undo')}한 획 지우기</button>
          <button type="button" class="ed-chip" data-act="clear-strokes"${st.strokes.length ? '' : ' disabled'}>${icon('trash')}모두 지우기</button>
        </div>
        <div class="ed-colors"${this.tool === 'mosaic' ? ' hidden' : ''}>${COLORS.map((c) => `<button type="button" class="ed-color${c === this.color ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('')}</div>
        ${this.sliderRow({ attrs: 'data-slider="size"', label: '굵기', value: this.sizes[this.tool], min: 1, max: 40, text: `${this.sizes[this.tool]}`, reset: false })}
        <p class="ed-hint">${this.tool === 'mosaic' ? '가리고 싶은 부분(얼굴, 번호판, 개인정보)을 문질러 주세요' : '사진 위에 손가락이나 마우스로 그려 보세요 (두 손가락으로 확대)'}</p>`;
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
      st.adj[a.key] = v;
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
      default:
    }
  }

  handleClick(e) {
    const t = e.target;
    const tab = t.closest('.ed-tab');
    if (tab) {
      if (this.tab !== tab.dataset.tab) {
        this.tab = tab.dataset.tab;
        if (this.tab !== 'beauty') this.healMode = false;
        this.renderPanel();
        this.layout();
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
      this.renderPanel();
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
      case 'heal-toggle':
        this.healMode = !this.healMode;
        this.renderPanel();
        break;
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
    this.st.adj = { ...dv.defaultState().adj, ...dv.autoAdjust(stats, { strength: en.strength, scene: en.scene }).adj };
    this.baseDirty = true;
  }

  toggleEnhance() {
    const en = this.st.enhance;
    if (en.on) {
      en.on = false;
      this.st.adj = en.prev ? { ...en.prev } : dv.defaultState().adj;
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
    const on = (e) => {
      e.preventDefault();
      if (!this.work) return;
      this.comparing = true;
      this.root.classList.add('comparing');
      this.paint();
    };
    const off = () => {
      if (!this.comparing) return;
      this.comparing = false;
      this.root.classList.remove('comparing');
      this.paint();
    };
    btn.addEventListener('pointerdown', on);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, off));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
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
        const [nx, ny] = this.toSource(e);
        this.healAt(nx, ny);
        return;
      }
      if (this.tab !== 'draw') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.cur = {
        tool: this.tool,
        color: this.color,
        size: this.visibleToSource(this.sizes[this.tool]) / Math.max(this.Ww, this.Hw),
        pts: this.toSource(e),
      };
      this.requestPaint();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.healing) {
        const [nx, ny] = this.toSource(e);
        const { cx, cy, r } = this.lastHeal || {};
        if (cx === undefined || Math.hypot(nx * this.Ww - cx, ny * this.Hw - cy) >= r * 0.7) this.healAt(nx, ny);
        return;
      }
      if (!this.cur) return;
      const [x, y] = this.toSource(e);
      const p = this.cur.pts;
      if (Math.abs(x - p[p.length - 2]) + Math.abs(y - p[p.length - 1]) < 0.0015) return;
      p.push(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
      this.requestPaint();
    });
    const end = () => {
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
    await new Promise((r) => setTimeout(r, 30));
    try {
      const src = await decode(this.blob);
      const [W, H] = dimsOf(src);
      let source = src;
      if (this.st.heals.length) {
        // 잡티 제거는 원본 해상도에서 같은 위치·비율로 다시 적용
        source = im.makeCanvas(W, H);
        source.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
        dv.applyHeals(source, this.st.heals);
      }
      const out = renderFinal(this.renderer, source, W, H, this.st);
      src.close?.();
      this.renderer.setSource(this.work, this.Ww, this.Hw);
      this.baseDirty = true;
      const blob = await im.canvasToBlob(out, this.type);
      await this.onSave(blob, choice === 'copy');
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
