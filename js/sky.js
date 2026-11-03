// 하늘 바꾸기용 하늘 영역 찾기 (기기 안에서만 처리)
// 위쪽 가장자리에서 시작해 "밝고 결이 고른 하늘색(파랑·흰 구름·흐린 회색·노을)" 픽셀을 따라 넓혀 가고,
// 가이드 필터로 나무·건물 경계에 맞춰 다듬습니다.
import { guidedFilter, grayGuide, upsample } from './face.js';

/** 하늘 바꾸기에 쓰는 하늘 (위 → 지평선 색, 구름 · 별 · 앞쪽 색감) */
export const SKIES = [
  ['blue', '맑은 하늘', { top: [0.17, 0.42, 0.84], hor: [0.68, 0.84, 0.97], cloud: 0.55, stars: 0, tint: [1, 1, 1] }],
  ['sunset', '노을', { top: [0.24, 0.2, 0.46], hor: [1.0, 0.62, 0.36], cloud: 0.3, stars: 0, tint: [1.08, 0.97, 0.86] }],
  ['golden', '골든아워', { top: [0.33, 0.54, 0.86], hor: [1.0, 0.84, 0.56], cloud: 0.35, stars: 0, tint: [1.06, 1.0, 0.9] }],
  ['pink', '핑크 하늘', { top: [0.52, 0.54, 0.86], hor: [1.0, 0.72, 0.78], cloud: 0.4, stars: 0, tint: [1.04, 0.98, 1.0] }],
  ['night', '밤하늘', { top: [0.02, 0.03, 0.1], hor: [0.12, 0.14, 0.28], cloud: 0, stars: 1, tint: [0.82, 0.86, 1.0] }],
];

/**
 * 하늘 영역
 * @param person 사람 영역(있으면 빼고) { w, h, person }
 * @returns {{w:number, h:number, data:Uint8Array, cover:number}|null}
 */
