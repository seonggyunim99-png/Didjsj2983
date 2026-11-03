// 사물 지우기: 칠한 부분을 주변과 비슷한 무늬로 자연스럽게 채웁니다 (기기 안에서만 처리)
// 방식: 여러 크기에서 PatchMatch로 "가장 닮은 주변 조각"을 찾아 겹쳐 채우기 (Wexler 등 2007, Barnes 등 2009)

const PR = 3; // 조각 반지름 (7×7)

/** 같은 입력이면 같은 결과가 나오도록 고정된 난수 */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** 칠한 획 → 구멍 지도 (1 = 채울 곳). 좌표는 0~1 비율, 반지름은 긴 변 기준 */
function strokeMask(W, H, op) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const u = Math.max(W, H);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = op.r * u * 2;
  const p = op.p;
  ctx.beginPath();
  ctx.moveTo(p[0] * W, p[1] * H);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
  if (p.length === 2) {
    ctx.arc(p[0] * W, p[1] * H, op.r * u, 0, Math.PI * 2);
    ctx.fill();
  } else ctx.stroke();
  return ctx.getImageData(0, 0, W, H).data;
}

/* ---------- 한 크기에서의 처리 ---------- */

class Level {
  constructor(w, h, img, hole) {
    this.w = w;
    this.h = h;
    this.img = img; // Float32 RGB
    this.hole = hole; // Uint8 1 = 구멍
    // 원본으로 쓸 수 있는 조각 중심: 조각 전체가 구멍 밖 · 사진 안
    const valid = new Uint8Array(w * h);
    const list = [];
    // 구멍을 조각 반지름만큼 넓힌 지도
    const near = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!hole[y * w + x]) continue;
        for (let dy = -PR; dy <= PR; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -PR; dx <= PR; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) near[yy * w + xx] = 1;
          }
        }
      }
    }
    // 구멍에서의 거리 (안쪽 두께 · 바깥 거리) → 구멍 두께의 몇 배 안쪽 테두리에서만 가져옴
    const outD = chamfer(w, h, hole, false);
    const inD = chamfer(w, h, hole, true);
    let thick = 0;
    for (let i = 0; i < w * h; i++) if (hole[i] && inD[i] > thick) thick = inD[i];
    const band = Math.max(PR * 3 + 2, thick * 2.2 + PR);
    for (let y = PR; y < h - PR; y++) {
      for (let x = PR; x < w - PR; x++) {
        const i = y * w + x;
        if (!near[i] && outD[i] <= band) {
          valid[i] = 1;
          list.push(i);
        }
      }
    }
    this.valid = valid;
    this.validList = list;
    // 채워야 할 조각 중심: 구멍과 겹치는 모든 위치
    const targets = [];
    for (let i = 0; i < w * h; i++) if (near[i]) targets.push(i);
    this.targets = targets;
    this.nnf = new Int32Array(w * h).fill(-1);
    this.cost = new Float32Array(w * h);
    this.D2 = Math.max(w, h) ** 2;
  }

  /** 멀리 있는 조각일수록 조금 손해 → 가까운 배경을 우선 (얼굴 같은 엉뚱한 곳이 복사되지 않게) */
  pen(t, s) {
    const w = this.w;
    const dx = (t % w) - (s % w);
    const dy = ((t / w) | 0) - ((s / w) | 0);
    return (2500 * (dx * dx + dy * dy)) / this.D2;
  }

  full(t, s) {
    const p = this.pen(t, s);
    return this.dist(t, s, Infinity) + p;
  }

  dist(t, s, best) {
    const { w, h, img } = this;
    const tx = t % w;
    const ty = (t / w) | 0;
    const sx = s % w;
    const sy = (s / w) | 0;
    let d = 0;
    let n = 0;
    for (let dy = -PR; dy <= PR; dy++) {
      const y = ty + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const x = tx + dx;
        if (x < 0 || x >= w) continue;
        const a = (y * w + x) * 3;
        const b = ((sy + dy) * w + sx + dx) * 3;
        const r = img[a] - img[b];
        const g = img[a + 1] - img[b + 1];
        const bl = img[a + 2] - img[b + 2];
        d += r * r + g * g + bl * bl;
        n++;
        if (d > best * 49) return Infinity; // 이미 더 나쁜 것이 확실하면 중단
      }
    }
    return d / Math.max(1, n);
  }

  try(t, s) {
    if (s < 0 || !this.valid[s]) return;
    const p = this.pen(t, s);
    if (p >= this.cost[t]) return;
    const d = this.dist(t, s, this.cost[t] - p) + p;
    if (d < this.cost[t]) {
      this.cost[t] = d;
      this.nnf[t] = s;
    }
  }

  initNNF(rand, prev) {
    const { w, validList, targets } = this;
    for (const t of targets) {
      let s = -1;
      if (prev) {
        // 작은 크기의 결과를 2배로 키워 출발점으로
        const tx = t % w;
        const ty = (t / w) | 0;
        const pt = Math.min(prev.h - 1, ty >> 1) * prev.w + Math.min(prev.w - 1, tx >> 1);
        const ps = prev.nnf[pt];
        if (ps >= 0) {
          const sx = Math.min(w - 1, (ps % prev.w) * 2 + (tx & 1));
          const sy = Math.min(this.h - 1, ((ps / prev.w) | 0) * 2 + (ty & 1));
          s = sy * w + sx;
          if (!this.valid[s]) s = -1;
        }
      }
      if (s < 0) s = validList[(rand() * validList.length) | 0];
      this.nnf[t] = s;
      this.cost[t] = this.full(t, s);
    }
  }

  patchMatch(rand, iters) {
    const { w, h, targets, nnf } = this;
    const maxR = Math.max(w, h);
    for (let it = 0; it < iters; it++) {
      const fwd = it % 2 === 0;
      const step = fwd ? -1 : 1;
      for (let k = 0; k < targets.length; k++) {
        const t = targets[fwd ? k : targets.length - 1 - k];
        const tx = t % w;
        const ty = (t / w) | 0;
        // 이웃이 찾은 자리를 옆으로 옮겨 시도 (전파)
        const nx = tx + step;
        if (nx >= 0 && nx < w) {
          const s = nnf[t + step];
          if (s >= 0) this.try(t, s - step);
        }
        const ny = ty + step;
        if (ny >= 0 && ny < h) {
          const s = nnf[t + step * w];
          if (s >= 0) this.try(t, s - step * w);
        }
        // 지금 자리 주변을 점점 좁혀 가며 무작위로 시도
        const cur = nnf[t];
        const cx = cur % w;
        const cy = (cur / w) | 0;
        for (let r = maxR; r >= 1; r >>= 1) {
          const sx = Math.round(cx + (rand() * 2 - 1) * r);
          const sy = Math.round(cy + (rand() * 2 - 1) * r);
          if (sx < PR || sy < PR || sx >= w - PR || sy >= h - PR) continue;
          this.try(t, sy * w + sx);
        }
      }
    }
  }

  /** 찾은 조각들을 겹쳐 구멍 픽셀 값을 새로 정함 */
  vote() {
    const { w, h, img, hole, targets, nnf, cost } = this;
    const acc = new Float32Array(w * h * 3);
    const ws = new Float32Array(w * h);
    // 비슷한 조각일수록 더 믿음
    let mean = 0;
    for (const t of targets) mean += cost[t];
    const sig = Math.max(1e-4, (mean / Math.max(1, targets.length)) * 0.75);
    for (const t of targets) {
      const s = nnf[t];
      if (s < 0) continue;
      const wt = Math.exp(-cost[t] / (2 * sig));
      const tx = t % w;
      const ty = (t / w) | 0;
      const sx = s % w;
      const sy = (s / w) | 0;
      for (let dy = -PR; dy <= PR; dy++) {
        const y = ty + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -PR; dx <= PR; dx++) {
          const x = tx + dx;
          if (x < 0 || x >= w) continue;
          const q = y * w + x;
          if (!hole[q]) continue;
          const b = ((sy + dy) * w + sx + dx) * 3;
          acc[q * 3] += img[b] * wt;
          acc[q * 3 + 1] += img[b + 1] * wt;
          acc[q * 3 + 2] += img[b + 2] * wt;
          ws[q] += wt;
        }
      }
    }
    for (let q = 0; q < w * h; q++) {
      if (!hole[q] || !ws[q]) continue;
      img[q * 3] = acc[q * 3] / ws[q];
      img[q * 3 + 1] = acc[q * 3 + 1] / ws[q];
      img[q * 3 + 2] = acc[q * 3 + 2] / ws[q];
    }
    for (const t of targets) this.cost[t] = this.nnf[t] >= 0 ? this.full(t, this.nnf[t]) : Infinity;
  }
}

