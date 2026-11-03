// 얼굴 인식과 뷰티 보정용 계산: 눈·코·입·턱선 위치(MediaPipe, 기기 안에서만 처리),
// 얼굴형 다듬기(변형)와 부위별 영역(피부·입술·치아·눈밑·볼·눈) 만들기

const VENDOR = new URL('../vendor/mediapipe/', import.meta.url).href;

/* ---------- 얼굴 주요 지점 번호 (MediaPipe 얼굴 메시) ---------- */

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LIPS_OUT = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_IN = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const BROW_R = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];
const BROW_L = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300];
const JAW_R = [132, 58, 172, 136, 150, 149];
const JAW_L = [361, 288, 397, 365, 379, 378];

let vision = null;
const tasks = {};

function visionBase() {
  if (!vision) {
    vision = (async () => {
      const mod = await import(`${VENDOR}vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${VENDOR}wasm`);
      return { mod, fileset };
    })().catch((err) => {
      vision = null;
      throw err;
    });
  }
  return vision;
}

/** 인식기를 한 번만 불러옵니다 (처음 한 번만 내려받고 이후에는 저장된 것을 씀) */
function task(name, make) {
  if (!tasks[name]) {
    tasks[name] = visionBase().then(({ mod, fileset }) => make(mod, fileset)).catch((err) => {
      delete tasks[name];
      throw err;
    });
  }
  return tasks[name];
}

const landmarker = () => task('face', (m, fs) => m.FaceLandmarker.createFromOptions(fs, {
  baseOptions: { modelAssetPath: `${VENDOR}face_landmarker.task`, delegate: 'CPU' },
  runningMode: 'IMAGE',
  numFaces: 6,
}));
const poser = () => task('pose', (m, fs) => m.PoseLandmarker.createFromOptions(fs, {
  baseOptions: { modelAssetPath: `${VENDOR}pose_landmarker_lite.task`, delegate: 'CPU' },
  runningMode: 'IMAGE',
  numPoses: 4,
}));
const segmenter = () => task('seg', (m, fs) => m.ImageSegmenter.createFromOptions(fs, {
  baseOptions: { modelAssetPath: `${VENDOR}selfie_multiclass_256x256.tflite`, delegate: 'CPU' },
  runningMode: 'IMAGE',
  outputCategoryMask: false,
  outputConfidenceMasks: true,
}));

/**
 * 사진 속 얼굴들의 주요 지점을 찾습니다. 왼쪽 얼굴부터 1번, 2번… 순서
 * @returns {Promise<number[][][]>} 얼굴마다 [x, y] (0~1 비율) 478개
 */
export async function detectFaces(source) {
  const lm = await landmarker();
  const res = lm.detect(source);
  return (res.faceLandmarks || [])
    .filter((f) => f.length >= 468)
    .map((f) => f.map((p) => [p.x, p.y]))
    .sort((a, b) => a[1][0] - b[1][0]);
}

/**
 * 사람 몸의 주요 지점 (어깨·골반·무릎·발목 등 33개)
 * @returns {Promise<number[][][]>} 사람마다 [x, y, 보이는 정도]
 */
export async function detectPoses(source) {
  const lm = await poser();
  const res = lm.detect(source);
  return (res.landmarks || []).map((pts) => pts.map((p) => [p.x, p.y, p.visibility ?? 1]));
}

/**
 * 사람 영역 (배경 흐림용). 256px 결과를 사진 경계에 맞춰 다듬어 돌려줍니다.
 * @returns {Promise<{w:number, h:number, data:Uint8Array}|null>} 0 배경 ~ 255 사람
 */
