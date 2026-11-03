// 사진 편집 엔진: 자르기·회전 등 기하 변환, 색 보정, 필터, 그리기·모자이크
// 미리보기(축소본)와 저장(원본 해상도)이 같은 계산을 쓰도록 모든 좌표를 비율로 다룹니다.

export const ADJUSTMENTS = [
  { key: 'brightness', label: '밝기', min: -100, max: 100 },
  { key: 'exposure', label: '노출', min: -100, max: 100 },
  { key: 'contrast', label: '대비', min: -100, max: 100 },
  { key: 'highlights', label: '하이라이트', min: -100, max: 100 },
  { key: 'shadows', label: '그림자', min: -100, max: 100 },
  { key: 'saturation', label: '채도', min: -100, max: 100 },
  { key: 'warmth', label: '색온도', min: -100, max: 100 },
  { key: 'tint', label: '색조', min: -100, max: 100 },
  { key: 'sharpness', label: '선명도', min: 0, max: 100 },
  { key: 'vignette', label: '비네팅', min: 0, max: 100 },
  { key: 'fade', label: '페이드', min: 0, max: 100 },
];

export function defaultState() {
  return {
    geo: { q: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' },
    adj: Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])),
    auto: null,
    filter: 'none',
    filterAmt: 1,
    strokes: [],
  };
}

/* ---------- 색상 행렬 (3x4, 오프셋은 0~255 단위) ---------- */

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(A, B) {
  // B를 먼저 적용하고 A를 적용
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
    r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
  }
  return r;
}
const chain = (...ms) => ms.reduce((acc, m) => mul(m, acc), I);
const sat = (s) => {
  const lr = 0.2126 * (1 - s);
  const lg = 0.7152 * (1 - s);
  const lb = 0.0722 * (1 - s);
  return [lr + s, lg, lb, 0, lr, lg + s, lb, 0, lr, lg, lb + s, 0];
};
const contrast = (c) => {
  const o = 128 * (1 - c);
  return [c, 0, 0, o, 0, c, 0, o, 0, 0, c, o];
};
const bright = (o) => [1, 0, 0, o, 0, 1, 0, o, 0, 0, 1, o];
const scale = (r, g, b, or = 0, og = 0, ob = 0) => [r, 0, 0, or, 0, g, 0, og, 0, 0, b, ob];
const SEPIA = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];
const mix = (A, t) => A.map((v, i) => I[i] + (v - I[i]) * t);

export const FILTERS = [
  { id: 'none', name: '원본', m: I },
  { id: 'vivid', name: '선명', m: chain(sat(1.35), contrast(1.1)) },
  { id: 'warm', name: '따뜻함', m: chain(scale(1.08, 1.01, 0.88), sat(1.08)) },
  { id: 'cool', name: '시원함', m: chain(scale(0.9, 1, 1.1), sat(1.02)) },
  { id: 'fresh', name: '청량', m: chain(scale(0.97, 1.03, 1.07, 0, 4, 8), sat(1.15), bright(6)) },
  { id: 'sunset', name: '노을', m: chain(scale(1.12, 0.98, 0.84, 10, 2, 0), contrast(1.05)) },
  { id: 'pastel', name: '파스텔', m: chain(sat(0.72), contrast(0.85), bright(18)) },
  { id: 'film', name: '필름', m: chain(contrast(0.9), scale(1.03, 1, 0.94, 10, 8, 14), sat(0.88)) },
  { id: 'vintage', name: '빈티지', m: chain(mix(SEPIA, 0.45), contrast(0.9), bright(12)) },
  { id: 'drama', name: '드라마', m: chain(contrast(1.3), sat(0.78)) },
  { id: 'mono', name: '흑백', m: sat(0) },
  { id: 'noir', name: '느와르', m: chain(sat(0), contrast(1.4), bright(-6)) },
  { id: 'sepia', name: '세피아', m: SEPIA },
];

export function filterMatrix(id, amount) {
  const f = FILTERS.find((x) => x.id === id);
  if (!f || f.id === 'none' || !amount) return null;
  return mix(f.m, amount);
}

/* ---------- 캔버스 ---------- */

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/* ---------- 기하 변환 ---------- */

/** 90도 회전을 반영한 '틀'의 크기 */
export function frameDims(W, H, geo) {
  return geo.q % 2 ? [H, W] : [W, H];
}

/** 기울기 보정 시 빈 모서리가 생기지 않도록 확대하는 배율 */
export function coverScale(fw, fh, angleDeg) {
  const a = (Math.abs(angleDeg) * Math.PI) / 180;
  return Math.cos(a) + Math.max(fw / fh, fh / fw) * Math.sin(a);
}

