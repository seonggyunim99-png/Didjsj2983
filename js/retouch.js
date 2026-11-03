// 손으로 직접 다듬기
//  - 모양 변형(성형): 밀기 · 크게 · 작게 · 되돌리기 → 변형 지도(칸마다 "어디서 가져올지")
//  - 부분 보정 브러시: 밝게 · 어둡게 · 매끄럽게 · 선명하게 · 미백 · 채도 · 색온도 · 지우개 → 4채널 영역 지도
// 좌표는 모두 "긴 변 = 1" 단위라서 미리보기와 원본 해상도 저장 결과가 같습니다.
// 획 목록(op)은 { t: 도구, r: 반지름, s: 세기 0~1, p: [x0, y0, x1, y1, …] } 형태로 편집 기록에 저장됩니다.

export const LIQ_TOOLS = [
  ['push', '밀기'],
  ['bloat', '크게'],
  ['pinch', '작게'],
  ['restore', '되돌리기'],
];

// 부분 보정 도구: [밝기, 채도, 색온도, 디테일] 방향
export const LOCAL_TOOLS = [
  ['light', '밝게', [1, 0, 0, 0]],
  ['dark', '어둡게', [-1, 0, 0, 0]],
  ['smooth', '매끄럽게', [0, 0, 0, -1]],
  ['sharp', '선명하게', [0, 0, 0, 1]],
  ['whiten', '미백', [0.25, -0.6, -0.1, 0]],
  ['sat', '채도 높게', [0, 1, 0, 0]],
  ['desat', '채도 낮게', [0, -1, 0, 0]],
  ['warm', '따뜻하게', [0, 0, 1, 0]],
  ['cool', '차갑게', [0, 0, -1, 0]],
  ['erase', '지우개', null],
];
const LOCAL_VEC = Object.fromEntries(LOCAL_TOOLS.map(([k, , v]) => [k, v]));

const smooth = (t) => {
  const u = 1 - t * t;
  return u * u;
};

/* ---------- 모양 변형 지도 ---------- */

export class WarpField {
  constructor(W, H, N = 768) {
    const M = Math.max(W, H);
    this.fw = Math.max(2, Math.round((N * W) / M));
    this.fh = Math.max(2, Math.round((N * H) / M));
    this.cs = W / M / this.fw; // 한 칸의 크기 (단위)
    this.d = new Float32Array(this.fw * this.fh * 2);
    this.tmp = new Float32Array(0);
    this.empty = true;
  }

  /** 단위 좌표 (x, y)에서 변형 값 (양선형 보간) */
  sample(x, y, src = this.d, x0 = 0, y0 = 0, w = this.fw, h = this.fh) {
    let gx = x / this.cs - 0.5 - x0;
    let gy = y / this.cs - 0.5 - y0;
    gx = Math.min(w - 1, Math.max(0, gx));
    gy = Math.min(h - 1, Math.max(0, gy));
    const ix = Math.min(w - 2, Math.floor(gx));
    const iy = Math.min(h - 2, Math.floor(gy));
    const fx = gx - ix;
    const fy = gy - iy;
    const i00 = (iy * w + ix) * 2;
    const i10 = i00 + 2;
    const i01 = i00 + w * 2;
    const i11 = i01 + 2;
    const out = [0, 0];
    for (let c = 0; c < 2; c++) {
      const a = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
      const b = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
      out[c] = a + (b - a) * fy;
    }
    return out;
  }

  /** 원 안쪽 칸을 돌며 fn(칸 중심 x, y, 무게 w, 칸 번호) */
  region(cx, cy, r, margin, fn) {
    const { cs, fw, fh } = this;
    const x0 = Math.max(0, Math.floor((cx - r - margin) / cs) - 1);
    const x1 = Math.min(fw - 1, Math.ceil((cx + r + margin) / cs) + 1);
    const y0 = Math.max(0, Math.floor((cy - r - margin) / cs) - 1);
    const y1 = Math.min(fh - 1, Math.ceil((cy + r + margin) / cs) + 1);
    if (x0 > x1 || y0 > y1) return;
    this.markRows(y0, y1);
    // 바뀌기 전 값을 복사해 두고 거기서 읽음
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (this.tmp.length < w * h * 2) this.tmp = new Float32Array(w * h * 2);
    for (let y = 0; y < h; y++) this.tmp.set(this.d.subarray(((y0 + y) * fw + x0) * 2, ((y0 + y) * fw + x1 + 1) * 2), y * w * 2);
    const old = (x, y) => this.sample(x, y, this.tmp, x0, y0, w, h);
    for (let gy = Math.max(0, Math.floor((cy - r) / cs - 0.5)); gy <= Math.min(fh - 1, Math.ceil((cy + r) / cs)); gy++) {
      const py = (gy + 0.5) * cs;
      for (let gx = Math.max(0, Math.floor((cx - r) / cs - 0.5)); gx <= Math.min(fw - 1, Math.ceil((cx + r) / cs)); gx++) {
        const px = (gx + 0.5) * cs;
        const t = Math.hypot(px - cx, py - cy) / r;
        if (t >= 1) continue;
        fn(px, py, smooth(t), (gy * fw + gx) * 2, old);
      }
    }
    this.empty = false;
  }