export async function segmentPerson(source, W, H) {
  const sg = await segmenter();
  const res = sg.segment(source);
  const masks = res.confidenceMasks || [];
  if (!masks.length) return null;
  const bgMask = masks[0];
  const mw = bgMask.width;
  const mh = bgMask.height;
  const bgv = bgMask.getAsFloat32Array();
  const person = new Float32Array(mw * mh);
  let any = 0;
  for (let i = 0; i < person.length; i++) {
    person[i] = 1 - bgv[i];
    any += person[i] > 0.5 ? 1 : 0;
  }
  masks.forEach((m) => m.close());
  res.close?.();
  if (any < person.length * 0.005) return null;
  // 사진 경계(머리카락 등)에 맞춰 다듬기: 가이드 필터
  const k = Math.min(1, 768 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h).data;
  const I = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) I[i] = (0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2]) / 255;
  const P = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1.001, Math.max(0, ((y + 0.5) / h) * mh - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1.001, Math.max(0, ((x + 0.5) / w) * mw - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const i0 = y0 * mw + x0;
      const a = person[i0] + (person[i0 + 1] - person[i0]) * tx;
      const b2 = person[i0 + mw] + (person[i0 + mw + 1] - person[i0 + mw]) * tx;
      P[y * w + x] = a + (b2 - a) * ty;
    }
  }
  const q = guidedFilter(I, P, w, h, Math.max(2, Math.round(Math.max(w, h) / 90)), 0.002);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // 경계를 조금 또렷하게
    const v = Math.min(1, Math.max(0, (q[i] - 0.5) * 1.6 + 0.5));
    data[i] = Math.round(v * 255);
  }
  return { w, h, data };
}

function boxFilter(src, w, h, r) {
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s;
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  const n = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** 가이드 필터 (He et al.): 거친 영역 P를 사진 I의 경계에 맞춰 다듬음 */
function guidedFilter(I, P, w, h, r, eps) {
  const n = w * h;
  const II = new Float32Array(n);
  const IP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    IP[i] = I[i] * P[i];
  }
  const mI = boxFilter(I, w, h, r);
  const mP = boxFilter(P, w, h, r);
  const mII = boxFilter(II, w, h, r);
  const mIP = boxFilter(IP, w, h, r);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    const cv = mIP[i] - mI[i] * mP[i];
    A[i] = cv / (v + eps);
    B[i] = mP[i] - A[i] * mI[i];
  }
  const mA = boxFilter(A, w, h, r);
  const mB = boxFilter(B, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
  return q;
}

/* ---------- 도우미 ---------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const mean = (pts) => mul(pts.reduce((s, p) => add(s, p), [0, 0]), 1 / pts.length);

/** 비율 좌표 → 긴 변 기준 좌표 (가로세로 비율이 달라도 원이 원으로 남게) */
function toUnit(face, W, H) {
  const M = Math.max(W, H);
  return face.map(([x, y]) => [(x * W) / M, (y * H) / M]);
}

function geometry(P) {
  const eyeR = mean(EYE_R.map((i) => P[i]));
  const eyeL = mean(EYE_L.map((i) => P[i]));
  const faceW = len(sub(P[454], P[234]));
  const down = norm(sub(P[152], P[168]));
  return { eyeR, eyeL, faceW, faceH: len(sub(P[152], P[10])), down, center: mean(FACE_OVAL.map((i) => P[i])) };
}

/* ---------- 얼굴형 다듬기 (변형) ---------- */

export const WARP_MAX = 64;

/**
 * 뷰티·몸매 슬라이더 값으로 변형 목록을 만듭니다. 좌표·반지름은 긴 변 기준 단위.
 * @param adjFor 얼굴 번호 → 그 얼굴에 쓸 값 (얼굴별 따로 보정)
 * @param poses 몸 지점 (없으면 null), body 몸매 값 { legs, waist, shoulder }
 * @returns {{a:Float32Array, b:Float32Array, n:number, leg:object|null}}
 *   a = [x, y, 반지름, 종류(0 확대, 1 밀기)], b = [밀기 x, y, 확대 세기, 0], leg = 다리 길게(세로 늘리기)
 */