export const FULL = { x: 0, y: 0, w: 1, h: 1 };

/**
 * 원본 이미지 좌표(픽셀) → 출력 캔버스 좌표로 바꾸는 행렬
 * @param region 틀 기준 비율 영역(자르기 영역 또는 전체)
 * @param outScale 틀 1픽셀이 출력에서 몇 픽셀인지
 */
export function geoMatrix(W, H, geo, region, outScale) {
  const [fw, fh] = frameDims(W, H, geo);
  return new DOMMatrix()
    .scale(outScale, outScale)
    .translate(-region.x * fw, -region.y * fh)
    .translate(fw / 2, fh / 2)
    .rotate(geo.angle)
    .scale(coverScale(fw, fh, geo.angle))
    .scale(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1)
    .rotate(geo.q * 90)
    .translate(-W / 2, -H / 2);
}

/* ---------- 색 보정 ---------- */

function isNeutral(st) {
  return !st.auto && st.filter === 'none' && Object.values(st.adj).every((v) => !v);
}

export function applyAdjust(img, st) {
  const a = st.adj;
  const d = img.data;
  const w = img.width;
  const h = img.height;

  // 1) 레벨(자동 보정) → 노출 → 밝기(감마) → 대비 : 채널별 표로 미리 계산
  const lut = new Float32Array(256);
  const lv = st.auto;
  const ex = 2 ** ((a.exposure / 100) * 1.3);
  const b = a.brightness / 100;
  const gamma = b >= 0 ? 1 / (1 + b * 0.9) : 1 - b * 0.9;
  const ct = a.contrast >= 0 ? 1 + (a.contrast / 100) * 0.8 : 1 + (a.contrast / 100) * 0.65;
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    if (lv) {
      x = Math.min(1, Math.max(0, (x - lv.lo) / (lv.hi - lv.lo)));
      x **= lv.gamma;
    }
    x = Math.min(1.5, x * ex);
    if (gamma !== 1) x = x <= 0 ? 0 : x ** gamma;
    lut[v] = (x * 255 - 128) * ct + 128;
  }

  const hl = a.highlights / 100;
  const sh = a.shadows / 100;
  const sa = (1 + a.saturation / 100) * (lv ? 1.1 : 1);
  const wa = a.warmth / 100;
  const ti = a.tint / 100;
  const fade = a.fade / 100;
  const vig = a.vignette / 100;
  const M = filterMatrix(st.filter, st.filterAmt);

  let vx = null;
  let vy = null;
  if (vig) {
    vx = new Float32Array(w);
    vy = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      const t = ((x + 0.5) / w) * 2 - 1;
      vx[x] = t * t;
    }
    for (let y = 0; y < h; y++) {
      const t = ((y + 0.5) / h) * 2 - 1;
      vy[y] = t * t;
    }
  }

  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let r = lut[d[i]];
      let g = lut[d[i + 1]];
      let bl = lut[d[i + 2]];
      if (hl || sh) {
        let L = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
        L = L < 0 ? 0 : L > 1 ? 1 : L;
        const s1 = 1 - L;
        const delta = (sh * 0.38 * s1 * s1 + hl * 0.38 * L * L) * 255;
        r += delta;
        g += delta;
        bl += delta;
      }
      if (sa !== 1) {
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = L + (r - L) * sa;
        g = L + (g - L) * sa;
        bl = L + (bl - L) * sa;
      }
      if (wa) {
        r += wa * 24;
        bl -= wa * 24;
      }
      if (ti) {
        g -= ti * 20;
        r += ti * 6;
        bl += ti * 6;
      }
      if (M) {
        const r2 = M[0] * r + M[1] * g + M[2] * bl + M[3];
        const g2 = M[4] * r + M[5] * g + M[6] * bl + M[7];
        const b2 = M[8] * r + M[9] * g + M[10] * bl + M[11];
        r = r2;
        g = g2;
        bl = b2;
      }
      if (fade) {
        const k = 1 - fade * 0.28;
        const o = fade * 34;
        r = r * k + o;
        g = g * k + o;
        bl = bl * k + o;
      }
      if (vig) {
        const dd = vx[x] + vy[y];
        const t = Math.min(1, Math.max(0, (dd - 0.35) / 1.3));
        const f = 1 - vig * 0.75 * t * t * (3 - 2 * t);
        r *= f;
        g *= f;
        bl *= f;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = bl;
    }
  }
}

export function sharpen(img, amount) {
  const k = amount * 0.8;
  if (!k) return;
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  const row = w * 4;
  const c = 1 + 4 * k;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let ch = 0; ch < 3; ch++) {
        const j = i + ch;
        d[j] = src[j] * c - k * (src[j - 4] + src[j + 4] + src[j - row] + src[j + row]);
      }
    }
  }
}