  /** 밀기: 붓 중심 c 근처의 내용을 v 방향으로 옮김 */
  push(cx, cy, r, vx, vy) {
    this.region(cx, cy, r, Math.hypot(vx, vy), (px, py, w, i, old) => {
      const qx = px - vx * w;
      const qy = py - vy * w;
      const o = old(qx, qy);
      this.d[i] = o[0] - vx * w;
      this.d[i + 1] = o[1] - vy * w;
    });
  }

  /** 크게(k>0) · 작게(k<0) */
  scale(cx, cy, r, k) {
    this.region(cx, cy, r, 0, (px, py, w, i, old) => {
      const f = k * w;
      const qx = px - (px - cx) * f;
      const qy = py - (py - cy) * f;
      const o = old(qx, qy);
      this.d[i] = o[0] + qx - px;
      this.d[i + 1] = o[1] + qy - py;
    });
  }

  restore(cx, cy, r, k) {
    this.region(cx, cy, r, 0, (px, py, w, i) => {
      const f = 1 - k * w;
      this.d[i] *= f;
      this.d[i + 1] *= f;
    });
  }

  /** 획 하나를 from번째 점부터 적용 (그리는 중에는 새 점만) */
  apply(op, from = 0) {
    const { t, r, s, p } = op;
    const n = p.length / 2;
    if (t === 'push') {
      for (let i = Math.max(1, from); i < n; i++) {
        let x = p[i * 2 - 2];
        let y = p[i * 2 - 1];
        const dx = p[i * 2] - x;
        const dy = p[i * 2 + 1] - y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r * 0.15)));
        for (let k = 0; k < steps; k++) {
          this.push(x, y, r, (dx / steps) * s, (dy / steps) * s);
          x += dx / steps;
          y += dy / steps;
        }
      }
      return;
    }
    for (let i = from; i < n; i++) {
      const x = p[i * 2];
      const y = p[i * 2 + 1];
      if (t === 'bloat') this.scale(x, y, r, 0.016 * s);
      else if (t === 'pinch') this.scale(x, y, r, -0.016 * s);
      else if (t === 'restore') this.restore(x, y, r, 0.3 * s);
    }
  }

  /** GPU로 보낼 RG 값 */
  data() {
    return this.d;
  }

  markRows(a, b) {
    this.rows = this.rows ? [Math.min(this.rows[0], a), Math.max(this.rows[1], b)] : [a, b];
  }

  /** 지난번 올린 뒤로 바뀐 줄 범위 [첫 줄, 끝 줄] (가져가면 비움) */
  takeRows() {
    const r = this.rows;
    this.rows = null;
    return r;
  }
}

/* ---------- 부분 보정 영역 지도 ---------- */

export class LocalMask {
  constructor(W, H, N = 1024) {
    const M = Math.max(W, H);
    this.fw = Math.max(2, Math.round((N * W) / M));
    this.fh = Math.max(2, Math.round((N * H) / M));
    this.cs = W / M / this.fw;
    const n = this.fw * this.fh;
    this.v = new Float32Array(n * 4);
    this.base = new Float32Array(n * 4);
    this.cov = new Float32Array(n);
    this.bytes = new Uint8Array(n * 4);
    this.bytes.fill(128); // 128 = 바꾸지 않음 (네 채널 모두 값으로 씀)
    this.box = null;
    this.empty = true;
  }

