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

let loading = null;

/** 얼굴 인식기를 한 번만 불러옵니다 (약 20MB, 처음 한 번만 내려받고 이후에는 저장된 것을 씀). */
function landmarker() {
  if (!loading) {
    loading = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import(`${VENDOR}vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${VENDOR}wasm`);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${VENDOR}face_landmarker.task`, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 6,
      });
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/**
 * 사진 속 얼굴들의 주요 지점을 찾습니다.
 * @returns {Promise<number[][][]>} 얼굴마다 [x, y] (0~1 비율) 478개
 */
export async function detectFaces(source) {
  const lm = await landmarker();
  const res = lm.detect(source);
  return (res.faceLandmarks || [])
    .filter((f) => f.length >= 468)
    .map((f) => f.map((p) => [p.x, p.y]));
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

/**
 * 뷰티 슬라이더 값으로 변형 목록을 만듭니다. 좌표·반지름은 긴 변 기준 단위.
 * @returns {{a:Float32Array, b:Float32Array, n:number}} a = [x, y, 반지름, 종류(0 확대, 1 밀기)], b = [밀기 x, y, 확대 세기, 0]
 */
export function buildWarps(faces, adj, W, H, max = 40) {
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
  for (const face of faces || []) {
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
        const list = side.map((i) => {
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
      for (const side of [[129, 98], [358, 327]]) {
        const list = side.map((i) => ({ c: P[i], r: nw * 0.4, v: norm(sub(tip, P[i])) }));
        group(list, (adj.nose / 100) * nw * 0.06);
      }
    }
  }
  return { a, b, n };
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
 * mask2: R 볼, G 눈
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
    m2.data[i + 3] = 255;
  }
  return { m1, m2 };
}

/** 자동 뷰티: 티 나지 않게 자연스러운 정도 */
export const AUTO_BEAUTY = {
  skinSmooth: 40, skinTone: 25, darkCircle: 35, blush: 20, faceSlim: 30, eyes: 25, eyeBright: 25, nose: 20, lips: 30, teeth: 35,
};