export function buildWarps(faces, adjFor, W, H, poses = null, body = {}, max = WARP_MAX) {
  const a = new Float32Array(max * 4);
  const b = new Float32Array(max * 4);
  let n = 0;
  const push = (x, y, r, type, vx, vy, s) => {
    if (n >= max) return;
    a.set([x, y, r, type], n * 4);
    b.set([vx, vy, s, 0], n * 4);
    n++;
  };
  // 겹치는 밀기 여러 개를 합쳐도 목표 거리만큼만 움직이도록 크기를 맞춤
  const group = (list, target) => {
    const k = (i, j) => {
      const t = len(sub(list[i].c, list[j].c)) / list[j].r;
      return t < 1 ? (1 - t * t) ** 2 : 0;
    };
    let sum = 0;
    list.forEach((_, i) => list.forEach((__, j) => { sum += k(i, j); }));
    const f = target / Math.max(1, sum / list.length);
    for (const g of list) push(g.c[0], g.c[1], g.r, 1, g.v[0] * f, g.v[1] * f, 0);
  };
  (faces || []).forEach((face, fi) => {
    const adj = adjFor(fi);
    const P = toUnit(face, W, H);
    const g = geometry(P);
    // 눈 크게: 눈동자 중심 기준, 최대 약 8% 확대 (앱 기본값 수준은 2~4%)
    if (adj.eyes > 0) {
      for (const [eye, pts] of [[P[468] || g.eyeR, EYE_R], [P[473] || g.eyeL, EYE_L]]) {
        const w = len(sub(P[pts[0]], P[pts[8]]));
        push(eye[0], eye[1], w * 1.05, 0, 0, 0, (adj.eyes / 100) * 0.09);
      }
    }
    // 얼굴 갸름하게: 볼 아래~턱선만 안쪽으로, 최대 한쪽 3.5% (광대·이마는 그대로)
    // 중심을 얼굴 안쪽으로 조금 옮겨서 배경이 덜 휘게 함
    if (adj.faceSlim > 0) {
      for (const side of [JAW_R, JAW_L]) {
        const list = side.filter((_, i) => i % 2 === 0).map((i) => {
          const dir = norm(sub(g.center, P[i]));
          return { c: add(P[i], mul(dir, g.faceW * 0.05)), r: g.faceW * 0.2, v: dir };
        });
        group(list, (adj.faceSlim / 100) * g.faceW * 0.035);
      }
    }
    // 턱 길이: 턱끝만 위아래로, 최대 얼굴 길이의 2.5% (입은 거의 움직이지 않게 반지름을 작게)
    if (adj.chin) {
      const v = mul(g.down, (adj.chin / 100) * g.faceH * 0.025);
      const c = add(P[152], mul(g.down, -g.faceH * 0.02));
      push(c[0], c[1], g.faceW * 0.2, 1, v[0], v[1], 0);
    }
    // 코 슬림: 콧방울을 안쪽으로, 최대 코 폭의 6%
    if (adj.nose > 0) {
      const tip = P[4];
      const nw = len(sub(P[358], P[129]));
      for (const i of [129, 358]) group([{ c: P[i], r: nw * 0.45, v: norm(sub(tip, P[i])) }], (adj.nose / 100) * nw * 0.06);
    }
  });

  // 몸매 (자세 인식이 있을 때)
  let leg = null;
  const M = Math.max(W, H);
  const seen = (p) => p && p[2] > 0.5;
  const bodies = (poses || []).map((pose) => ({ raw: pose, P: pose.map(([x, y, v]) => [(x * W) / M, (y * H) / M, v]) }));
  for (const { P } of bodies) {
    const sh = [P[11], P[12]];
    const hp = [P[23], P[24]];
    if (!sh.every(seen) || !hp.every(seen)) continue;
    const shoulderW = len(sub(sh[0], sh[1]));
    const hipW = len(sub(hp[0], hp[1]));
    const mid = mean([...sh, ...hp]);
    // 허리 가늘게: 허리선 양옆을 몸 안쪽으로, 최대 한쪽 허리 폭의 약 7%
    if (body.waist > 0) {
      for (const [s, h] of [[sh[0], hp[0]], [sh[1], hp[1]]]) {
        const torso = len(sub(s, h));
        const w0 = add(h, mul(sub(s, h), 0.3));
        const out = norm([w0[0] - mid[0], 0]);
        const edge = add(w0, mul(out, hipW * 0.4));
        const list = [-0.12, 0, 0.12].map((t) => ({ c: add(edge, [0, t * torso]), r: hipW * 0.55, v: mul(out, -1) }));
        group(list, (body.waist / 100) * hipW * 0.08);
      }
    }
    // 어깨 넓이: 어깨 끝을 바깥(+)·안쪽(−)으로, 최대 어깨 폭의 3.5%
    if (body.shoulder) {
      for (const s of sh) {
        const out = norm([s[0] - mid[0], 0]);
        const edge = add(s, mul(out, shoulderW * 0.12));
        group([{ c: edge, r: shoulderW * 0.32, v: out }], (body.shoulder / 100) * shoulderW * 0.035);
      }
    }
  }
  // 다리 길게: 골반~발목 구간만 세로로 늘리고, 머리 위·발 아래 여백을 그만큼 줄여 사진 크기는 그대로
  if (body.legs > 0) {
    let y0 = Infinity;
    let y1 = -Infinity;
    let top = Infinity;
    for (const { raw } of bodies) {
      const px = (i) => [raw[i][0] * W, raw[i][1] * H, raw[i][2]];
      const hp = [px(23), px(24)];
      const kn = [px(25), px(26)];
      const an = [px(27), px(28)];
      if (!hp.every(seen) || !kn.some(seen)) continue;
      y0 = Math.min(y0, Math.max(hp[0][1], hp[1][1]));
      y1 = Math.max(y1, an.some(seen) ? Math.min(H, Math.max(...an.filter(seen).map((p) => p[1])) + H * 0.02) : H);
      const nose = px(0);
      const shY = (px(11)[1] + px(12)[1]) / 2;
      top = Math.min(top, seen(nose) ? Math.max(0, nose[1] - (shY - nose[1]) * 1.1) : 0);
    }
    if (Number.isFinite(y0) && y1 - y0 > H * 0.1) {
      const L = y1 - y0;
      let extra = (body.legs / 100) * 0.1 * L;
      const B = H - y1;
      const T = Math.max(0, Math.min(top, y0));
      extra = Math.min(extra, 0.6 * B + 0.6 * T);
      if (extra > 0.5) {
        const eb = Math.min(extra, 0.6 * B);
        const et = extra - eb;
        leg = { T, y0, y1, H, o1: T - et, o2: y0 - et, o3: y0 - et + L + extra };
      }
    }
  }
  return { a, b, n, leg };
}

