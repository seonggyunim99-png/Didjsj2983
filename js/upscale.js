// AI 화질 개선: 작은 사진을 2배로 키우면서 선명하게 (ESRGAN Slim, 기기 안에서만 처리)
import * as im from './imaging.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
export const MAX_INPUT = 4_000_000; // 400만 화소 이하 사진만 (결과 1,600만 화소)

let loading = null;

function load() {
  if (!loading) {
    loading = (async () => {
      const tf = await import(`${VENDOR}tfjs/tf.fesm.min.js`);
      await tf.ready();
      const model = await tf.loadLayersModel(`${VENDOR}esrgan-slim/x2/model.json`);
      return { tf, model };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/**
 * 캔버스를 2배로 키운 새 캔버스 (조각으로 나눠 계산 → 메모리를 아끼고 경계가 보이지 않게 겹쳐서)
 * @param onProgress (0~1)
 */
export async function upscale2x(canvas, onProgress = () => {}) {
  const { tf, model } = await load();
  const W = canvas.width;
  const H = canvas.height;
  // 픽셀을 여러 번 읽으므로 읽기 전용 사본에서
  const copy = im.makeCanvas(W, H);
  const src = copy.getContext('2d', { willReadFrequently: true });
  src.drawImage(canvas, 0, 0);
  const out = im.makeCanvas(W * 2, H * 2);
  const octx = out.getContext('2d', { willReadFrequently: true });
  const T = 96;
  const P = 8;
  const tiles = [];
  for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) tiles.push([tx, ty]);
  let done = 0;
  for (const [tx, ty] of tiles) {
    const x0 = Math.max(0, tx - P);
    const y0 = Math.max(0, ty - P);
    const x1 = Math.min(W, tx + T + P);
    const y1 = Math.min(H, ty + T + P);
    const tile = src.getImageData(x0, y0, x1 - x0, y1 - y0);
    const y = tf.tidy(() => {
      const t = tf.browser.fromPixels(tile).toFloat().expandDims(0);
      return model.predict(t).squeeze().clipByValue(0, 255);
    });
    const data = await y.data();
    const [oh, ow] = y.shape;
    y.dispose();
    // 겹친 가장자리는 버리고 가운데만
    const cw = Math.min(T, W - tx) * 2;
    const ch = Math.min(T, H - ty) * 2;
    const ox = (tx - x0) * 2;
    const oy = (ty - y0) * 2;
    const img = new ImageData(cw, ch);
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const s = ((oy + yy) * ow + ox + xx) * 3;
        const d = (yy * cw + xx) * 4;
        img.data[d] = data[s];
        img.data[d + 1] = data[s + 1];
        img.data[d + 2] = data[s + 2];
        img.data[d + 3] = 255;
      }
    }
    octx.putImageData(img, tx * 2, ty * 2);
    done++;
    onProgress(done / tiles.length);
    if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    if (oh < ch) break; // 예상과 다른 결과면 중단 (안전장치)
  }
  sharpen(out, 0.55);
  return out;
}

/** 가벼운 선명하게 (언샤프 마스크, 3×3): 키운 뒤 윤곽을 또렷하게 */
function sharpen(canvas, amount) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c;
        const blur = (src[k] * 4 + (src[k - 4] + src[k + 4] + src[k - w * 4] + src[k + w * 4]) * 2
          + src[k - w * 4 - 4] + src[k - w * 4 + 4] + src[k + w * 4 - 4] + src[k + w * 4 + 4]) / 16;
        d[k] = src[k] + (src[k] - blur) * amount;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
