// 콜라주 만들기: 사진 2~9장을 한 장으로 배치합니다.
import * as im from './imaging.js';
import { icon, toast, openModal } from './ui.js';

const RATIOS = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '9:16': 9 / 16, '16:9': 16 / 9 };
const BACKGROUNDS = ['#ffffff', '#111111', '#e9e6df', '#f6d6dc', '#d5e8f7', '#d8efe2', '#2f3a56'];
const OUT_LONG = 2048;

const rows = (counts) => counts.flatMap((c, r) => Array.from({ length: c }, (_, i) => ({ x: i / c, y: r / counts.length, w: 1 / c, h: 1 / counts.length })));
const cols = (counts) => rows(counts).map(({ x, y, w, h }) => ({ x: y, y: x, w: h, h: w }));
const bigLeft = (n) => [{ x: 0, y: 0, w: 0.5, h: 1 }, ...Array.from({ length: n - 1 }, (_, i) => ({ x: 0.5, y: i / (n - 1), w: 0.5, h: 1 / (n - 1) }))];
const bigTop = (n) => [{ x: 0, y: 0, w: 1, h: 0.6 }, ...Array.from({ length: n - 1 }, (_, i) => ({ x: i / (n - 1), y: 0.6, w: 1 / (n - 1), h: 0.4 }))];