/** 다리 길게: 화면 y → 원본 y (구간별 직선) */
export function legMap(leg, y) {
  if (!leg) return y;
  const { T, y0, y1, H, o1, o2, o3 } = leg;
  if (y < o1) return o1 > 0 ? (y * T) / o1 : y;
  if (y < o2) return T + (y - o1);
  if (y < o3) return y0 + ((y - o2) * (y1 - y0)) / (o3 - o2);
  return H - o3 > 0 ? y1 + ((y - o3) * (H - y1)) / (H - o3) : y;
}

/* ---------- 부위별 영역 ---------- */

function poly(ctx, P, idx, W, H) {
  ctx.beginPath();
  idx.forEach((i, k) => {
    const [x, y] = P[i];
    if (k) ctx.lineTo(x * W, y * H);
    else ctx.moveTo(x * W, y * H);
  });
  ctx.closePath();
}

function ellipse(ctx, cx, cy, rx, ry, rot) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), rot, 0, Math.PI * 2);
}

/** 한 채널을 상자 흐림 세 번 (가우스와 비슷한 부드러운 경계) */
function blurChannel(src, W, H, r) {
  r = Math.max(1, Math.round(r));
  let a = Float32Array.from(src);
  let b = new Float32Array(W * H);
  const pass = (from, to, n, m, stride, step) => {
    // n줄 × 길이 m, 줄 사이 간격 stride, 줄 안 간격 step
    const norm = 1 / (2 * r + 1);
    for (let line = 0; line < n; line++) {
      const o = line * stride;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += from[o + Math.min(m - 1, Math.max(0, k)) * step];
      for (let i = 0; i < m; i++) {
        to[o + i * step] = sum * norm;
        sum += from[o + Math.min(m - 1, i + r + 1) * step] - from[o + Math.max(0, i - r) * step];
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(a, b, H, W, W, 1);
    pass(b, a, W, H, 1, W);
  }
  return a;
}

/** 흰색으로 도형을 그린 뒤 경계를 r 픽셀만큼 부드럽게 */
function layer(W, H, r, draw) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  draw(ctx);
  const d = ctx.getImageData(0, 0, W, H).data;
  const ch = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) ch[i] = d[i * 4 + 3];
  return blurChannel(ch, W, H, r);
}

