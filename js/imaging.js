// 사진 편집 엔진: 자르기·회전 등 기하 변환, 색 보정, 필터, 그리기·모자이크
// 미리보기(축소본)와 저장(원본 해상도)이 같은 계산을 쓰도록 모든 좌표를 비율로 다룹니다.

export const ADJUSTMENTS = [
  { key: 'brightness', label: '밝기', min: -100, max: 100 },
  { key: 'exposure', label: '노출', min: -100, max: 100 },
  { key: 'contrast', label: '대비', min: -100, max: 100 },
  { key: 'highlights', label: '하이라이트', min: -100, max: 100 },
  { key: 'shadows', label: '그림자', min: -100, max: 100 },
  { key: 'saturation', label: '채도', min: -100, max: 100 },
  { key: 'vibrance', label: '생동감', min: -100, max: 100 },
  { key: 'warmth', label: '색온도', min: -100, max: 100 },
  { key: 'tint', label: '색조', min: -100, max: 100 },
  { key: 'clarity', label: '명료도', min: -100, max: 100 },
  { key: 'sharpness', label: '선명도', min: 0, max: 100 },
  { key: 'vignette', label: '비네팅', min: 0, max: 100 },
  { key: 'fade', label: '페이드', min: 0, max: 100 },
];

export function defaultState() {
  return {
    geo: { q: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' },
    adj: Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])),
    auto: null,
    enhance: { on: false, scene: 'auto', strength: 1, prev: null },
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

  // 1) 화이트밸런스(자동) → 레벨(자동) → 노출 → 밝기(감마) → 대비 : 채널별 표로 미리 계산
  const lv = st.auto;
  const gains = lv?.wb || [1, 1, 1];
  const luts = gains.map(() => new Float32Array(256));
  const ex = 2 ** ((a.exposure / 100) * 1.3);
  const b = a.brightness / 100;
  const gamma = b >= 0 ? 1 / (1 + b * 0.9) : 1 - b * 0.9;
  const ct = a.contrast >= 0 ? 1 + (a.contrast / 100) * 0.8 : 1 + (a.contrast / 100) * 0.65;
  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) {
      let x = Math.min(1, (v / 255) * gains[c]);
      if (lv) {
        x = Math.min(1, Math.max(0, (x - lv.lo) / (lv.hi - lv.lo)));
        x **= lv.gamma;
      }
      x = Math.min(1.5, x * ex);
      if (gamma !== 1) x = x <= 0 ? 0 : x ** gamma;
      luts[c][v] = (x * 255 - 128) * ct + 128;
    }
  }
  const [lutR, lutG, lutB] = luts;

  const hl = a.highlights / 100;
  const sh = a.shadows / 100;
  const sa = (1 + a.saturation / 100) * (lv?.sat ?? 1);
  const vb = (a.vibrance || 0) / 100;
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
      let r = lutR[d[i]];
      let g = lutG[d[i + 1]];
      let bl = lutB[d[i + 2]];
      if (hl || sh) {
        let L = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
        L = L < 0 ? 0 : L > 1 ? 1 : L;
        const s1 = 1 - L;
        const delta = (sh * 0.38 * s1 * s1 + hl * 0.38 * L * L) * 255;
        r += delta;
        g += delta;
        bl += delta;
      }
      if (sa !== 1 || vb) {
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        let f = sa;
        if (vb) {
          // 생동감: 색이 옅은 부분은 많이, 이미 진한 부분은 조금만
          const mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
          const mn = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl);
          const c = Math.min(1, Math.max(0, (mx - mn) / 255));
          f *= vb > 0 ? 1 + vb * (1 - c) * 1.2 : 1 + vb;
        }
        r = L + (r - L) * f;
        g = L + (g - L) * f;
        bl = L + (bl - L) * f;
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

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / div;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / div;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** 명료도: 넓은 범위의 명암 대비(디테일)를 살리거나(+) 부드럽게(-) 합니다. */
export function clarity(img, amount) {
  if (!amount) return;
  const { width: w, height: h, data: d } = img;
  const F = 4;
  const sw = Math.max(1, Math.ceil(w / F));
  const sh = Math.max(1, Math.ceil(h / F));
  const sum = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = ((y / F) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = sy + ((x / F) | 0);
      sum[j] += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      cnt[j]++;
    }
  }
  for (let j = 0; j < sum.length; j++) sum[j] /= cnt[j] || 1;
  const r = Math.max(1, Math.round(Math.min(sw, sh) / 28));
  const blur = boxBlur(boxBlur(sum, sw, sh, r), sw, sh, r);
  const k = amount * 0.9;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, y / F - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, x / F - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const b = (blur[y0 * sw + x0] * (1 - tx) + blur[y0 * sw + x1] * tx) * (1 - ty)
        + (blur[y1 * sw + x0] * (1 - tx) + blur[y1 * sw + x1] * tx) * ty;
      const i = (y * w + x) * 4;
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const m = 2 * (L / 255) - 1;
      const delta = k * (L - b) * (1 - m * m);
      d[i] += delta;
      d[i + 1] += delta;
      d[i + 2] += delta;
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