function spread(n, parts) {
  const base = Math.floor(n / parts);
  const extra = n % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

export function layoutsFor(n) {
  const r = Math.ceil(n / Math.ceil(Math.sqrt(n)));
  const list = [rows(spread(n, r)), cols(spread(n, r))];
  if (n >= 3) list.push(bigLeft(n), bigTop(n));
  if (n <= 4) list.push(rows(Array(n).fill(1)), cols(Array(n).fill(1)));
  if (n >= 5) list.push(rows(spread(n, r).reverse()));
  const seen = new Set();
  return list.filter((l) => {
    const key = JSON.stringify(l.map((c) => [c.x, c.y, c.w, c.h].map((v) => v.toFixed(3))));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function drawCover(ctx, src, x, y, w, h) {
  const sw = src.width;
  const sh = src.height;
  const k = Math.max(w / sw, h / sh);
  const cw = w / k;
  const ch = h / k;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

export function renderCollage(canvas, sources, opts) {
  const { layout, gap, radius, bg } = opts;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const g = (gap / 400) * Math.min(W, H);
  const rad = (radius / 400) * Math.min(W, H);
  layout.forEach((cell, i) => {
    const src = sources[i];
    if (!src) return;
    const x = g + cell.x * (W - g);
    const y = g + cell.y * (H - g);
    const w = cell.w * (W - g) - g;
    const h = cell.h * (H - g) - g;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.beginPath();
    if (rad && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(rad, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
    ctx.clip();
    drawCover(ctx, src, x, y, w, h);
    ctx.restore();
  });
}

/**
 * @param {{items:{id:string, blob?:Blob}[], loadBlob:(id:string)=>Promise<Blob>, onSave:(blob:Blob)=>Promise<void>}} opts
 */
export async function openCollage({ items, loadBlob, onSave }) {
  const n = items.length;
  const layouts = layoutsFor(n);
  const state = { layout: 0, ratio: '1:1', gap: 12, radius: 10, bg: BACKGROUNDS[0] };
  let sources = [];

  const mini = (l) => `<span class="mini-layout">${l.map((c) => `<i style="left:${c.x * 100}%;top:${c.y * 100}%;width:${c.w * 100}%;height:${c.h * 100}%"></i>`).join('')}</span>`;
  const modal = openModal({
    className: 'collage',
    dismissible: false,
    html: `
      <header class="ed-top">
        <button type="button" class="ed-icon" data-act="close" aria-label="닫기">${icon('close')}</button>
        <strong class="collage-title">콜라주 · ${n}장</strong>
        <button type="button" class="btn primary sm" data-act="save" disabled>저장</button>
      </header>
      <div class="collage-stage"><canvas class="collage-canvas"></canvas><div class="ed-busy"><i></i><span>사진 불러오는 중…</span></div></div>
      <div class="collage-panel">
        <div class="ed-chips">${layouts.map((l, i) => `<button type="button" class="layout-btn${i === 0 ? ' on' : ''}" data-layout="${i}" aria-label="배치 ${i + 1}">${mini(l)}</button>`).join('')}</div>
        <div class="ed-chips">${Object.keys(RATIOS).map((r) => `<button type="button" class="ed-chip${r === state.ratio ? ' on' : ''}" data-ratio="${r}">${r}</button>`).join('')}
          <button type="button" class="ed-chip" data-act="shuffle">${icon('restore')}순서 섞기</button></div>
        <div class="ed-slider-row"><span class="ed-slider-label">간격</span><input type="range" min="0" max="40" value="${state.gap}" data-k="gap"><output>${state.gap}</output></div>
        <div class="ed-slider-row"><span class="ed-slider-label">모서리</span><input type="range" min="0" max="40" value="${state.radius}" data-k="radius"><output>${state.radius}</output></div>
        <div class="ed-colors">${BACKGROUNDS.map((c) => `<button type="button" class="ed-color${c === state.bg ? ' on' : ''}" data-bg="${c}" style="--c:${c}" aria-label="배경 ${c}"></button>`).join('')}</div>
      </div>`,
  });
  const el = modal.el;
  const canvas = el.querySelector('.collage-canvas');
  const stage = el.querySelector('.collage-stage');

  const paintSlider = (r) => {
    const pct = ((+r.value - +r.min) / (+r.max - +r.min)) * 100;
    r.style.background = `linear-gradient(to right, var(--ed-fill) ${pct}%, var(--ed-track) ${pct}%)`;
  };
  el.querySelectorAll('input[type=range]').forEach(paintSlider);

  function draw() {
    if (!sources.length) return;
    const ratio = RATIOS[state.ratio];
    const sw = stage.clientWidth - 24;
    const sh = stage.clientHeight - 24;
    const cssW = Math.min(sw, sh * ratio);
    const cssH = cssW / ratio;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    renderCollage(canvas, sources, { ...state, layout: layouts[state.layout] });
  }

  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  const close = () => {
    window.removeEventListener('resize', onResize);
    sources.forEach((s) => s.close?.());
    modal.close();
  };

  el.addEventListener('input', (e) => {
    const r = e.target.closest('input[type=range]');
    if (!r) return;
    state[r.dataset.k] = +r.value;
    r.parentElement.querySelector('output').textContent = r.value;
    paintSlider(r);
    draw();
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const lay = t.closest('[data-layout]');
    if (lay) {
      state.layout = +lay.dataset.layout;
      el.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', b === lay));
      return draw();
    }
    const ratio = t.closest('[data-ratio]');
    if (ratio) {
      state.ratio = ratio.dataset.ratio;
      el.querySelectorAll('[data-ratio]').forEach((b) => b.classList.toggle('on', b === ratio));
      return draw();
    }
    const bg = t.closest('[data-bg]');
    if (bg) {
      state.bg = bg.dataset.bg;
      el.querySelectorAll('[data-bg]').forEach((b) => b.classList.toggle('on', b === bg));
      return draw();
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    else if (act === 'shuffle') {
      for (let i = sources.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sources[i], sources[j]] = [sources[j], sources[i]];
      }
      draw();
    } else if (act === 'save') {
      const btn = t.closest('[data-act]');
      btn.disabled = true;
      el.classList.add('busy');
      el.querySelector('.ed-busy span').textContent = '저장하는 중…';
      try {
        const ratio = RATIOS[state.ratio];
        const out = im.makeCanvas(ratio >= 1 ? OUT_LONG : OUT_LONG * ratio, ratio >= 1 ? OUT_LONG / ratio : OUT_LONG);
        renderCollage(out, sources, { ...state, layout: layouts[state.layout] });
        const blob = await im.canvasToBlob(out, 'image/jpeg');
        await onSave(blob);
        close();
      } catch (err) {
        toast(`콜라주를 저장하지 못했어요: ${err.message}`);
        btn.disabled = false;
        el.classList.remove('busy');
      }
    }
  });

  // 사진 불러오기 (각 사진을 최대 1600px로 줄여서 사용)
  el.classList.add('busy');
  try {
    for (const it of items) {
      const src = await im.decode(it.blob || (await loadBlob(it.id)));
      const [W, H] = im.dimsOf(src);
      const k = Math.min(1, 1600 / Math.max(W, H));
      const c = im.makeCanvas(W * k, H * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      src.close?.();
      sources.push(c);
    }
  } catch {
    toast('일부 사진을 열 수 없어 콜라주를 만들 수 없어요');
    close();
    return;
  }
  el.classList.remove('busy');
  el.querySelector('[data-act="save"]').disabled = false;
  requestAnimationFrame(draw);
}
