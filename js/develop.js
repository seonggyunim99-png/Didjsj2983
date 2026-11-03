// 보정 값 모델: 조정 항목, 필터(룩), 톤 커브, 자동 보정, 기하 변환(원근 포함), 잡티 제거
// 미리보기(축소본)와 저장(원본 해상도)이 같은 결과가 나오도록 모든 좌표·크기를 비율로 다룹니다.

import { removeArea } from './inpaint.js';

/* ---------- 조정 항목 ---------- */

export const ADJ = [
  { g: 'light', key: 'exposure', label: '노출', min: -100, max: 100, fmt: (v) => `${v > 0 ? '+' : ''}${(v / 50).toFixed(2)}` },
  { g: 'light', key: 'contrast', label: '대비' },
  { g: 'light', key: 'highlights', label: '하이라이트' },
  { g: 'light', key: 'shadows', label: '그림자' },
  { g: 'light', key: 'whites', label: '흰색 계열' },
  { g: 'light', key: 'blacks', label: '검정 계열' },
  { g: 'light', key: 'brightness', label: '밝기' },
  { g: 'color', key: 'temp', label: '색온도' },
  { g: 'color', key: 'tint', label: '색조' },
  { g: 'color', key: 'vibrance', label: '생동감' },
  { g: 'color', key: 'saturation', label: '채도' },
  { g: 'effects', key: 'clarity', label: '명료도' },
  { g: 'effects', key: 'texture', label: '텍스처' },
  { g: 'effects', key: 'dehaze', label: '안개 제거' },
  { g: 'effects', key: 'vignette', label: '비네팅' },
  { g: 'effects', key: 'grain', label: '그레인', min: 0 },
  { g: 'effects', key: 'fade', label: '페이드', min: 0 },
  { g: 'detail', key: 'sharpness', label: '선명하게', min: 0 },
  { g: 'detail', key: 'noise', label: '노이즈 감소', min: 0 },
  // 인물(뷰티): bg = 화면 묶음, face = 얼굴 인식이 있어야 쓸 수 있음
  { g: 'beauty', bg: 'skin', key: 'skinSmooth', label: '피부 보정', min: 0 },
  { g: 'beauty', bg: 'skin', key: 'skinTone', label: '화사하게', min: 0 },
  { g: 'beauty', bg: 'skin', key: 'darkCircle', label: '다크서클', min: 0, face: true },
  { g: 'beauty', bg: 'skin', key: 'blush', label: '볼 혈색', min: 0, face: true },
  { g: 'beauty', bg: 'shape', key: 'faceSlim', label: '얼굴 갸름하게', min: 0, face: true },
  { g: 'beauty', bg: 'shape', key: 'chin', label: '턱 길이', face: true },
  { g: 'beauty', bg: 'parts', key: 'eyes', label: '눈 크게', min: 0, face: true },
  { g: 'beauty', bg: 'parts', key: 'eyeBright', label: '눈 또렷하게', min: 0, face: true },
  { g: 'beauty', bg: 'parts', key: 'nose', label: '코 슬림', min: 0, face: true },
  { g: 'beauty', bg: 'parts', key: 'lips', label: '입술 혈색', min: 0, face: true },
  { g: 'beauty', bg: 'parts', key: 'teeth', label: '치아 미백', min: 0, face: true },
  { g: 'beauty', bg: 'makeup', key: 'mkLip', label: '립', min: 0, face: true, color: 'lip' },
  { g: 'beauty', bg: 'makeup', key: 'mkBlush', label: '블러셔', min: 0, face: true, color: 'blush' },
  { g: 'beauty', bg: 'makeup', key: 'mkShadow', label: '아이섀도', min: 0, face: true, color: 'shadow' },
  { g: 'beauty', bg: 'makeup', key: 'brow', label: '눈썹 진하게', min: 0, face: true },
  { g: 'beauty', bg: 'body', key: 'legs', label: '다리 길게', min: 0, pose: true },
  { g: 'beauty', bg: 'body', key: 'waist', label: '허리 가늘게', min: 0, pose: true },
  { g: 'beauty', bg: 'body', key: 'shoulder', label: '어깨 넓이', pose: true },
  { g: 'beauty', bg: 'bg', key: 'bgBlur', label: '배경 흐림', min: 0, seg: true },
  { g: 'beauty', bg: 'bg', key: 'bgLight', label: '배경 밝기', seg: true },
  { g: 'beauty', bg: 'bg', key: 'bgMono', label: '배경 흑백', min: 0, seg: true },
].map((a) => ({ min: -100, max: 100, ...a }));
export const ADJ_BY_KEY = Object.fromEntries(ADJ.map((a) => [a.key, a]));