  /** 붓 한 번 찍기: 이번 획이 덮은 정도(cov)는 겹쳐도 더해지지 않고 가장 큰 값만 */
  dab(cx, cy, r) {
    const { cs, fw, fh } = this;
    const gx0 = Math.max(0, Math.floor((cx - r) / cs));
    const gx1 = Math.min(fw - 1, Math.ceil((cx + r) / cs));
    const gy0 = Math.max(0, Math.floor((cy - r) / cs));
    const gy1 = Math.min(fh - 1, Math.ceil((cy + r) / cs));
    if (gx0 > gx1 || gy0 > gy1) return;
    for (let gy = gy0; gy <= gy1; gy++) {
      const py = (gy + 0.5) * cs;
      for (let gx = gx0; gx <= gx1; gx++) {
        const t = Math.hypot((gx + 0.5) * cs - cx, py - cy) / r;
        if (t >= 1) continue;
        // 가운데는 꽉, 가장자리는 부드럽게
        const w = t < 0.45 ? 1 : smooth((t - 0.45) / 0.55);
        const i = gy * fw + gx;
        if (w > this.cov[i]) this.cov[i] = w;
      }
    }
    const b = this.box;
    this.box = b ? [Math.min(b[0], gx0), Math.min(b[1], gy0), Math.max(b[2], gx1), Math.max(b[3], gy1)] : [gx0, gy0, gx1, gy1];
  }

  apply(op, from = 0) {
    const { r, s, p } = op;
    const n = p.length / 2;
    if (from === 0) {
      // 새 획: 지금 상태를 기준으로 저장하고 덮은 정도를 비움
      this.base.set(this.v);
      this.cov.fill(0);
      this.box = null;
    }
    for (let i = from; i < n; i++) {
      const x = p[i * 2];
      const y = p[i * 2 + 1];
      if (i === 0) {
        this.dab(x, y, r);
        continue;
      }
      const px = p[i * 2 - 2];
      const py = p[i * 2 - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (r * 0.2)));
      for (let k = 1; k <= steps; k++) this.dab(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps, r);
    }
    if (!this.box) return;
    const vec = LOCAL_VEC[op.t];
    const [gx0, gy0, gx1, gy1] = this.box;
    this.rows = this.rows ? [Math.min(this.rows[0], gy0), Math.max(this.rows[1], gy1)] : [gy0, gy1];
    const { fw, v, base, cov, bytes } = this;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * fw + gx;
        const c = cov[i];
        if (!c) continue;
        for (let ch = 0; ch < 4; ch++) {
          const j = i * 4 + ch;
          const val = vec ? Math.max(-1, Math.min(1, base[j] + vec[ch] * s * c)) : base[j] * (1 - s * c);
          v[j] = val;
          bytes[j] = Math.round(128 + val * 127);
        }
      }
    }
    this.empty = false;
  }

  /** GPU로 보낼 값 (1~255, 128 = 그대로) */
  data() {
    return this.bytes;
  }

  takeRows() {
    const r = this.rows;
    this.rows = null;
    return r;
  }
}

/* ---------- 획 목록 → 지도 (그리는 중에는 새로 추가된 부분만 계산) ---------- */

const head = (o) => `${o.t}|${o.r}|${o.s}|${o.p[0]}|${o.p[1]}`;

export class OpCache {
  constructor(make) {
    this.make = make;
    this.obj = null;
    this.key = '';
    this.applied = [];
  }

  /** @returns {object|null} 지도 (획이 없으면 null), this.changed = 바뀌었는지 */
  sync(ops, W, H) {
    this.changed = false;
    if (!ops || !ops.length) {
      if (this.obj) {
        this.obj = null;
        this.applied = [];
        this.changed = true;
      }
      return null;
    }
    const key = `${W}x${H}`;
    let prev = this.applied;
    let ok = !!this.obj && this.key === key && ops.length >= prev.length;
    for (let i = 0; ok && i < prev.length; i++) {
      const last = i === prev.length - 1;
      if (head(ops[i]) !== prev[i].head) ok = false;
      else if (last ? ops[i].p.length < prev[i].n : ops[i].p.length !== prev[i].n) ok = false;
    }
    this.rebuilt = !ok;
    if (!ok) {
      this.obj = this.make(W, H);
      this.key = key;
      prev = [];
    }
    for (let i = 0; i < ops.length; i++) {
      const from = i < prev.length ? prev[i].n / 2 : 0;
      if (i >= prev.length || ops[i].p.length / 2 > from) {
        this.obj.apply(ops[i], from);
        this.changed = true;
      }
    }
    this.applied = ops.map((o) => ({ head: head(o), n: o.p.length }));
    return this.obj;
  }
}