/* ---------- 사진 분석 · 자동 보정 ---------- */

/** 밝기 분포, 색 치우침, 채도, 선명함(초점)을 측정합니다. 값은 0~1 기준 */
export function analyze(img) {
  const { data: d, width: w, height: h } = img;
  const n = w * h;
  const hist = new Uint32Array(256);
  const gray = new Float32Array(n);
  let lum = 0;
  let chroma = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let mid = 0;
  // 무채색에 가까운 부분(흰 벽, 회색 길, 구름 등)의 색 평균: 자동 화이트밸런스용 (선형 값)
  let nr = 0;
  let ng = 0;
  let nb = 0;
  let nn = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gray[p] = L;
    hist[Math.min(255, Math.round(L))]++;
    lum += L;
    chroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (L > 40 && L < 215) {
      sr += r;
      sg += g;
      sb += b;
      mid++;
      if (Math.max(r, g, b) - Math.min(r, g, b) < 0.16 * Math.max(r, g, b) + 6) {
        nr += (r / 255) ** 2.2;
        ng += (g / 255) ** 2.2;
        nb += (b / 255) ** 2.2;
        nn++;
      }
    }
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n * q) return v / 255;
    }
    return 1;
  };
  // 가장 밝은 3% (날아간 부분 제외)의 색 평균: 색이 크게 치우친 사진의 화이트밸런스용
  const wpT = pct(0.97) * 255;
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wn = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (gray[p] >= wpT && Math.max(d[i], d[i + 1], d[i + 2]) < 250) {
      wr += (d[i] / 255) ** 2.2;
      wg += (d[i + 1] / 255) ** 2.2;
      wb += (d[i + 2] / 255) ** 2.2;
      wn++;
    }
  }
  let low = 0;
  let high = 0;
  for (let v = 0; v < 10; v++) low += hist[v];
  for (let v = 246; v < 256; v++) high += hist[v];
  // 라플라시안 분산: 값이 작을수록 흐릿한 사진
  let ls = 0;
  let ls2 = 0;
  let lc = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const v = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
      ls += v;
      ls2 += v * v;
      lc++;
    }
  }
  const lm = lc ? ls / lc : 0;
  return {
    mean: lum / n / 255,
    p01: pct(0.01),
    p05: pct(0.05),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    lowClip: low / n,
    highClip: high / n,
    chroma: chroma / n,
    castRB: mid ? (sr - sb) / mid / 255 : 0,
    castG: mid ? (sg - (sr + sb) / 2) / mid / 255 : 0,
    mr: mid ? sr / mid / 255 : 0.5,
    mg: mid ? sg / mid / 255 : 0.5,
    mb: mid ? sb / mid / 255 : 0.5,
    nR: nn ? nr / nn : 0,
    nG: nn ? ng / nn : 0,
    nB: nn ? nb / nn : 0,
    nFrac: nn / n,
    wR: wn ? wr / wn : 0,
    wG: wn ? wg / wn : 0,
    wB: wn ? wb / wn : 0,
    sharp: lc ? ls2 / lc - lm * lm : 0,
  };
}

/**
 * 64비트 차이 해시(dHash): 비슷한 사진 찾기용.
 * 잔무늬에 흔들리지 않도록 72×64로 줄인 뒤 8×8 칸씩 평균을 내서 9×8 밝기 표를 만듭니다.
 */