/** 3-4 거리 변환: inside=false면 구멍까지의 거리, true면 구멍 안에서 가장자리까지의 거리 (픽셀 단위) */
function chamfer(w, h, hole, inside) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = (inside ? !hole[i] : hole[i]) ? 0 : INF;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? (inside ? 0 : INF) : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** 구멍을 바깥부터 이웃 평균으로 채움 (가장 작은 크기에서 출발값) */
function diffuseFill(w, h, img, hole) {
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
  let left = true;
  for (let pass = 0; pass < w + h && left; pass++) {
    left = false;
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!known[j]) continue;
          r += img[j * 3];
          g += img[j * 3 + 1];
          b += img[j * 3 + 2];
          n++;
        }
        if (n) add.push([i, r / n, g / n, b / n]);
        else left = true;
      }
    }
    for (const [i, r, g, b] of add) {
      img[i * 3] = r;
      img[i * 3 + 1] = g;
      img[i * 3 + 2] = b;
      known[i] = 1;
    }
    if (!add.length) break;
  }
}

function downsample(w, h, img, hole) {
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const im2 = new Float32Array(w2 * h2 * 3);
  const ho2 = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      let anyHole = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const xx = Math.min(w - 1, x * 2 + dx);
          const yy = Math.min(h - 1, y * 2 + dy);
          const i = yy * w + xx;
          if (hole[i]) {
            anyHole = 1;
            continue;
          }
          r += img[i * 3];
          g += img[i * 3 + 1];
          b += img[i * 3 + 2];
          n++;
        }
      }
      const o = y * w2 + x;
      ho2[o] = anyHole;
      if (n) {
        im2[o * 3] = r / n;
        im2[o * 3 + 1] = g / n;
        im2[o * 3 + 2] = b / n;
      }
    }
  }
  return { w: w2, h: h2, img: im2, hole: ho2 };
}