export const GROUPS = [
  ['light', '빛'], ['color', '색상'], ['effects', '효과'], ['detail', '디테일'],
  ['curve', '톤 커브'], ['hsl', '색상별'], ['grading', '컬러 그레이딩'],
];

/** [키, 이름, 표시 색, 기준 색상(도)] */
export const HSL_BANDS = [
  ['red', '빨강', '#ef4444', 0], ['orange', '주황', '#f97316', 30], ['yellow', '노랑', '#eab308', 60],
  ['green', '초록', '#22c55e', 120], ['aqua', '하늘', '#06b6d4', 180], ['blue', '파랑', '#3b82f6', 240],
  ['purple', '보라', '#8b5cf6', 270], ['magenta', '자홍', '#d946ef', 300],
];

export const BEAUTY_GROUPS = [['skin', '피부'], ['shape', '얼굴형'], ['parts', '눈·코·입'], ['makeup', '메이크업'], ['body', '몸매'], ['bg', '배경']];
/** 얼굴마다 따로 정할 수 있는 값 */
export const FACE_KEYS = ADJ.filter((a) => a.face || ['skinSmooth', 'skinTone'].includes(a.key)).map((a) => a.key);

/** i번 얼굴에 쓸 값 (따로 정한 값이 있으면 그것, 없으면 공통 값) */
export function faceAdj(adj, st, i) {
  const own = st.faceAdj?.[i];
  return own ? { ...adj, ...own } : adj;
}

export const GRADE_RANGES = [['shadows', '그림자'], ['mids', '중간 톤'], ['highs', '하이라이트']];

const ident = () => [[0, 0], [1, 1]];