export function dhash(source) {
  const c = makeCanvas(72, 64);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, 72, 64);
  const d = ctx.getImageData(0, 0, 72, 64).data;
  const cell = new Float32Array(72);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 72; x++) {
      const i = (y * 72 + x) * 4;
      cell[((y >> 3) * 9) + ((x / 8) | 0)] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
  }
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (cell[y * 9 + x] > cell[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export const STATS_VERSION = 3;

/** 썸네일로 사진 상태를 측정합니다 (보정 추천·정리 도우미용). */
export async function statsFromBlob(blob) {
  const src = await decode(blob);
  const [W, H] = dimsOf(src);
  const k = 160 / Math.max(W, H);
  const c = makeCanvas(W * k, H * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const st = analyze(ctx.getImageData(0, 0, c.width, c.height));
  st.ph = dhash(c);
  st.v = STATS_VERSION;
  src.close?.();
  for (const key of Object.keys(st)) if (typeof st[key] === 'number') st[key] = Math.round(st[key] * 10000) / 10000;
  return st;
}

export const SCENES = [
  { id: 'auto', name: '자동', hint: '사진에 맞춰 알맞게' },
  { id: 'portrait', name: '인물', hint: '부드러운 피부 톤' },
  { id: 'landscape', name: '풍경', hint: '선명한 하늘과 초록' },
  { id: 'food', name: '음식', hint: '따뜻하고 먹음직스럽게' },
  { id: 'night', name: '야경', hint: '어두운 곳은 밝게, 불빛은 살리고' },
  { id: 'hdr', name: 'HDR', hint: '밝은 곳과 어두운 곳을 모두 또렷하게' },
  { id: 'document', name: '문서', hint: '종이는 하얗게, 글씨는 또렷하게' },
];

const ADJ_RANGE = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, [a.min, a.max]]));

/**
 * 측정값으로 '최적 보정' 값을 계산합니다. 결과는 조정 슬라이더 값이라 사용자가 그대로 더 다듬을 수 있어요.
 * @param s analyze() 결과
 * @param opts.strength 0~1.5 (1이 기본)
 * @param opts.scene SCENES의 id
 */