/**
 * RGB 이미지(Float32, 0~255)의 구멍을 채웁니다.
 * @returns {Float32Array} 채운 이미지 (같은 크기)
 */
export function fillHole(w, h, img, hole, seed = 1) {
  const rand = rng(seed);
  // 여러 크기 만들기 (가장 작은 크기는 긴 변 40px 정도)
  const pyr = [{ w, h, img: Float32Array.from(img), hole }];
  while (Math.max(pyr[pyr.length - 1].w, pyr[pyr.length - 1].h) > 40 && pyr.length < 7) {
    const t = pyr[pyr.length - 1];
    pyr.push(downsample(t.w, t.h, t.img, t.hole));
  }
  let prev = null;
  for (let li = pyr.length - 1; li >= 0; li--) {
    const L = pyr[li];
    if (!prev) diffuseFill(L.w, L.h, L.img, L.hole);
    else {
      // 작은 크기에서 채운 결과를 키워 구멍 부분의 출발값으로
      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) {
          const i = y * L.w + x;
          if (!L.hole[i]) continue;
          const j = Math.min(prev.h - 1, y >> 1) * prev.w + Math.min(prev.w - 1, x >> 1);
          L.img[i * 3] = prev.img[j * 3];
          L.img[i * 3 + 1] = prev.img[j * 3 + 1];
          L.img[i * 3 + 2] = prev.img[j * 3 + 2];
        }
      }
    }
    const lev = new Level(L.w, L.h, L.img, L.hole);
    if (!lev.validList.length || !lev.targets.length) {
      prev = lev;
      continue;
    }
    lev.initNNF(rand, prev && prev.validList?.length ? prev : null);
    const em = li === 0 ? 2 : 3;
    for (let e = 0; e < em; e++) {
      lev.patchMatch(rand, e === 0 ? 3 : 2);
      lev.vote();
    }
    prev = lev;
  }
  // 마지막: 평균만 쓰면 결이 뭉개지므로, 가장 닮은 조각의 가운데 픽셀을 섞어 질감을 살림
  if (prev.targets?.length) {
    const { img: im, hole: ho, nnf } = prev;
    const copy = Float32Array.from(im);
    for (let q = 0; q < prev.w * prev.h; q++) {
      if (!ho[q] || nnf[q] < 0) continue;
      const s = nnf[q] * 3;
      for (let c = 0; c < 3; c++) im[q * 3 + c] = copy[q * 3 + c] * 0.4 + copy[s + c] * 0.6;
    }
  }
  return prev.img;
}

/**
 * 캔버스에서 획으로 칠한 곳을 지웁니다.
 * @param op { r, p, seed } — 좌표는 0~1 비율, r은 긴 변 기준
 * @param limit 계산할 영역의 긴 변 최대 크기 (작을수록 빠름)
 */
