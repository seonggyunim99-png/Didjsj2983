// 사진 편집기 화면: 자르기·회전, 필터, 조정, 그리기(펜·형광펜·모자이크)
import { icon, esc, toast, confirmDialog, actionSheet, isModalOpen } from './ui.js';
import * as im from './imaging.js';

const TABS = [
  ['crop', 'crop', '자르기'],
  ['filter', 'filter', '필터'],
  ['adjust', 'tune', '조정'],
  ['draw', 'brush', '그리기'],
];
const ASPECTS = [
  ['free', '자유'], ['orig', '원본'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16'],
];
const TOOLS = [['pen', 'edit', '펜'], ['marker', 'brush', '형광펜'], ['mosaic', 'mosaic', '모자이크']];
const COLORS = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const WORK_MAX = 2048;
const MIN_CROP = 0.06;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);

async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
const dimsOf = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height];

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
  if (!ratio) return { ...im.FULL };
  let w = 1;
  let h = 1 / ratio;
  if (h > 1) {
    h = 1;
    w = ratio;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

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
    this.st = im.defaultState();
    this.history = [JSON.stringify(this.st)];
    this.hIndex = 0;
    this.tab = 'crop';
    this.adjKey = 'brightness';
    this.tool = 'pen';
    this.color = '#ff3b30';
    this.sizes = { pen: 6, marker: 18, mosaic: 26 };
    this.baseDirty = true;
    this.cur = null;

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
        <div class="ed-busy"><i></i><span></span></div>
      </div>
      <div class="ed-panel"></div>
      <nav class="ed-tabs">${TABS.map(([k, ic, label]) => `<button type="button" class="ed-tab" data-tab="${k}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav>`;
    this.root = root;
    this.stage = root.querySelector('.ed-stage');
    this.canvas = root.querySelector('.ed-canvas');
    this.cropEl = root.querySelector('.ed-crop');
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
    this.bindCompare();
    this.bindCrop();
    this.bindDraw();
  }

  async load() {
    try {
      const src = await decode(this.blob);
      const [W, H] = dimsOf(src);
      if (!W || !H) throw new Error('empty');
      const k = Math.min(1, WORK_MAX / Math.max(W, H));
      this.work = im.makeCanvas(W * k, H * k);
      const ctx = this.work.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, this.work.width, this.work.height);
      src.close?.();
      this.Ww = this.work.width;
      this.Hw = this.work.height;
    } catch {
      this.destroy();
      throw new Error('이 사진은 브라우저에서 열 수 없어 편집할 수 없어요.');
    }
    this.root.classList.remove('loading');
    this.renderPanel();
    this.layout();
  }

  get dirty() {
    return im.isEdited(this.st);
  }

  region() {
    return this.tab === 'crop' ? im.FULL : this.st.geo.crop;
  }

  frame() {
    return im.frameDims(this.Ww, this.Hw, this.st.geo);
  }

  /* ---------- 배치 · 그리기 ---------- */

  layout() {
    if (!this.work) return;
    const pad = this.tab === 'crop' ? 26 : 12;
    const sw = Math.max(40, this.stage.clientWidth - pad * 2);
    const sh = Math.max(40, this.stage.clientHeight - pad * 2);
    const region = this.region();
    const [fw, fh] = this.frame();
    const rw = region.w * fw;
    const rh = region.h * fh;
    const k = Math.min(sw / rw, sh / rh);
    const cssW = rw * k;
    const cssH = rh * k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxScale = Math.min(k * dpr, 1);
    this.canvas.width = Math.max(1, Math.round(rw * pxScale));
    this.canvas.height = Math.max(1, Math.round(rh * pxScale));
    Object.assign(this.canvas.style, {
      width: `${cssW}px`,
      height: `${cssH}px`,
      left: `${(this.stage.clientWidth - cssW) / 2}px`,
      top: `${(this.stage.clientHeight - cssH) / 2}px`,
    });
    this.view = { cssW, cssH, pxScale: this.canvas.width / rw, region };
    this.cropEl.hidden = this.tab !== 'crop';
    this.baseDirty = true;
    this.paint();
  }

  requestPaint() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  paint() {
    if (!this.work || this.destroyed) return;
    const { pxScale, region } = this.view;
    const c = this.canvas;
    const ctx = c.getContext('2d');
    if (this.comparing) {
      ctx.clearRect(0, 0, c.width, c.height);
      const r = Math.min(c.width / this.Ww, c.height / this.Hw);
      const w = this.Ww * r;
      const h = this.Hw * r;
      ctx.drawImage(this.work, (c.width - w) / 2, (c.height - h) / 2, w, h);
      return;
    }
    if (this.baseDirty) {
      this.base = im.renderBase(this.work, this.Ww, this.Hw, this.st, region, c.width, c.height, pxScale);
      this.baseDirty = false;
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.base, 0, 0);
    this.matrix = im.geoMatrix(this.Ww, this.Hw, this.st.geo, region, pxScale);
    const strokes = this.cur ? [...this.st.strokes, this.cur] : this.st.strokes;
    im.drawOverlays(ctx, this.base, strokes, this.matrix, this.Ww, this.Hw);
    if (this.tab === 'crop') this.positionCrop();
    this.updateTop();
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

  /* ---------- 패널 ---------- */

  renderPanel() {
    this.root.querySelectorAll('.ed-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === this.tab));
    this.root.dataset.tab = this.tab;
    const st = this.st;
    let html = '';
    if (this.tab === 'crop') {
      html = `
        <div class="ed-chips">${ASPECTS.map(([k, label]) => `<button type="button" class="ed-chip${st.geo.aspect === k ? ' on' : ''}" data-aspect="${k}">${label}</button>`).join('')}</div>
        ${this.sliderRow('angle', '기울기', st.geo.angle, -45, 45, 0.5, `${signed(st.geo.angle)}°`)}
        <div class="ed-btns">
          <button type="button" class="ed-btn" data-act="rotate">${icon('rotate')}<span>회전</span></button>
          <button type="button" class="ed-btn" data-act="flip">${icon('flip')}<span>좌우 반전</span></button>
          <button type="button" class="ed-btn" data-act="flipv">${icon('flip', 'rot90')}<span>상하 반전</span></button>
          <button type="button" class="ed-btn" data-act="reset-geo">${icon('restore')}<span>초기화</span></button>
        </div>`;
    } else if (this.tab === 'filter') {
      html = `
        <div class="ed-filters">${im.FILTERS.map((f) => `
          <button type="button" class="ed-filter${st.filter === f.id ? ' on' : ''}" data-filter="${f.id}">
            <canvas width="2" height="2"></canvas><span>${esc(f.name)}</span>
          </button>`).join('')}
        </div>
        ${st.filter === 'none' ? '<p class="ed-hint">필터를 고르면 강도를 조절할 수 있어요</p>' : this.sliderRow('filterAmt', '강도', Math.round(st.filterAmt * 100), 0, 100, 1, `${Math.round(st.filterAmt * 100)}`)}`;
    } else if (this.tab === 'adjust') {
      const a = im.ADJUSTMENTS.find((x) => x.key === this.adjKey);
      const v = st.adj[a.key];
      html = `
        ${this.sliderRow('adj', a.label, v, a.min, a.max, 1, signed(v), a.min < 0)}
        <div class="ed-chips">
          <button type="button" class="ed-chip ed-auto${st.auto ? ' on' : ''}" data-act="auto">${icon('auto')}자동 보정</button>
          ${im.ADJUSTMENTS.map((x) => `<button type="button" class="ed-chip${x.key === this.adjKey ? ' on' : ''}${st.adj[x.key] ? ' changed' : ''}" data-adj="${x.key}">${x.label}${st.adj[x.key] ? `<small>${signed(st.adj[x.key])}</small>` : ''}</button>`).join('')}
          <button type="button" class="ed-chip" data-act="reset-adj">${icon('restore')}모두 초기화</button>
        </div>`;
    } else if (this.tab === 'draw') {
      html = `
        <div class="ed-chips">
          ${TOOLS.map(([k, ic, label]) => `<button type="button" class="ed-chip${this.tool === k ? ' on' : ''}" data-tool="${k}">${icon(ic)}${label}</button>`).join('')}
          <button type="button" class="ed-chip" data-act="undo-stroke"${st.strokes.length ? '' : ' disabled'}>${icon('undo')}한 획 지우기</button>
          <button type="button" class="ed-chip" data-act="clear-strokes"${st.strokes.length ? '' : ' disabled'}>${icon('trash')}모두 지우기</button>
        </div>
        <div class="ed-colors"${this.tool === 'mosaic' ? ' hidden' : ''}>${COLORS.map((c) => `<button type="button" class="ed-color${c === this.color ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('')}</div>
        ${this.sliderRow('size', '굵기', this.sizes[this.tool], 1, 40, 1, `${this.sizes[this.tool]}`)}
        <p class="ed-hint">${this.tool === 'mosaic' ? '가리고 싶은 부분(얼굴, 번호판, 개인정보)을 문질러 주세요' : '사진 위에 손가락이나 마우스로 그려 보세요'}</p>`;
    }
    this.panel.innerHTML = html;
    this.panel.querySelectorAll('input[type=range]').forEach((r) => this.paintSlider(r));
    if (this.tab === 'filter') this.buildFilterThumbs();
  }

  sliderRow(name, label, value, min, max, step, text, bipolar = min < 0) {
    return `<div class="ed-slider-row">
      <span class="ed-slider-label">${label}</span>
      <input type="range" data-slider="${name}" min="${min}" max="${max}" step="${step}" value="${value}"${bipolar ? ' data-bipolar' : ''} aria-label="${label}">
      <output>${text}</output>
    </div>`;
  }

  paintSlider(r) {
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
    const w = Math.max(1, Math.round(rw * k));
    const h = Math.max(1, Math.round(rh * k));
    const base = im.renderBase(this.work, this.Ww, this.Hw, { ...this.st, filter: 'none' }, region, w, h, k);
    const neutral = im.defaultState();
    this.panel.querySelectorAll('.ed-filter').forEach((btn) => {
      const c = btn.querySelector('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(base, 0, 0);
      if (btn.dataset.filter !== 'none') {
        const img = ctx.getImageData(0, 0, w, h);
        im.applyAdjust(img, { ...neutral, filter: btn.dataset.filter, filterAmt: 1 });
        ctx.putImageData(img, 0, 0);
      }
    });
  }

  /* ---------- 입력 처리 ---------- */

  handleInput(e) {
    const r = e.target;
    if (!r.matches('input[type=range]')) return;
    this.paintSlider(r);
    const v = +r.value;
    const out = r.parentElement.querySelector('output');
    switch (r.dataset.slider) {
      case 'angle':
        this.st.geo.angle = v;
        out.textContent = `${signed(v)}°`;
        this.invalidate();
        break;
      case 'filterAmt':
        this.st.filterAmt = v / 100;
        out.textContent = `${v}`;
        this.invalidate();
        break;
      case 'adj': {
        this.st.adj[this.adjKey] = v;
        out.textContent = signed(v);
        const chip = this.panel.querySelector(`[data-adj="${this.adjKey}"]`);
        if (chip) {
          chip.classList.toggle('changed', !!v);
          const label = im.ADJUSTMENTS.find((x) => x.key === this.adjKey).label;
          chip.innerHTML = `${label}${v ? `<small>${signed(v)}</small>` : ''}`;
        }
        this.invalidate();
        break;
      }
      case 'size':
        this.sizes[this.tool] = v;
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
        this.renderPanel();
        this.layout();
      }
      return;
    }
    const aspect = t.closest('[data-aspect]');
    if (aspect) {
      this.st.geo.aspect = aspect.dataset.aspect;
      const [fw, fh] = this.frame();
      const ratio = aspectValue(this.st.geo.aspect, fw, fh);
      this.st.geo.crop = fitAspect(ratio ? (ratio * fh) / fw : null);
      this.commit();
      this.renderPanel();
      this.paint();
      return;
    }
    const filter = t.closest('[data-filter]');
    if (filter) {
      this.st.filter = filter.dataset.filter;
      if (this.st.filter !== 'none' && !this.st.filterAmt) this.st.filterAmt = 1;
      this.commit();
      this.panel.querySelectorAll('.ed-filter').forEach((b) => b.classList.toggle('on', b === filter));
      const row = this.panel.querySelector('.ed-slider-row, .ed-hint');
      const html = this.st.filter === 'none'
        ? '<p class="ed-hint">필터를 고르면 강도를 조절할 수 있어요</p>'
        : this.sliderRow('filterAmt', '강도', Math.round(this.st.filterAmt * 100), 0, 100, 1, `${Math.round(this.st.filterAmt * 100)}`);
      row.outerHTML = html;
      this.panel.querySelectorAll('input[type=range]').forEach((r) => this.paintSlider(r));
      this.invalidate();
      return;
    }
    const adj = t.closest('[data-adj]');
    if (adj) {
      this.adjKey = adj.dataset.adj;
      this.renderPanel();
      return;
    }
    const tool = t.closest('[data-tool]');
    if (tool) {
      this.tool = tool.dataset.tool;
      this.renderPanel();
      return;
    }
    const color = t.closest('[data-color]');
    if (color) {
      this.color = color.dataset.color;
      this.panel.querySelectorAll('.ed-color').forEach((b) => b.classList.toggle('on', b === color));
      return;
    }
    const btn = t.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const geo = this.st.geo;
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
        this.st.geo = im.defaultState().geo;
        this.commit();
        this.renderPanel();
        this.layout();
        break;
      case 'auto':
        if (this.st.auto) this.st.auto = null;
        else {
          const [fw, fh] = this.frame();
          const k = 400 / Math.max(fw, fh);
          const probe = im.renderBase(this.work, this.Ww, this.Hw, { ...im.defaultState(), geo: this.st.geo }, this.st.geo.crop,
            Math.max(1, this.st.geo.crop.w * fw * k), Math.max(1, this.st.geo.crop.h * fh * k), k);
          this.st.auto = im.autoLevels(probe.getContext('2d').getImageData(0, 0, probe.width, probe.height));
        }
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'reset-adj':
        this.st.adj = im.defaultState().adj;
        this.st.auto = null;
        this.commit();
        this.renderPanel();
        this.invalidate();
        break;
      case 'undo-stroke':
        this.st.strokes.pop();
        this.commit();
        this.renderPanel();
        this.requestPaint();
        break;
      case 'clear-strokes':
        this.st.strokes = [];
        this.commit();
        this.renderPanel();
        this.requestPaint();
        break;
      default:
    }
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

  /* ---------- 그리기 ---------- */

  toSource(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    const p = this.matrix.inverse().transformPoint(new DOMPoint(x, y));
    return [p.x / this.Ww, p.y / this.Hw];
  }

  bindDraw() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.tab !== 'draw' || !this.matrix || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      // 화면에서 보이는 굵기가 일정하도록 원본 기준 굵기로 환산
      const visible = (this.sizes[this.tool] / 400) * Math.max(c.width, c.height);
      const scale = Math.hypot(this.matrix.a, this.matrix.b);
      this.cur = {
        tool: this.tool,
        color: this.color,
        size: visible / (scale * Math.max(this.Ww, this.Hw)),
        pts: this.toSource(e),
      };
      this.requestPaint();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.cur) return;
      const [x, y] = this.toSource(e);
      const p = this.cur.pts;
      const lx = p[p.length - 2];
      const ly = p[p.length - 1];
      if (Math.abs(x - lx) + Math.abs(y - ly) < 0.0015) return;
      p.push(Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5);
      this.requestPaint();
    });
    const end = () => {
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
      const out = im.renderFull(src, W, H, this.st);
      src.close?.();
      const png = this.type === 'image/png';
      let canvas = out;
      if (!png) {
        canvas = im.makeCanvas(out.width, out.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(out, 0, 0);
      }
      const blob = await new Promise((res) => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.92));
      if (!blob) throw new Error('이미지를 만들지 못했어요');
      await this.onSave(blob, choice === 'copy');
    } catch (err) {
      console.error(err);
      toast(`저장하지 못했어요: ${err.message}`);
      this.setBusy('');
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
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey);
    document.body.classList.remove('editor-open');
    this.root.classList.remove('open');
    setTimeout(() => this.root.remove(), 200);
  }
}