export function defaultState() {
  return {
    geo: { q: 0, flipH: false, flipV: false, angle: 0, pv: 0, ph: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' },
    adj: Object.fromEntries(ADJ.map((a) => [a.key, 0])),
    curve: { rgb: ident(), r: ident(), g: ident(), b: ident() },
    hsl: Object.fromEntries(HSL_BANDS.map(([k]) => [k, [0, 0, 0]])),
    grading: { shadows: [0, 0], mids: [0, 0], highs: [0, 0], balance: 0 },
    look: 'none',
    lookAmt: 1,
    enhance: { on: false, scene: 'auto', strength: 1, prev: null },
    heals: [],
    strokes: [],
    liquify: [], // 손으로 모양 다듬기 획 (retouch.js)
    local: [], // 부분 보정 브러시 획
    erase: [], // 보정 지우개 획 (화면 자리 기준)
    faceAdj: {}, // 얼굴별 따로 정한 값 { 얼굴 번호: { 키: 값 } }
    makeup: { lip: 'mlbb', blush: 'peach', shadow: 'brown' },
  };
}

const isIdentCurve = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
export const curveChanged = (curve) => Object.values(curve).some((p) => !isIdentCurve(p));
export const hslChanged = (hsl) => Object.values(hsl).some((v) => v.some((x) => x));
export const gradingChanged = (g) => g.shadows[1] || g.mids[1] || g.highs[1];

export function isEdited(st) {
  const g = st.geo;
  const c = g.crop;
  return Object.values(st.adj).some((v) => v) || curveChanged(st.curve) || hslChanged(st.hsl) || !!gradingChanged(st.grading)
    || (st.look !== 'none' && st.lookAmt > 0) || st.heals.length > 0 || st.strokes.length > 0
    || st.liquify?.length > 0 || st.local?.length > 0
    || Object.values(st.faceAdj || {}).some((o) => Object.values(o).some((v) => v))
    || g.q || g.flipH || g.flipV || g.angle || g.pv || g.ph
    || c.x > 1e-4 || c.y > 1e-4 || c.w < 0.9999 || c.h < 0.9999;
}

/* ---------- 톤 커브 (단조 3차 보간: 곡선이 뒤집히지 않음) ---------- */

export function curveFn(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return (x) => x;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/* ---------- 필터(룩): 커브 + 컬러 그레이딩 + 색상별 조정 + 그레인으로 만든 필름 느낌 ---------- */

export const LOOKS = [
  { id: 'none', name: '원본' },
  { id: 'clear', name: '맑음', adj: { vibrance: 18, clarity: 12, contrast: 8, whites: 10, dehaze: 6 } },
  { id: 'warm', name: '따뜻함', adj: { temp: 18, vibrance: 8 }, grading: { highs: [40, 15] } },
  { id: 'cool', name: '시원함', adj: { temp: -18, tint: -4 }, grading: { shadows: [210, 12] } },
  {
    id: 'film', name: '필름', adj: { saturation: -8, grain: 22 },
    curve: [[0, 0.06], [0.25, 0.23], [0.75, 0.79], [1, 0.95]], grading: { shadows: [190, 14], highs: [38, 16] },
  },
  {
    id: 'portra', name: '인물 필름', adj: { temp: 6, saturation: -10, vibrance: 6, contrast: -6, grain: 14 },
    curve: [[0, 0.04], [0.3, 0.3], [0.7, 0.73], [1, 0.96]], hsl: { orange: [0, -8, 8], red: [3, -8, 5] }, grading: { highs: [30, 10] },
  },
  {
    id: 'green', name: '초록 필름', adj: { contrast: 6, saturation: -6, grain: 16 },
    curve: [[0, 0.05], [0.25, 0.22], [0.75, 0.8], [1, 0.97]], hsl: { green: [-15, -12, -6], yellow: [-8, -10, 0], blue: [-6, -10, 0] },
    grading: { shadows: [165, 14], highs: [45, 8] },
  },
  {
    id: 'cinema', name: '시네마', adj: { contrast: 14, saturation: -10, fade: 6, highlights: -10 },
    curve: [[0, 0.03], [0.25, 0.2], [0.75, 0.82], [1, 0.97]], grading: { shadows: [195, 30], highs: [32, 26] },
  },
  {
    id: 'vintage', name: '빈티지', adj: { fade: 28, saturation: -22, temp: 12, grain: 30, vignette: -25, contrast: -8 },
    grading: { shadows: [28, 12], highs: [45, 12] },
  },
  {
    id: 'pastel', name: '파스텔', adj: { contrast: -22, highlights: -10, shadows: 22, saturation: -18, exposure: 8, fade: 16 },
    grading: { highs: [330, 10], shadows: [200, 8] },
  },
  { id: 'cafe', name: '카페', adj: { temp: 14, saturation: -14, contrast: -6, fade: 12 }, grading: { highs: [35, 18], shadows: [25, 10] } },
  {
    id: 'food', name: '음식', adj: { temp: 10, vibrance: 25, clarity: 10, highlights: -10, shadows: 10 },
    hsl: { red: [0, 10, 0], orange: [0, 12, 4], yellow: [0, 8, 4] },
  },
  { id: 'night', name: '야경', adj: { shadows: 20, highlights: -20, temp: -10, vibrance: 15, contrast: 10 }, grading: { shadows: [220, 20], highs: [30, 12] } },
  { id: 'mono', name: '흑백', adj: { saturation: -100, contrast: 12, clarity: 10 } },
  { id: 'noir', name: '느와르', adj: { saturation: -100, contrast: 40, blacks: -20, vignette: -30, grain: 18 } },
  { id: 'sepia', name: '세피아', adj: { saturation: -100, grain: 12, fade: 10 }, grading: { mids: [35, 30], shadows: [25, 18] } },
];

function hsv2rgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** 색상환 각도와 강도를 '밝기는 그대로인 색 더하기' 값으로 */
function gradeOffset([h, s], amt = 1) {
  if (!s) return [0, 0, 0];
  const c = hsv2rgb(h, 1, 1);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = (s / 100) * 0.4 * amt;
  return c.map((v) => (v - l) * k);
}

/** 사용자 조정 + 필터를 합쳐 렌더러가 쓸 최종 값으로 */
export function finalParams(st) {
  const look = LOOKS.find((l) => l.id === st.look) || LOOKS[0];
  const t = look.id === 'none' ? 0 : st.lookAmt;
  const adj = { ...st.adj };
  for (const [k, v] of Object.entries(look.adj || {})) adj[k] = (adj[k] || 0) + v * t;
  for (const a of ADJ) adj[a.key] = Math.max(a.min, Math.min(a.max, adj[a.key]));
  const hsl = HSL_BANDS.map(([k]) => {
    const u = st.hsl[k];
    const l = look.hsl?.[k] || [0, 0, 0];
    return [u[0] + l[0] * t, u[1] + l[1] * t, u[2] + l[2] * t].map((v) => Math.max(-100, Math.min(100, v)) / 100);
  });
  const grade = {};
  for (const [k] of GRADE_RANGES) {
    const u = gradeOffset(st.grading[k]);
    const l = look.grading?.[k] ? gradeOffset(look.grading[k], t) : [0, 0, 0];
    grade[k] = u.map((v, i) => v + l[i]);
  }
  // 커브: 사용자 커브(RGB → 채널별) 다음에 필터 커브를 강도만큼
  const fr = curveFn(st.curve.rgb);
  const fc = [curveFn(st.curve.r), curveFn(st.curve.g), curveFn(st.curve.b)];
  const fl = look.curve ? curveFn(look.curve) : null;
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = fr(i / 255);
    for (let c = 0; c < 3; c++) {
      let y = fc[c](Math.min(1, Math.max(0, x)));
      if (fl) y += (fl(Math.min(1, Math.max(0, y))) - y) * t;
      lut[i * 4 + c] = Math.round(Math.min(1, Math.max(0, y)) * 255);
    }
    lut[i * 4 + 3] = 255;
  }
  return { adj, hsl, grade, balance: st.grading.balance / 100, lut };
}

/* ---------- 자동 보정 v2 ---------- */

export const SCENES = [
  { id: 'auto', name: '자동', hint: '사진에 맞춰 알맞게' },
  { id: 'portrait', name: '인물', hint: '깨끗한 피부, 부드러운 톤' },
  { id: 'landscape', name: '풍경', hint: '선명한 하늘과 초록' },
  { id: 'food', name: '음식', hint: '따뜻하고 먹음직스럽게' },
  { id: 'night', name: '야경', hint: '어두운 곳은 밝게, 불빛은 살리고' },
  { id: 'hdr', name: 'HDR', hint: '밝은 곳과 어두운 곳을 모두 또렷하게' },
  { id: 'document', name: '문서', hint: '종이는 하얗게, 글씨는 또렷하게' },
];

const SCENE_MODS = {
  portrait: { skinSmooth: 30, skinTone: 18, clarity: -16, texture: -12, temp: 4, vibrance: -4, highlights: -8, sharpness: -10 },
  landscape: { vibrance: 18, clarity: 20, dehaze: 10, highlights: -15, shadows: 10, texture: 8 },
  food: { temp: 8, vibrance: 20, saturation: 4, clarity: 10, highlights: -10, shadows: 8 },
  night: { shadows: 25, highlights: -25, noise: 30, vibrance: 6, exposure: 10 },
  hdr: { shadows: 45, highlights: -55, clarity: 30, texture: 10, vibrance: 12, whites: 8, blacks: -8 },
  document: { saturation: -60, contrast: 30, whites: 45, blacks: -35, clarity: 15, sharpness: 40, shadows: 20 },
};

const lin = (v) => Math.max(0, v) ** 2.2;
const clampAdj = (k, v) => Math.round(Math.max(ADJ_BY_KEY[k].min, Math.min(ADJ_BY_KEY[k].max, v)));

/**
 * 사진 측정값(imaging.analyze)으로 최적 보정 값을 계산합니다. 결과는 조정 슬라이더 값 그대로라
 * 사용자가 하나씩 더 다듬을 수 있어요.
 */
export function autoAdjust(s, { strength = 1, scene = 'auto' } = {}) {
  const adj = Object.fromEntries(ADJ.map((a) => [a.key, 0]));
  const night = scene === 'night';
  // 1) 노출: 중간 밝기를 알맞게 (너무 어두우면 올리고, 너무 밝으면 조금 내림. 저녁 분위기는 살림)
  const p50 = Math.max(0.02, s.p50);
  let target = p50;
  if (night) target = p50 < 0.28 ? p50 + (0.32 - p50) * 0.6 : p50;
  else if (p50 < 0.36) target = p50 + (0.42 - p50) * 0.65;
  else if (p50 > 0.64) target = 0.64 + (p50 - 0.64) * 0.5;
  const ev = Math.max(-1, Math.min(1.3, Math.log2(lin(target) / Math.max(1e-5, lin(p50)))));
  adj.exposure = ev * 50;
  const gain = 2 ** ev;
  const after = (v) => Math.min(1, Math.min(1, lin(v) * gain) ** (1 / 2.2));
  const p01 = after(s.p01);
  const p05 = after(s.p05);
  const p95 = after(s.p95);
  const p99 = after(s.p99);
  // 2) 하이라이트 · 그림자 살리기
  const clip = Math.max(s.highClip, p99 > 0.985 ? 0.01 : 0);
  if (p99 > 0.95 || clip > 0.004) adj.highlights = -Math.min(65, 22 + clip * 700 + Math.max(0, ev) * 18);
  if (p05 < 0.14) adj.shadows = Math.min(55, (0.14 - p05) * 280 + 8);
  // 3) 흰색 · 검정 계열: 가장 밝은 곳과 어두운 곳을 제자리로
  adj.whites = Math.max(-30, Math.min(40, (0.965 - p99) * 200));
  adj.blacks = p01 > 0.05 ? -Math.min(45, (p01 - 0.03) * 260) : p01 < 0.005 && s.lowClip > 0.02 ? 10 : 0;
  // 4) 대비 · 안개
  const spread = p95 - p05;
  adj.contrast = spread < 0.55 ? Math.min(28, (0.55 - spread) * 70) : spread > 0.86 ? -8 : 4;
  if (s.p05 > 0.22 && s.p95 - s.p05 < 0.5) adj.dehaze = Math.min(45, (s.p05 - 0.18) * 160);
  // 5) 화이트 밸런스: 흰 벽·회색 길처럼 무채색이어야 할 부분이 회색이 되도록.
  //    무채색 부분이 없을 만큼 색이 크게 치우쳤으면 가장 밝은 부분(흰 접시·종이 등)도 함께 참고합니다.
  const E = estimateLight(s);
  if (E.e) {
    // 필요한 보정량 (log2 비율): T는 파랑/빨강, Ti는 초록/자홍
    let T = Math.log2(E.e[2] / E.e[0]);
    let Ti = Math.log2(E.e[1] / Math.sqrt(E.e[0] * E.e[2]));
    let k = scene === 'document' ? 1 : night ? 0.2 : 0.65 * E.conf;
    if (scene !== 'document') {
      k *= Math.min(1, Math.max(0.15, (p50 - 0.06) / 0.22)); // 저녁·밤은 조명 색이 분위기
      if (T < 0) k *= 0.8; // 따뜻한 조명은 좋아하는 분위기라 덜 바로잡음
    }
    if (Math.abs(T) < 0.12) T = 0;
    if (Math.abs(Ti) < 0.08) Ti = 0;
    // 두 축을 같은 비율로 바로잡아야 다른 색으로 넘어가지 않음
    adj.temp = Math.max(-90, Math.min(90, ((T * k) / WB_T) * 100));
    adj.tint = Math.max(-60, Math.min(60, ((Ti * k) / WB_TI) * 100));
  }
  // 6) 색감 · 디테일
  const rel = s.chroma / Math.max(0.15, s.mean);
  adj.vibrance = Math.max(6, Math.min(28, (0.32 - rel) * 90 + 8));
  adj.clarity = 10;
  adj.texture = 6;
  adj.sharpness = 20;

  for (const [k, v] of Object.entries(SCENE_MODS[scene] || {})) adj[k] += v;
  for (const k of Object.keys(adj)) adj[k] = clampAdj(k, adj[k] * strength);
  return { adj };
}

/** 사진을 비춘 빛의 색(선형 RGB)을 추정합니다. */
function estimateLight(s) {
  const ok = (v) => v && v.every((x) => x > 1e-4);
  const neutral = (s.nFrac || 0) > 0.03 ? [s.nR, s.nG, s.nB] : null;
  // 가장 밝은 부분(흰 컵·종이·구름)이 충분히 밝으면 조명 색의 좋은 단서
  const wp = s.wR && (s.wR + s.wG + s.wB) / 3 > 0.3 ? [s.wR, s.wG, s.wB] : null;
  const gw = [lin(s.mr ?? 0.5), lin(s.mg ?? 0.5), lin(s.mb ?? 0.5)];
  const gmix = (a, b, t) => a.map((v, i) => v ** (1 - t) * b[i] ** t);
  if (ok(neutral) && ok(wp)) return { e: gmix(neutral, wp, 0.5), conf: 1 };
  if (ok(neutral)) return { e: neutral, conf: 0.9 };
  if (ok(wp)) return { e: ok(gw) ? gmix(gw, wp, 0.85) : wp, conf: 0.9 };
  if (ok(gw)) return { e: gw, conf: 0.45 }; // 전체 평균만으로는 확신이 낮음
  return { e: null };
}

/** 슬라이더 끝(±100)에서의 보정 폭 (log2 비율): 파랑/빨강 약 3.5배, 초록/자홍 약 1.7배 */
const WB_T = 1.8;
const WB_TI = 0.8;

/** 색온도·색조 슬라이더 → 채널별 게인 (선형 공간, 밝기는 그대로) */
export function wbGains(temp, tint) {
  const T = (temp / 100) * WB_T;
  const Ti = (tint / 100) * WB_TI;
  // 색온도 +: 따뜻하게(빨강↑ 파랑↓), 색조 +: 자홍(초록↓)
  const g = [2 ** (0.5 * T + Ti / 3), 2 ** ((-2 * Ti) / 3), 2 ** (-0.5 * T + Ti / 3)];
  const n = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return g.map((v) => v / n);
}

/* ---------- 기하 변환 (3×3, 원근 포함) ---------- */

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const T = (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1];
const S = (x, y = x) => [x, 0, 0, 0, y, 0, 0, 0, 1];
const R = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

export function mapPoint(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export function frameDims(W, H, geo) {
  return geo.q % 2 ? [H, W] : [W, H];
}

export function coverScale(fw, fh, angleDeg) {
  const a = (Math.abs(angleDeg) * Math.PI) / 180;
  return Math.cos(a) + Math.max(fw / fh, fh / fw) * Math.sin(a);
}

export const FULL = { x: 0, y: 0, w: 1, h: 1 };

/** 원근 보정 후에도 빈 곳이 보이지 않도록 필요한 확대 배율 */
function perspectiveCover(core, W, H) {
  const back = inv3(core);
  const inside = (k) => [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]].every(([x, y]) => {
    const [sx, sy] = mapPoint(back, x / k, y / k);
    return sx >= -0.5 && sx <= W + 0.5 && sy >= -0.5 && sy <= H + 0.5;
  });
  let lo = 1;
  let hi = 4;
  if (inside(1)) return 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * 원본 이미지 좌표(픽셀) → 출력 좌표로 바꾸는 3×3 행렬 (원근 포함)
 * @param region 틀 기준 비율 영역 (자르기 영역 또는 전체)
 * @param outScale 틀 1픽셀이 출력에서 몇 픽셀인지
 */
export function geoMatrix3(W, H, geo, region, outScale) {
  const [fw, fh] = frameDims(W, H, geo);
  const s = coverScale(fw, fh, geo.angle);
  const A = mul(R(geo.angle), mul(S(s), mul(S(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1), mul(R(geo.q * 90), T(-W / 2, -H / 2)))));
  const a = ((geo.ph || 0) / 100) * 0.7;
  const b = ((geo.pv || 0) / 100) * 0.7;
  const core = mul([1, 0, 0, 0, 1, 0, a, b, 1], mul(S(1 / fw, 1 / fh), A));
  const k = a || b ? perspectiveCover(core, W, H) : 1;
  const O = mul(S(outScale), mul(T(-region.x * fw, -region.y * fh), mul(T(fw / 2, fh / 2), S(fw * k, fh * k))));
  return mul(O, core);
}

/** 행렬이 대략 몇 배로 늘리는지 (펜 굵기 계산용) */
export function matrixScale(m, x, y) {
  const [ax, ay] = mapPoint(m, x, y);
  const [bx, by] = mapPoint(m, x + 1, y);
  return Math.hypot(bx - ax, by - ay);
}

/* ---------- 잡티 제거 (주변의 깨끗한 피부를 찾아 자연스럽게 메우기) ---------- */

function ringStats(d, w, h, cx, cy, r0, r1) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  const step = Math.max(1, Math.round(r1 / 12));
  for (let y = Math.max(0, Math.floor(cy - r1)); y <= Math.min(h - 1, Math.ceil(cy + r1)); y += step) {
    for (let x = Math.max(0, Math.floor(cx - r1)); x <= Math.min(w - 1, Math.ceil(cx + r1)); x += step) {
      const dd = Math.hypot(x - cx, y - cy);
      if (dd < r0 || dd > r1) continue;
      const i = (y * w + x) * 4;
      s0 += d[i];
      s1 += d[i + 1];
      s2 += d[i + 2];
      n++;
    }
  }
  return n ? [s0 / n, s1 / n, s2 / n] : null;
}

/** 잡티 위치(cx, cy, 반지름 r 픽셀)에 붙일 가장 알맞은 주변 영역의 위치 차이를 찾습니다. */
export function findHealOffset(img, cx, cy, r) {
  const { data: d, width: w, height: h } = img;
  const step = Math.max(1, Math.round(r / 6));
  const sample = (ox, oy, rad, fn) => {
    for (let y = -rad; y <= rad; y += step) {
      for (let x = -rad; x <= rad; x += step) {
        const dd = Math.hypot(x, y);
        if (dd > rad) continue;
        fn(x, y, dd);
      }
    }
  };
  let best = null;
  for (const dist of [2.3, 3.1, 4.1]) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * dist * r);
      const dy = Math.round(Math.sin(ang) * dist * r);
      const sx = cx + dx;
      const sy = cy + dy;
      if (sx - r * 1.4 < 0 || sy - r * 1.4 < 0 || sx + r * 1.4 >= w || sy + r * 1.4 >= h) continue;
      // 1) 테두리(잡티 바깥 피부)가 얼마나 비슷한지
      let cost = 0;
      let n = 0;
      sample(0, 0, Math.round(r * 1.35), (x, y, dd) => {
        if (dd < r) return;
        const ti = ((Math.round(cy + y)) * w + Math.round(cx + x)) * 4;
        const si = ((Math.round(sy + y)) * w + Math.round(sx + x)) * 4;
        if (ti < 0 || ti >= d.length) return;
        for (let c = 0; c < 3; c++) {
          const e = d[ti + c] - d[si + c];
          cost += e * e;
        }
        n++;
      });
      // 2) 가져올 영역 안쪽이 고르게 깨끗한지 (또 다른 잡티를 옮겨오지 않게)
      let m = 0;
      let m2 = 0;
      let k2 = 0;
      sample(0, 0, Math.round(r), (x, y) => {
        const si = ((Math.round(sy + y)) * w + Math.round(sx + x)) * 4;
        const L = d[si] * 0.3 + d[si + 1] * 0.59 + d[si + 2] * 0.11;
        m += L;
        m2 += L * L;
        k2++;
      });
      const variance = k2 ? m2 / k2 - (m / k2) ** 2 : 0;
      const score = (n ? cost / n : 1e9) + variance * 6 + dist * 20;
      if (!best || score < best.score) best = { score, dx, dy };
    }
  }
  return best ? [best.dx, best.dy] : [Math.round(r * 2.5), 0];
}