/**
 * 얼굴 부위 영역 두 장 (W×H, 원본 비율 좌표 기준)
 * mask1: R 얼굴 피부, G 입술, B 치아(입 안), A 눈밑
 * mask2: R 볼, G 눈, B 아이섀도, A 눈썹
 * mask3: R 얼굴 번호
 */
export function buildMasks(faces, W, H) {
  const M = Math.max(W, H);
  const geo = faces.map((f) => {
    const P = toUnit(f, W, H);
    return { f, P, g: geometry(P) };
  });
  // 경계 흐림 정도는 얼굴 크기 기준 (여러 명이면 가장 큰 얼굴)
  const fw = Math.max(...geo.map(({ g }) => g.faceW)) * M;
  const each = (fn) => (ctx) => geo.forEach((x) => fn(ctx, x));
  const rot = (g) => Math.atan2(-g.down[0], g.down[1]);
  const skin = layer(W, H, fw * 0.025, each((ctx, { f }) => {
    poly(ctx, f, FACE_OVAL, W, H);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(2, fw * 0.03);
    ctx.lineJoin = 'round';
    for (const idx of [EYE_R, EYE_L, BROW_R, BROW_L, LIPS_OUT]) {
      poly(ctx, f, idx, W, H);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }));
  const lips = layer(W, H, fw * 0.006, each((ctx, { f }) => {
    poly(ctx, f, LIPS_OUT, W, H);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    poly(ctx, f, LIPS_IN, W, H);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }));
  const teeth = layer(W, H, fw * 0.004, each((ctx, { f }) => {
    poly(ctx, f, LIPS_IN, W, H);
    ctx.fill();
  }));
  // 눈밑: 아래 눈꺼풀 아래쪽 반달 영역
  const under = layer(W, H, fw * 0.035, each((ctx, { f, P, g }) => {
    for (const [lid, a, b2] of [[145, 33, 133], [374, 263, 362]]) {
      const ew = len(sub(P[a], P[b2])) * M;
      const c = add([f[lid][0] * W, f[lid][1] * H], mul(g.down, ew * 0.4));
      ellipse(ctx, c[0], c[1], ew * 0.5, ew * 0.2, rot(g));
      ctx.fill();
    }
  }));
  const cheeks = layer(W, H, fw * 0.06, each((ctx, { f, g }) => {
    for (const i of [50, 280]) {
      ellipse(ctx, f[i][0] * W, f[i][1] * H, g.faceW * M * 0.09, g.faceW * M * 0.065, rot(g));
      ctx.fill();
    }
  }));
  const eyes = layer(W, H, fw * 0.005, each((ctx, { f }) => {
    for (const idx of [EYE_R, EYE_L]) {
      poly(ctx, f, idx, W, H);
      ctx.fill();
    }
  }));
  // 넓게 흐린 영역은 가운데가 꽉 차도록 다시 맞춤
  for (const ch of [under, cheeks]) {
    let mx = 0;
    for (let i = 0; i < ch.length; i++) if (ch[i] > mx) mx = ch[i];
    if (mx > 0) for (let i = 0; i < ch.length; i++) ch[i] *= 255 / mx;
  }
  // 아이섀도: 윗눈꺼풀 위쪽 (눈 자체는 빼고)
  const shadow = layer(W, H, fw * 0.012, each((ctx, { f }) => {
    for (const [lid, eye, brow] of [[[33, 246, 161, 160, 159, 158, 157, 173, 133], EYE_R, BROW_R], [[263, 466, 388, 387, 386, 385, 384, 398, 362], EYE_L, BROW_L]]) {
      const ec = mean(eye.map((i) => [f[i][0] * W, f[i][1] * H]));
      const bc = mean(brow.map((i) => [f[i][0] * W, f[i][1] * H]));
      const up = mul(sub(bc, ec), 0.42);
      const pts = lid.map((i) => [f[i][0] * W, f[i][1] * H]);
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      [...pts].reverse().forEach(([x, y]) => ctx.lineTo(x + up[0], y + up[1]));
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      poly(ctx, f, eye, W, H);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }));
  const brows = layer(W, H, fw * 0.004, each((ctx, { f }) => {
    for (const idx of [BROW_R, BROW_L]) {
      poly(ctx, f, idx, W, H);
      ctx.fill();
    }
  }));
  for (const ch of [shadow]) {
    let mx = 0;
    for (let i = 0; i < ch.length; i++) if (ch[i] > mx) mx = ch[i];
    if (mx > 0) for (let i = 0; i < ch.length; i++) ch[i] *= 255 / mx;
  }
  // 얼굴 번호 지도: 가장 가까운 얼굴 (얼굴별 따로 보정용, 값 = (번호+1)×32)
  const centers = geo.map(({ g }) => [g.center[0] * M, g.center[1] * M, g.faceW * M]);
  const m3 = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = -1;
      let bd = Infinity;
      centers.forEach(([cx, cy, w], i) => {
        const d = Math.hypot(x - cx, y - cy) / w;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      const o = (y * W + x) * 4;
      m3.data[o] = bd < 2 ? (best + 1) * 32 : 0;
      m3.data[o + 3] = 255;
    }
  }
  const m1 = new ImageData(W, H);
  const m2 = new ImageData(W, H);
  const k = (v) => (v > 255 ? 255 : v);
  for (let i = 0, j = 0; j < W * H; i += 4, j++) {
    m1.data[i] = k(skin[j]);
    m1.data[i + 1] = k(lips[j]);
    m1.data[i + 2] = k(teeth[j]);
    m1.data[i + 3] = k(under[j]);
    m2.data[i] = k(cheeks[j]);
    m2.data[i + 1] = k(eyes[j]);
    m2.data[i + 2] = k(shadow[j]);
    m2.data[i + 3] = k(brows[j]);
  }
  return { m1, m2, m3 };
}

/** 메이크업 색 (sRGB 0~1) */
export const LIP_COLORS = [
  ['mlbb', 'MLBB', [0.72, 0.4, 0.42]],
  ['coral', '코랄', [0.93, 0.46, 0.4]],
  ['rose', '로즈', [0.84, 0.36, 0.5]],
  ['red', '레드', [0.78, 0.13, 0.2]],
  ['nude', '누드', [0.8, 0.56, 0.5]],
  ['plum', '플럼', [0.56, 0.22, 0.34]],
];
export const BLUSH_COLORS = [
  ['peach', '피치', [1.0, 0.72, 0.58]],
  ['pink', '핑크', [1.0, 0.64, 0.72]],
  ['coral', '코랄', [1.0, 0.6, 0.5]],
  ['rose', '로즈', [0.92, 0.56, 0.62]],
];
export const SHADOW_COLORS = [
  ['brown', '브라운', [0.6, 0.42, 0.32]],
  ['pink', '핑크', [0.86, 0.58, 0.62]],
  ['orange', '오렌지', [0.88, 0.56, 0.38]],
  ['smoky', '스모키', [0.36, 0.33, 0.35]],
];

/** 자동 뷰티: 티 나지 않게 자연스러운 정도 */
export const AUTO_BEAUTY = {
  skinSmooth: 40, skinTone: 25, darkCircle: 35, blush: 20, faceSlim: 30, eyes: 25, eyeBright: 25, nose: 20, lips: 30, teeth: 35,
};