export function autoAdjust(s, { strength = 1, scene = 'auto' } = {}) {
  const adj = Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0]));
  const doc = scene === 'document';
  // 1) 레벨: 가장 어두운 곳은 검게, 가장 밝은 곳은 희게
  //    물 빠진 듯 밝게 뜬 사진은 검은 기준점을 더 과감하게 잡아요.
  let lo = Math.max(0, Math.min(s.p05 > 0.3 ? 0.45 : 0.12, s.p01 - 0.01));
  let hi = Math.max(0.55, Math.min(1, s.p99 + 0.01));
  if (doc) {
    lo = Math.min(0.35, s.p05);
    hi = Math.max(0.55, Math.min(0.92, s.p50 + 0.12));
  }
  if (hi - lo < 0.2) {
    lo = 0;
    hi = 1;
  }
  const stretch = (v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  // 2) 중간 밝기: 원래 밝기를 존중하되, 너무 어두우면 밝게·너무 밝으면 조금 어둡게
  const p50 = s.p50;
  let desired = p50;
  if (scene === 'night') desired = p50 < 0.3 ? p50 + (0.34 - p50) * 0.6 : p50;
  else if (p50 < 0.38) desired = p50 + (0.42 - p50) * 0.7;
  else if (p50 > 0.62) desired = 0.62 + (p50 - 0.62) * 0.6;
  const mid = Math.min(0.97, Math.max(0.03, stretch(p50)));
  desired = Math.min(0.95, Math.max(0.05, desired));
  const gamma = Math.min(1.7, Math.max(0.55, Math.log(desired) / Math.log(mid)));
  adj.brightness = Math.max(-60, Math.min(60, (gamma < 1 ? (1 / gamma - 1) / 0.9 : -(gamma - 1) / 0.9) * 100));
  // 3) 그림자·하이라이트 살리기
  adj.shadows = Math.min(45, Math.max(0, (s.lowClip - 0.04) * 260 + (stretch(s.p05) < 0.06 ? 8 : 0)));
  adj.highlights = -Math.min(45, Math.max(0, (s.highClip - 0.03) * 260 + (stretch(s.p95) > 0.97 ? 8 : 0)));
  // 4) 대비 (레벨로 이미 넓혔다면 조금만)
  const spread = stretch(s.p95) - stretch(s.p05);
  adj.contrast = spread < 0.6 ? Math.min(15, (0.6 - spread) * 45) : spread > 0.93 ? -6 : 0;
  // 5) 화이트 밸런스: 중간 밝기 영역의 색 평균으로 채널별 게인을 계산.
  //    자연스러운 범위(초록 숲, 파란 하늘 등)는 그대로 두고, 크게 치우친 만큼만 바로잡아요.
  const castMag = Math.max(Math.abs(s.castRB), Math.abs(s.castG));
  const k = doc ? 0.9 : scene === 'night' ? 0.15 * Math.min(1, castMag / 0.2) : 0.75 * Math.min(1, Math.max(0, (castMag - 0.07) / 0.2));
  let wb = [1, 1, 1];
  if (k > 0 && s.mr && s.mg && s.mb) {
    const gray = (s.mr + s.mg + s.mb) / 3;
    wb = [s.mr, s.mg, s.mb].map((m) => Math.min(1.6, Math.max(0.6, (gray / m) ** k)));
  }
  // 6) 색감: 색이 옅으면 생동감을 조금 더해요
  //    (밝기 범위를 넓히면 색도 함께 진해지므로, 그만큼은 아래 auto.sat으로 덜어 냅니다)
  const rel = s.chroma / Math.max(0.15, s.mean);
  adj.vibrance = Math.min(18, Math.max(4, (0.3 - rel) * 80 + 4));
  adj.clarity = 8;
  adj.sharpness = 12;

  const mods = {
    portrait: { warmth: 6, clarity: -20, vibrance: -6, highlights: -8, sharpness: -12, brightness: 4 },
    landscape: { vibrance: 18, clarity: 22, contrast: 8, highlights: -12, shadows: 8 },
    food: { warmth: 10, vibrance: 18, brightness: 5, clarity: 8 },
    night: { shadows: 28, highlights: -28, brightness: 6, vibrance: 8, sharpness: -6 },
    hdr: { shadows: 38, highlights: -45, clarity: 32, vibrance: 12, contrast: -6 },
    document: { contrast: 22, saturation: -55, sharpness: 38, clarity: 12, vibrance: -6, shadows: -10 },
  }[scene];
  if (mods) for (const [k, v] of Object.entries(mods)) adj[k] += v;

  for (const k of Object.keys(adj)) {
    const [mn, mx] = ADJ_RANGE[k];
    adj[k] = Math.round(Math.max(mn, Math.min(mx, adj[k] * strength)));
  }
  const t = Math.min(1, strength);
  const lo2 = lo * t;
  const hi2 = 1 - (1 - hi) * t;
  const g2 = 1 / (hi2 - lo2);
  return {
    auto: {
      lo: lo2,
      hi: hi2,
      gamma: 1,
      wb: wb.map((x) => 1 + (x - 1) * t),
      sat: g2 > 1 ? (1 + (g2 - 1) * 0.35) / g2 : 1,
    },
    adj,
  };
}

/* ---------- 디코딩 ---------- */

export async function decode(blob) {
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

export const dimsOf = (src) => [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height];

export function canvasToBlob(canvas, type, quality = 0.95) {
  const png = type === 'image/png';
  let c = canvas;
  if (!png) {
    c = makeCanvas(canvas.width, canvas.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했어요'))), png ? 'image/png' : 'image/jpeg', quality));
}

/** 사진 한 장을 자동 보정한 새 파일을 만듭니다 (여러 장 한꺼번에 보정할 때 사용). */
export async function autoEnhanceBlob(blob, type, opts) {
  const src = await decode(blob);
  try {
    const [W, H] = dimsOf(src);
    const k = Math.min(1, 320 / Math.max(W, H));
    const probe = makeCanvas(W * k, H * k);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(src, 0, 0, probe.width, probe.height);
    const { auto, adj } = autoAdjust(analyze(pctx.getImageData(0, 0, probe.width, probe.height)), opts);
    const st = { ...defaultState(), auto, adj };
    return await canvasToBlob(renderFull(src, W, H, st), type);
  } finally {
    src.close?.();
  }
}

/** 썸네일 크기 미리보기용 자동 보정 */
export function previewEnhance(source, opts) {
  const [W, H] = dimsOf(source);
  const k = Math.min(1, 240 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const probe = makeCanvas(w, h);
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(source, 0, 0, w, h);
  const { auto, adj } = autoAdjust(analyze(pctx.getImageData(0, 0, w, h)), opts);
  return renderBase(probe, w, h, { ...defaultState(), auto, adj }, FULL, w, h, 1);
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
    if (st.adj.clarity) clarity(img, st.adj.clarity / 100);
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