export function detectSky(source, W, H, person = null) {
  // 1) 작은 크기에서 하늘 후보 찾기
  const k = Math.min(1, 320 / Math.max(W, H));
  const w = Math.max(16, Math.round(W * k));
  const h = Math.max(16, Math.round(H * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = d[i * 4] / 255;
    G[i] = d[i * 4 + 1] / 255;
    B[i] = d[i * 4 + 2] / 255;
    L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  }
  // 결(변화량): 하늘은 고르고 나뭇잎·건물은 거침
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + w] - L[i - w];
      grad[i] = Math.hypot(gx, gy);
    }
  }
  let pm = person ? upsample(Float32Array.from(person.person, (v) => v / 255), person.w, person.h, w, h) : null;
  const pmRaw = pm;
  if (pm) {
    // 얇은 팔·손가락이 하늘로 바뀌지 않게 사람 영역을 조금 넓힘
    const grow = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            m = Math.max(m, pm[yy * w + xx]);
          }
        }
        grow[y * w + x] = m;
      }
    }
    pm = grow;
  }
  const skyish = (i) => {
    const r = R[i];
    const g = G[i];
    const b = B[i];
    const l = L[i];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (pm && pm[i] > 0.12) return false;
    if (grad[i] > 0.09) return false;
    // 파란 하늘 (해 질 녘의 어두운 파랑도 포함)
    const blue = (b > r + 0.02 && b >= g - 0.04 && l > 0.2) || (b > r + 0.06 && b > g && l > 0.06);
    const gray = sat < 0.14 && l > 0.62;
    // 노을빛 하늘: 밝고 채도가 낮은 따뜻한 색 (피부색은 빠지도록 좁게)
    const warm = l > 0.62 && r > b && sat < 0.28 && y0of(i) < h * 0.45;
    return blue || gray || warm;
  };
  const y0of = (i) => (i / w) | 0;
  // 2) 위쪽 가장자리에서 시작해 색이 비슷한 이웃으로 넓혀 감
  const sky = new Uint8Array(n);
  const queue = [];
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < Math.max(1, Math.round(h * 0.04)); y++) {
      const i = y * w + x;
      if (skyish(i) && !sky[i]) {
        sky[i] = 1;
        queue.push(i);
      }
    }
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (sky[j]) continue;
      const cd = Math.abs(R[j] - R[i]) + Math.abs(G[j] - G[i]) + Math.abs(B[j] - B[i]);
      if (cd < 0.12 && skyish(j)) {
        sky[j] = 1;
        queue.push(j);
      }
    }
  }
  // 사람 바로 옆(넓혀서 뺐던 띠)도 하늘이면 다시 채움 → 사람 둘레에 원래 하늘이 남지 않게
  if (pmRaw) {
    for (let pass = 0; pass < 4; pass++) {
      const add = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (sky[i] || pmRaw[i] > 0.45 || grad[i] > 0.12) continue;
          if (!(sky[i - 1] || sky[i + 1] || sky[i - w] || sky[i + w])) continue;
          const b = B[i] > R[i] || L[i] > 0.62;
          if (b) add.push(i);
        }
      }
      add.forEach((i) => { sky[i] = 1; });
      if (!add.length) break;
    }
  }
  let count = 0;
  let blueCount = 0;
  let skyL = 0;
  let restL = 0;
  for (let i = 0; i < n; i++) {
    if (sky[i]) {
      count++;
      skyL += L[i];
      if (B[i] > R[i] + 0.04) blueCount++;
    } else restL += L[i];
  }
  const cover = count / n;
  if (cover < 0.03) return null;
  // 진짜 하늘인지 확인: 파란 하늘이 넉넉하거나, 흐린 하늘이면 나머지보다 확실히 밝아야 함 (흰 벽·천장 제외)
  skyL /= count;
  restL /= Math.max(1, n - count);
  const blueFrac = blueCount / count;
  detectSky.debug = { cover, blueFrac, skyL, restL };
  if (blueFrac < 0.3 && skyL - restL < 0.15) return null;
  if (skyL < (blueFrac > 0.5 ? 0.22 : 0.45)) return null;
  if (cover < 0.05) return null;
  // 작은 구멍(구름 사이 · 새 등)은 메움: 위아래로 하늘에 둘러싸인 짧은 틈
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      if (!sky[y * w + x]) continue;
      if (last >= 0 && y - last > 1 && y - last < h * 0.06) for (let t = last + 1; t < y; t++) sky[t * w + x] = 1;
      last = y;
    }
  }
  // 3) 사진 경계에 맞춰 다듬기
  const gk = Math.min(1, 768 / Math.max(W, H));
  const gw = Math.max(16, Math.round(W * gk));
  const gh = Math.max(16, Math.round(H * gk));
  const I = grayGuide(source, gw, gh);
  const P = upsample(Float32Array.from(sky), w, h, gw, gh);
  const q = guidedFilter(I, P, gw, gh, Math.max(2, Math.round(Math.max(gw, gh) / 120)), 0.001);
  // 하늘 평균 색 (사람 경계의 애매한 픽셀을 색으로 다시 판단할 때 씀)
  let sr = 0;
  let sgc = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    if (!sky[i]) continue;
    sr += R[i];
    sgc += G[i];
    sb += B[i];
  }
  sr /= count;
  sgc /= count;
  sb /= count;
  const gc = document.createElement('canvas');
  gc.width = gw;
  gc.height = gh;
  const gctx = gc.getContext('2d', { willReadFrequently: true });
  gctx.drawImage(source, 0, 0, gw, gh);
  const gd = gctx.getImageData(0, 0, gw, gh).data;
  const pg = person ? upsample(Float32Array.from(person.person, (v) => v / 255), person.w, person.h, gw, gh) : null;
  const data = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    let v = Math.min(1, Math.max(0, (q[i] - 0.5) * 2.6 + 0.5));
    if (pg && pg[i] > 0.05) {
      // 사람일 가능성이 애매한 띠: 하늘색에 가까우면 하늘, 아니면 사람
      const cd = Math.abs(gd[i * 4] / 255 - sr) + Math.abs(gd[i * 4 + 1] / 255 - sgc) + Math.abs(gd[i * 4 + 2] / 255 - sb);
      const likeSky = Math.min(1, Math.max(0, 1 - (cd - 0.08) / 0.14));
      const sure = Math.min(1, Math.max(0, (pg[i] - 0.55) / 0.3));
      v = pg[i] < 0.9 ? Math.max(v * (1 - sure), likeSky * (1 - sure) * (v > 0.05 || pg[i] < 0.8 ? 1 : 0)) : 0;
    }
    data[i] = Math.round(v * 255);
  }
  return { w: gw, h: gh, data, cover };
}