/** 자동 보정: 어두운 끝·밝은 끝을 펴고 중간 밝기를 맞춥니다. */
export function autoLevels(img) {
  const d = img.data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    n++;
  }
  const pick = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n * p) return v / 255;
    }
    return 1;
  };
  let lo = pick(0.006);
  let hi = pick(0.994);
  const med = pick(0.5);
  lo = Math.min(lo, 0.25);
  hi = Math.max(hi, 0.75);
  if (hi - lo < 0.2) return { lo: 0, hi: 1, gamma: 1 };
  const m = Math.min(0.95, Math.max(0.05, (med - lo) / (hi - lo)));
  const gamma = Math.min(1.5, Math.max(0.65, Math.log(0.48) / Math.log(m)));
  return { lo, hi, gamma };
}

/* ---------- 그리기 · 모자이크 ---------- */

function tracePath(ctx, s, W, H) {
  const p = s.pts;
  ctx.beginPath();
  ctx.moveTo(p[0] * W, p[1] * H);
  if (p.length === 2) ctx.lineTo(p[0] * W + 0.01, p[1] * H + 0.01);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
}

/**
 * @param ctx 출력 캔버스
 * @param base 보정까지 끝난 이미지(모자이크 재료)
 * @param strokes 원본 이미지 기준 비율 좌표의 획 목록
 * @param matrix 원본 → 출력 변환 행렬
 */
export function drawOverlays(ctx, base, strokes, matrix, W, H) {
  if (!strokes.length) return;
  const outW = ctx.canvas.width;
  const outH = ctx.canvas.height;
  const unit = Math.max(W, H);

  const mosaic = strokes.filter((s) => s.tool === 'mosaic');
  if (mosaic.length) {
    const block = Math.max(4, Math.round(Math.max(outW, outH) / 42));
    const sw = Math.ceil(outW / block);
    const sh = Math.ceil(outH / block);
    const small = makeCanvas(sw, sh);
    small.getContext('2d').drawImage(base, 0, 0, sw, sh);
    const pix = makeCanvas(outW, outH);
    const pc = pix.getContext('2d');
    pc.imageSmoothingEnabled = false;
    pc.drawImage(small, 0, 0, sw * block, sh * block);
    pc.globalCompositeOperation = 'destination-in';
    pc.setTransform(matrix);
    pc.lineCap = 'round';
    pc.lineJoin = 'round';
    pc.strokeStyle = '#000';
    for (const s of mosaic) {
      pc.lineWidth = s.size * unit;
      tracePath(pc, s, W, H);
      pc.stroke();
    }
    ctx.drawImage(pix, 0, 0);
  }

  ctx.save();
  ctx.setTransform(matrix);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.tool === 'mosaic') continue;
    ctx.globalAlpha = s.tool === 'marker' ? 0.42 : 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size * unit;
    tracePath(ctx, s, W, H);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- 렌더링 ---------- */

/** 기하 변환 + 색 보정까지 적용한 캔버스 */
export function renderBase(src, W, H, st, region, outW, outH, outScale) {
  const c = makeCanvas(outW, outH);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(geoMatrix(W, H, st.geo, region, outScale));
  ctx.drawImage(src, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!isNeutral(st)) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    applyAdjust(img, st);
    if (st.adj.sharpness) sharpen(img, st.adj.sharpness / 100);
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/** 저장용: 원본 해상도로 모든 편집을 적용 (브라우저 한계를 넘지 않게 최대 픽셀 제한) */
export function renderFull(src, W, H, st, maxPixels = 16_000_000) {
  const [fw, fh] = frameDims(W, H, st.geo);
  const cw = st.geo.crop.w * fw;
  const ch = st.geo.crop.h * fh;
  const k = cw * ch > maxPixels ? Math.sqrt(maxPixels / (cw * ch)) : 1;
  const outW = Math.max(1, Math.round(cw * k));
  const outH = Math.max(1, Math.round(ch * k));
  const base = renderBase(src, W, H, st, st.geo.crop, outW, outH, k);
  if (!st.strokes.length) return base;
  const out = makeCanvas(outW, outH);
  const ctx = out.getContext('2d');
  ctx.drawImage(base, 0, 0);
  drawOverlays(ctx, base, st.strokes, geoMatrix(W, H, st.geo, st.geo.crop, k), W, H);
  return out;
}

export function isEdited(st) {
  const g = st.geo;
  const c = g.crop;
  return !isNeutral(st) || st.strokes.length > 0 || g.q || g.flipH || g.flipV || g.angle
    || c.x > 1e-4 || c.y > 1e-4 || c.w < 0.9999 || c.h < 0.9999;
}