/** 잡티 한 곳을 메웁니다 (캔버스 픽셀을 직접 고침) */
export function applyHeal(ctx, W, H, cx, cy, r, dx, dy) {
  const R2 = Math.ceil(r * 1.3);
  const x0 = Math.max(0, Math.floor(cx - R2));
  const y0 = Math.max(0, Math.floor(cy - R2));
  const x1 = Math.min(W, Math.ceil(cx + R2) + 1);
  const y1 = Math.min(H, Math.ceil(cy + R2) + 1);
  if (x1 <= x0 || y1 <= y0) return;
  const sx0 = x0 + dx;
  const sy0 = y0 + dy;
  if (sx0 < 0 || sy0 < 0 || sx0 + (x1 - x0) > W || sy0 + (y1 - y0) > H) return;
  const tgt = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const src = ctx.getImageData(sx0, sy0, x1 - x0, y1 - y0);
  const w = x1 - x0;
  const lcx = cx - x0;
  const lcy = cy - y0;
  // 주변 피부색 차이만큼 맞춰서 경계가 티 나지 않게
  const ringT = ringStats(tgt.data, w, y1 - y0, lcx, lcy, r * 1.0, r * 1.3);
  const ringS = ringStats(src.data, w, y1 - y0, lcx, lcy, r * 1.0, r * 1.3);
  const shift = ringT && ringS ? ringT.map((v, i) => v - ringS[i]) : [0, 0, 0];
  const td = tgt.data;
  const sd = src.data;
  for (let y = 0; y < y1 - y0; y++) {
    for (let x = 0; x < w; x++) {
      const dd = Math.hypot(x - lcx, y - lcy);
      if (dd > R2) continue;
      const t = Math.min(1, Math.max(0, (dd - r * 0.75) / (r * 0.5)));
      const a = 1 - t * t * (3 - 2 * t);
      if (a <= 0) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) td[i + c] = td[i + c] * (1 - a) + (sd[i + c] + shift[c]) * a;
    }
  }
  ctx.putImageData(tgt, x0, y0);
}

/** 저장해 둔 잡티 제거(비율 좌표)를 원하는 해상도의 캔버스에 다시 적용 */
/**
 * 잡티 제거 · 사물 지우기를 순서대로 다시 적용합니다.
 * @param fillLimit 사물 지우기 계산 영역의 긴 변 (저장할 때는 크게)
 */
export function applyHeals(canvas, heals, fillLimit = 520) {
  if (!heals.length) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const u = Math.max(W, H);
  for (const h of heals) {
    if (h.t === 'fill') removeArea(canvas, h, fillLimit);
    else applyHeal(ctx, W, H, h.x * W, h.y * H, h.r * u, Math.round(h.dx * W), Math.round(h.dy * H));
  }
}