export function removeArea(canvas, op, limit = 520) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const m = strokeMask(W, H, op);
  // 칠한 범위 + 주변 여백
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (m[(y * W + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  const pad = Math.max(24, Math.round(Math.max(x1 - x0, y1 - y0) * 0.9), Math.round(op.r * Math.max(W, H) * 3));
  const rx = Math.max(0, x0 - pad);
  const ry = Math.max(0, y0 - pad);
  const rw = Math.min(W, x1 + pad + 1) - rx;
  const rh = Math.min(H, y1 + pad + 1) - ry;
  const k = Math.min(1, limit / Math.max(rw, rh));
  const w = Math.max(8, Math.round(rw * k));
  const h = Math.max(8, Math.round(rh * k));
  // 영역을 작게 만들어 계산
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, rx, ry, rw, rh, 0, 0, w, h);
  const sd = sctx.getImageData(0, 0, w, h).data;
  const img = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    img[i * 3] = sd[i * 4];
    img[i * 3 + 1] = sd[i * 4 + 1];
    img[i * 3 + 2] = sd[i * 4 + 2];
  }
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 작은 크기에서는 조금 넓게 (경계의 흔적이 남지 않게)
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        for (let dx = -1; dx <= 1 && !any; dx++) {
          const fx = Math.min(rw - 1, Math.max(0, Math.round((x + dx + 0.5) / k)));
          const fy = Math.min(rh - 1, Math.max(0, Math.round((y + dy + 0.5) / k)));
          if (m[((ry + fy) * W + rx + fx) * 4 + 3] > 20) any = 1;
        }
      }
      hole[y * w + x] = any;
    }
  }
  const out = fillHole(w, h, img, hole, op.seed || 1);
  for (let i = 0; i < w * h; i++) {
    sd[i * 4] = out[i * 3];
    sd[i * 4 + 1] = out[i * 3 + 1];
    sd[i * 4 + 2] = out[i * 3 + 2];
    sd[i * 4 + 3] = 255;
  }
  sctx.putImageData(new ImageData(sd, w, h), 0, 0);
  // 원래 크기로 키운 채움 결과를, 칠한 곳에만 (경계는 부드럽게) 덮음
  const big = document.createElement('canvas');
  big.width = rw;
  big.height = rh;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, rw, rh);
  const fill = bctx.getImageData(0, 0, rw, rh).data;
  const orig = ctx.getImageData(rx, ry, rw, rh);
  const od = orig.data;
  // 경계 부드럽게: 마스크를 살짝 흐림
  const feather = Math.max(1, Math.round(1.5 / k));
  const mk = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mk[y * rw + x] = m[((ry + y) * W + rx + x) * 4 + 3] / 255;
  const tmp = new Float32Array(rw * rh);
  const blur1 = (src, dst, horiz) => {
    const n = horiz ? rw : rh;
    const lines = horiz ? rh : rw;
    for (let l = 0; l < lines; l++) {
      let s = 0;
      const at = (i) => (horiz ? l * rw + Math.min(n - 1, Math.max(0, i)) : Math.min(n - 1, Math.max(0, i)) * rw + l);
      for (let i = -feather; i <= feather; i++) s += src[at(i)];
      for (let i = 0; i < n; i++) {
        dst[at(i)] = s / (2 * feather + 1);
        s += src[at(i + feather + 1)] - src[at(i - feather)];
      }
    }
  };
  // 칠한 곳은 확실히 덮고(넓힌 뒤 흐림), 바깥으로 살짝 섞임
  const grown = new Float32Array(rw * rh);
  for (let i = 0; i < mk.length; i++) grown[i] = mk[i] > 0.05 ? 1 : 0;
  blur1(grown, tmp, true);
  blur1(tmp, grown, false);
  for (let i = 0; i < rw * rh; i++) {
    const a = Math.min(1, Math.max(grown[i] * 1.6 - 0.3, mk[i] > 0.05 ? 1 : 0) * 1);
    if (a <= 0) continue;
    od[i * 4] = od[i * 4] + (fill[i * 4] - od[i * 4]) * a;
    od[i * 4 + 1] = od[i * 4 + 1] + (fill[i * 4 + 1] - od[i * 4 + 1]) * a;
    od[i * 4 + 2] = od[i * 4 + 2] + (fill[i * 4 + 2] - od[i * 4 + 2]) * a;
  }
  ctx.putImageData(orig, rx, ry);
}
