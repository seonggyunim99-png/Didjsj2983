// GPU(WebGL2) 보정 엔진. 슬라이더를 움직이는 즉시 결과를 보여주고, 원본 해상도 저장도 빠르게 처리합니다.
// WebGL2를 쓸 수 없는 오래된 기기에서는 기존(CPU) 방식으로 기본 보정만 적용합니다.
import * as dv from './develop.js';
import * as im from './imaging.js';
import { buildWarps, buildMasks } from './face.js';
import { WarpField, LocalMask, OpCache } from './retouch.js';

/* ---------- 셰이더 ---------- */

const VS = `#version 300 es
layout(location = 0) in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// 1) 자르기·회전·원근: 출력 픽셀마다 원본의 어느 위치인지 역행렬로 계산 (밉맵으로 축소 품질 확보)
const FS_GEO = `${HEAD}
uniform sampler2D uSrc;
uniform mat3 uInv;
uniform vec2 uSrcSize;
uniform vec2 uOut;
// 얼굴형 다듬기: a = (x, y, 반지름, 종류 0 확대·1 밀기), b = (밀기 x, y, 확대 세기) — 긴 변 기준 단위
uniform int uOpN;
uniform sampler2D uLiq; // 손으로 다듬은 변형 지도 (긴 변 = 1 단위)
uniform int uHasLiq;
uniform vec4 uOpA[40];
uniform vec4 uOpB[40];
vec2 warp(vec2 q) {
  vec2 p = q;
  for (int i = 0; i < 40; i++) {
    if (i >= uOpN) break;
    vec4 a = uOpA[i];
    vec2 d = q - a.xy;
    float dist = length(d);
    if (dist >= a.z) continue;
    float t = dist / a.z;
    float w = 1.0 - t * t;
    if (a.w < 0.5) p -= d * (uOpB[i].z * w);
    else p -= uOpB[i].xy * (w * w);
  }
  return p;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);
  vec3 s = uInv * vec3(p, 1.0);
  vec2 sp = s.xy / s.z;
  float M = max(uSrcSize.x, uSrcSize.y);
  if (uHasLiq == 1) sp += texture(uLiq, sp / uSrcSize).rg * M;
  if (uOpN > 0) sp = warp(sp / M) * M;
  vec2 uv = sp / uSrcSize;
  vec4 c = texture(uSrc, uv);
  if (uv.x < -0.002 || uv.y < -0.002 || uv.x > 1.002 || uv.y > 1.002) c = vec4(0.0);
  o = c;
}`;

// 2) 1/4 크기 밝기 지도: R = 밝기, G = 가장 어두운 채널(안개 제거용)
const FS_LUMMIN = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uOut;
void main() {
  vec3 c = texture(uTex, gl_FragCoord.xy / uOut).rgb;
  o = vec4(luma(c), min(c.r, min(c.g, c.b)), 0.0, 1.0);
}`;

// 4×4 평균으로 줄이기
const FS_DOWN = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uOut;
uniform vec2 uIn;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 t = 1.0 / uIn;
  o = (texture(uTex, uv + vec2(-1.0, -1.0) * t) + texture(uTex, uv + vec2(1.0, -1.0) * t)
     + texture(uTex, uv + vec2(-1.0, 1.0) * t) + texture(uTex, uv + vec2(1.0, 1.0) * t)) * 0.25;
}`;

// 밉맵을 이용해 원하는 크기로 줄이기
const FS_RESAMPLE = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uOut;
void main() { o = texture(uTex, gl_FragCoord.xy / uOut); }`;

const FS_BLUR = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uOut;
uniform vec2 uDir;
uniform float uSigma;
uniform float uRange; // 0이면 일반 블러, 0보다 크면 밝기 차이가 큰 경계를 넘지 않는 블러(후광 방지)
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  float r = ceil(uSigma * 2.5);
  float stp = max(1.0, ceil(r / 40.0)); // 반경이 크면 건너뛰며 샘플
  vec4 c0 = texture(uTex, uv);
  vec4 acc = c0;
  float ws = 1.0;
  float k = uRange > 0.0 ? 1.0 / (2.0 * uRange * uRange) : 0.0;
  for (int i = 1; i <= 40; i++) {
    float fi = float(i) * stp;
    if (fi > r) break;
    float w = exp(-fi * fi / (2.0 * uSigma * uSigma));
    vec4 a = texture(uTex, uv + uDir * fi);
    vec4 b = texture(uTex, uv - uDir * fi);
    float wa = w * exp(-(a.r - c0.r) * (a.r - c0.r) * k);
    float wb = w * exp(-(b.r - c0.r) * (b.r - c0.r) * k);
    acc += a * wa + b * wb;
    ws += wa + wb;
  }
  o = acc / ws;
}`;

// 피부 보정용: 경계는 살리고 피부 결만 부드럽게 (양방향 필터)
const FS_BILATERAL = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uOut;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 px = 1.0 / uOut;
  vec3 c = texture(uTex, uv).rgb;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int y = -5; y <= 5; y++) {
    for (int x = -5; x <= 5; x++) {
      vec3 s = texture(uTex, uv + vec2(float(x), float(y)) * px).rgb;
      vec3 d = s - c;
      float w = exp(-float(x * x + y * y) / 18.0 - dot(d, d) / 0.0128);
      acc += s * w;
      ws += w;
    }
  }
  o = vec4(acc / ws, 1.0);
}`;

// 3) 최종 현상
const FS_DEVELOP = `${HEAD}
uniform sampler2D uImg;
uniform sampler2D uBL;
uniform sampler2D uBM;
uniform sampler2D uSB;
uniform sampler2D uSG;
uniform sampler2D uNC;
uniform sampler2D uMK1;
uniform sampler2D uMK2;
uniform sampler2D uLM;
uniform sampler2D uLut;
uniform vec2 uOut;
uniform vec3 uWB;
uniform float uExp, uContrast, uHigh, uShadow, uWhites, uBlacks, uBright;
uniform float uClarity, uTexture, uDehaze, uVib, uSat, uFade, uVig, uGrain, uSharp, uNoise, uSkin, uSkinTone, uSeed;
uniform vec3 uHsl[8];
uniform vec3 uGS, uGM, uGH;
uniform float uBal;
uniform int uHasHsl, uHasSkin, uHasNC, uHasFace, uHasLM, uShowLM;
uniform float uDark, uBlush, uLips, uTeeth, uEyeB;

vec3 toLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 toGam(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
float toLin1(float v) { return pow(max(v, 0.0), 2.2); }
float toGam1(float v) { return pow(max(v, 0.0), 1.0 / 2.2); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float skinMask(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  float m = smoothstep(0.28, 0.34, cb) * (1.0 - smoothstep(0.47, 0.53, cb))
          * smoothstep(0.51, 0.56, cr) * (1.0 - smoothstep(0.66, 0.71, cr));
  return m * smoothstep(0.10, 0.22, y);
}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
const float HC[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 px = 1.0 / uOut;
  vec4 src = texture(uImg, uv);
  vec3 c = src.rgb;

  // 작은 디테일 (텍스처 · 선명하게)
  vec3 n3 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) n3 += texture(uImg, uv + vec2(float(x), float(y)) * px).rgb;
  float dSmall = luma(c) - luma(n3 / 9.0);

  // 노이즈 감소: 밝기 노이즈는 경계를 지키며 정리하고, 색 노이즈(얼룩덜룩한 색점)는 따로 없앰
  if (uNoise > 0.0) {
    vec3 acc = vec3(0.0);
    float ws = 0.0;
    float sr = 0.04 + uNoise * 0.16;
    for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
      vec3 s = texture(uImg, uv + vec2(float(x), float(y)) * px).rgb;
      float d = luma(s) - luma(c);
      float w = exp(-float(x * x + y * y) / 8.0 - d * d / (2.0 * sr * sr));
      acc += s * w;
      ws += w;
    }
    vec3 dn = mix(c, acc / ws, min(1.0, uNoise * 1.2));
    float Y = luma(dn);
    vec3 chroma = dn - Y;
    if (uHasNC == 1) {
      vec3 nc = texture(uNC, uv).rgb;
      chroma = mix(chroma, nc - luma(nc), min(1.0, uNoise * 1.6));
    }
    c = Y + chroma;
    dSmall *= 1.0 - uNoise * 0.8;
  }

  // 부분 보정 브러시: x 밝기 · y 채도 · z 색온도 · w 디테일(+ 선명, - 매끄럽게)
  vec4 lm = vec4(0.0);
  if (uHasLM == 1) lm = clamp((texture(uLM, uv) * 255.0 - 128.0) / 127.0, -1.0, 1.0);

  // 얼굴 부위 영역 (얼굴 인식이 있을 때)
  vec4 k1 = vec4(0.0);
  vec4 k2 = vec4(0.0);
  if (uHasFace == 1) {
    k1 = texture(uMK1, uv);
    k2 = texture(uMK2, uv);
  }

  // 피부: 결(잔디테일)은 조금 남기고 잡티와 얼룩만 부드럽게
  if (uHasSkin == 1) {
    vec3 sb = texture(uSB, uv).rgb;
    vec3 sg = texture(uSG, uv).rgb;
    float m = skinMask(sb);
    if (uHasFace == 1) m = k1.r * (0.35 + 0.65 * m); // 얼굴 피부 영역 위주
    c = mix(c, sb + (c - sg) * 0.3, m * uSkin);
    c = mix(c, c + (vec3(1.0) - c) * vec3(0.16, 0.13, 0.12) * uSkinTone, m);
    dSmall *= 1.0 - m * uSkin * 0.7;
  }
  if (lm.w < -0.004) {
    vec3 sb = texture(uSB, uv).rgb;
    vec3 sg = texture(uSG, uv).rgb;
    float k = min(1.0, -lm.w);
    c = mix(c, sb + (c - sg) * 0.25, k);
    dSmall *= 1.0 - k * 0.8;
  }

  // 뷰티: 다크서클 · 볼 혈색 · 입술 · 치아 · 눈
  if (uHasFace == 1) {
    vec3 lifted = c + (1.0 - c) * vec3(0.17, 0.15, 0.14);
    lifted = mix(vec3(luma(lifted)), lifted, 0.85);
    c = mix(c, lifted, k1.a * uDark * 0.9);
    c = mix(c, c * vec3(1.04, 0.91, 0.93) + vec3(0.015, 0.0, 0.008), k2.r * uBlush * 0.65);
    vec3 lip = c * vec3(1.1, 0.8, 0.88);
    lip = luma(lip) + (lip - luma(lip)) * 1.3;
    c = mix(c, lip, k1.g * uLips * 0.7);
    float tm = k1.b * uTeeth * smoothstep(0.28, 0.5, luma(c));
    c = mix(c, vec3(luma(c)) * 1.06 + vec3(0.0, 0.003, 0.012), tm * 0.75);
    c += k2.g * uEyeB * (dSmall * 1.8 + 0.035);
  }

  // 화이트밸런스 · 노출 (빛의 세기 그대로인 선형 공간에서)
  float gainE = exp2(uExp + lm.x * 1.0);
  vec3 lw = exp2(vec3(0.45, 0.0, -0.45) * lm.z);
  lw /= dot(lw, vec3(0.2126, 0.7152, 0.0722));
  c = toGam(toLin(c) * uWB * lw * gainE);
  if (lm.x > 0.0) c += (1.0 - c) * (1.0 - c) * lm.x * 0.07; // 밝게: 아주 어두운 곳도 살짝 들어 올림
  vec2 bl = texture(uBL, uv).rg;
  float Lb = toGam1(toLin1(bl.r) * gainE);
  float Lm = toGam1(toLin1(texture(uBM, uv).r) * gainE);

  // 안개 제거 (가장 어두운 채널로 뿌연 정도를 추정)
  if (uDehaze > 0.0) {
    float dark = clamp(toGam1(toLin1(bl.g) * gainE), 0.0, 1.0);
    float A = 0.95;
    float t = max(0.25, 1.0 - uDehaze * 0.9 * dark);
    c = (c - A * (1.0 - t)) / t;
    Lb = (Lb - A * (1.0 - t)) / t;
    Lm = (Lm - A * (1.0 - t)) / t;
  } else if (uDehaze < 0.0) {
    float k = -uDehaze * 0.35;
    c = mix(c, vec3(0.82), k);
    Lb = mix(Lb, 0.82, k);
    Lm = mix(Lm, 0.82, k);
  }

  // 부분 밝기: 주변 밝기(흐린 지도)를 보고 어두운 곳·밝은 곳만 조절 → 디테일 유지
  float L = max(luma(c), 1e-4);
  float lb = clamp(mix(clamp(L, 0.0, 1.0), Lb, 0.75), 0.0, 1.0);
  float L2 = L;
  float wS = (1.0 - lb) * (1.0 - lb) * smoothstep(0.015, 0.2, lb);
  L2 += uShadow * (uShadow > 0.0 ? 0.55 : 0.35) * wS;
  L2 += uHigh * 0.45 * pow(lb, 2.2);
  float mid = 1.0 - pow(abs(2.0 * clamp(L, 0.0, 1.0) - 1.0), 2.0);
  L2 += uClarity * 0.85 * (L - Lm) * mid;
  L2 += uTexture * 1.4 * dSmall * mid;
  L2 = max(L2, 0.0);
  // 밝기 변화 적용: 색 비율 유지(채도 증가)와 고르게 더하기(채도 감소)의 중간 → 색이 과해지지 않게
  vec3 cr = toGam(toLin(c) * clamp(toLin1(L2) / toLin1(L), 0.0, 6.0));
  vec3 ca = c + (L2 - L);
  c = mix(ca, mix(ca, cr, 0.45), smoothstep(0.02, 0.08, L));
  // 한 채널만 넘쳐서 색이 틀어지지 않게 부드럽게 눌러 줌
  float mxc = max(c.r, max(c.g, c.b));
  if (mxc > 1.0) c = luma(c) + (c - luma(c)) * clamp((1.0 - min(luma(c), 0.999)) / max(mxc - min(luma(c), 0.999), 1e-4), 0.0, 1.0);

  // 대비(S 커브) · 흰색/검정 계열 · 밝기(중간 톤)
  c = clamp(c, 0.0, 1.0);
  if (uContrast > 0.0) c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  else c = mix(c, 0.5 + (c - 0.5) * 0.55, -uContrast);
  c += uWhites * 0.2 * c * c * c;
  c = clamp(c, 0.0, 1.0);
  vec3 ic = 1.0 - c;
  c += uBlacks * 0.16 * ic * ic * ic * ic;
  c = clamp(c, 0.0, 1.0);
  if (uBright != 0.0) {
    float g = uBright > 0.0 ? 1.0 / (1.0 + uBright * 0.9) : 1.0 - uBright * 0.9;
    c = pow(c, vec3(g));
  }

  // 톤 커브
  c = vec3(texture(uLut, vec2(c.r * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).r,
           texture(uLut, vec2(c.g * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).g,
           texture(uLut, vec2(c.b * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).b);

  // 색상별 조정 (8가지 색)
  if (uHasHsl == 1) {
    vec3 hsv = rgb2hsv(c);
    float hd = hsv.x * 360.0;
    vec3 a = uHsl[0];
    for (int i = 0; i < 8; i++) {
      if (hd >= HC[i] && hd < HC[i + 1]) a = mix(uHsl[i], uHsl[(i + 1) % 8], (hd - HC[i]) / (HC[i + 1] - HC[i]));
    }
    float w = smoothstep(0.03, 0.2, hsv.y);
    hsv.x = fract(hsv.x + a.x * w * (30.0 / 360.0) + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + a.y * w), 0.0, 1.0);
    c = hsv2rgb(hsv);
    c *= 1.0 + a.z * 0.5 * w * hsv.y;
  }

  // 생동감 · 채도 (생동감은 이미 진한 색과 피부색은 덜 건드림)
  float l2 = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float f = (1.0 + uSat) * max(0.0, 1.0 + lm.y * 0.9);
  if (uVib > 0.0) f *= 1.0 + uVib * (1.0 - sat) * 1.1 * (1.0 - 0.5 * skinMask(c));
  else f *= 1.0 + uVib;
  c = l2 + (c - l2) * f;

  // 컬러 그레이딩 (그림자 · 중간 톤 · 하이라이트)
  float lg = clamp(luma(c), 0.0, 1.0);
  float pivot = 0.5 + uBal * 0.3;
  float ws = 1.0 - smoothstep(0.0, pivot, lg);
  float wh = smoothstep(pivot, 1.0, lg);
  float wm = clamp(1.0 - ws - wh, 0.0, 1.0);
  c += uGS * ws + uGM * wm + uGH * wh;

  // 페이드
  c = c * (1.0 - uFade * 0.22) + uFade * 0.1;

  // 선명하게 (평평한 곳의 잡음은 키우지 않음)
  c += (uSharp + max(lm.w, 0.0) * 0.9) * 1.7 * dSmall * smoothstep(0.002, 0.012, abs(dSmall));

  // 비네팅
  vec2 dv = (uv - 0.5) * 2.0 * uOut / max(uOut.x, uOut.y);
  float vm = smoothstep(0.35, 1.25, length(dv));
  if (uVig < 0.0) c *= 1.0 + uVig * 0.85 * vm;
  else c = mix(c, vec3(1.0), uVig * 0.55 * vm);

  // 그레인 (해상도와 관계없이 같은 크기로 보이게)
  if (uGrain > 0.0) {
    float gs = max(1.0, uOut.y / 900.0);
    vec2 gp = gl_FragCoord.xy / gs;
    float nz = vnoise(gp + uSeed) * 0.6 + hash(gp + uSeed * 1.7) * 0.4 - 0.5;
    c += nz * uGrain * 0.16 * (1.0 - 0.6 * abs(2.0 * luma(c) - 1.0));
  }

  // 칠한 영역 보기
  if (uShowLM == 1) {
    float e = clamp(max(max(abs(lm.x), abs(lm.y)), max(abs(lm.z), abs(lm.w))) * 1.6, 0.0, 1.0);
    c = mix(c, vec3(1.0, 0.18, 0.32), e * 0.5);
  }

  o = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

/* ---------- GPU 렌더러 ---------- */

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  return s;
}

function makeProgram(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
  const locs = {};
  return { p, u: (name) => (name in locs ? locs[name] : (locs[name] = gl.getUniformLocation(p, name))) };
}

const transpose3 = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export class GLRenderer {
  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2를 쓸 수 없어요');
    this.gpu = true;
    this.canvas = canvas;
    this.gl = gl;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 8192);
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.prog = {
      geo: makeProgram(gl, FS_GEO),
      lummin: makeProgram(gl, FS_LUMMIN),
      down: makeProgram(gl, FS_DOWN),
      resample: makeProgram(gl, FS_RESAMPLE),
      blur: makeProgram(gl, FS_BLUR),
      bilateral: makeProgram(gl, FS_BILATERAL),
      develop: makeProgram(gl, FS_DEVELOP),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.targets = {};
    this.lutTex = this.texture(256, 1, false);
    this.dummy = this.texture(1, 1, false);
  }

  texture(w, h, float, mip = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const useF = float && this.float;
    gl.texImage2D(gl.TEXTURE_2D, 0, useF ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  target(name, w, h, float = false, mip = false) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (t) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    const tex = this.texture(w, h, float, mip);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fbo, w, h };
    this.targets[name] = t;
    return t;
  }

  /** 큰 해상도로 저장한 뒤 메모리를 돌려줍니다. */
  trim() {
    const gl = this.gl;
    for (const t of Object.values(this.targets)) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = {};
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  /** @param src 이미지·캔버스·ImageBitmap,  W/H 논리 크기(편집 좌표 기준) */
  setSource(src, W, H) {
    const gl = this.gl;
    let img = src;
    const [w0, h0] = im.dimsOf(src);
    if (Math.max(w0, h0) > this.maxTex) {
      const k = this.maxTex / Math.max(w0, h0);
      img = im.makeCanvas(w0 * k, h0 * k);
      img.getContext('2d').drawImage(src, 0, 0, img.width, img.height);
    }
    if (!this.srcTex) this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.W = W || w0;
    this.H = H || h0;
  }

  pass(prog, target, w, h, tex = {}, set = () => {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, t] of Object.entries(tex)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(prog.u(name), unit);
      unit++;
    }
    gl.uniform2f(prog.u('uOut'), w, h);
    set(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  blur(src, tmp, dst, sigma, range = 0) {
    const gl = this.gl;
    const b = this.prog.blur;
    this.pass(b, tmp, tmp.w, tmp.h, { uTex: src.tex }, (p) => {
      gl.uniform2f(p.u('uDir'), 1 / src.w, 0);
      gl.uniform1f(p.u('uSigma'), sigma);
      gl.uniform1f(p.u('uRange'), range);
    });
    this.pass(b, dst, dst.w, dst.h, { uTex: tmp.tex }, (p) => {
      gl.uniform2f(p.u('uDir'), 0, 1 / tmp.h);
      gl.uniform1f(p.u('uSigma'), sigma);
      gl.uniform1f(p.u('uRange'), range);
    });
  }

  /**
   * 보정한 결과를 this.canvas(outW×outH)에 그립니다.
   * @returns {{canvas:HTMLCanvasElement, matrix:number[]}}
   */
  render(st, { region, outW, outH, outScale }) {
    if (this.lost) throw new Error('GPU 연결이 끊겼어요');
    const gl = this.gl;
    outW = Math.max(1, Math.min(this.maxTex, Math.round(outW)));
    outH = Math.max(1, Math.min(this.maxTex, Math.round(outH)));
    const P = dv.finalParams(st);
    const a = P.adj;
    const M = dv.geoMatrix3(this.W, this.H, st.geo, region, outScale);
    const inv = dv.inv3(M);

    // 1) 기하 변환 (+ 얼굴형 다듬기)
    const faces = this.faces?.length ? this.faces : null;
    const warps = faces ? buildWarps(faces, a, this.W, this.H) : { n: 0 };
    this.lastWarps = warps;
    const liq = this.syncLiquify(st.liquify);
    const geoTex = (src) => ({ uSrc: src, uLiq: liq ? this.liqTex : this.dummy });
    const geoSet = (p) => {
      gl.uniform1i(p.u('uHasLiq'), liq ? 1 : 0);
      gl.uniformMatrix3fv(p.u('uInv'), false, transpose3(inv));
      gl.uniform2f(p.u('uSrcSize'), this.W, this.H);
      gl.uniform1i(p.u('uOpN'), warps.n);
      if (warps.n) {
        gl.uniform4fv(p.u('uOpA[0]'), warps.a);
        gl.uniform4fv(p.u('uOpB[0]'), warps.b);
      }
    };
    const A = this.target('A', outW, outH, false, true);
    this.pass(this.prog.geo, A, outW, outH, geoTex(this.srcTex), geoSet);
    // 얼굴 부위 영역도 같은 변형으로
    const beauty = ['skinSmooth', 'skinTone', 'darkCircle', 'blush', 'lips', 'teeth', 'eyeBright'].some((k) => a[k] > 0);
    let MK1 = null;
    let MK2 = null;
    if (faces && beauty) {
      this.ensureMasks();
      MK1 = this.target('MK1', outW, outH, false);
      this.pass(this.prog.geo, MK1, outW, outH, geoTex(this.mk1Tex), geoSet);
      MK2 = this.target('MK2', outW, outH, false);
      this.pass(this.prog.geo, MK2, outW, outH, geoTex(this.mk2Tex), geoSet);
    }
    // 부분 보정 영역도 같은 변형으로
    const local = this.syncLocal(st.local);
    let LM = null;
    if (local) {
      LM = this.target('LM', outW, outH, false);
      this.pass(this.prog.geo, LM, outW, outH, geoTex(this.lmTex), geoSet);
    }
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2) 밝기 지도 (중간 범위 · 넓은 범위)
    const qw = Math.max(1, Math.round(outW / 4));
    const qh = Math.max(1, Math.round(outH / 4));
    const Q4 = this.target('Q4', qw, qh, true);
    this.pass(this.prog.lummin, Q4, qw, qh, { uTex: A.tex });
    // 넓은 범위 지도도 1/4 크기에서 (경계를 지키는 블러가 촘촘해야 경계선 얼룩이 생기지 않음)
    const m = Math.min(outW, outH);
    const BM = this.target('BM', qw, qh, true);
    this.blur(Q4, this.target('T4', qw, qh, true), BM, Math.max(0.7, m / 110 / 4), 0.14);
    const BL = this.target('BL', qw, qh, true);
    this.blur(Q4, this.target('T4', qw, qh, true), BL, Math.max(0.7, m / 28 / 4), 0.1);

    // 3) 피부 보정용 (해상도와 관계없이 512px 기준으로 계산해서 미리보기와 저장 결과가 같게)
    const skin = a.skinSmooth > 0 || a.skinTone > 0;
    const localSmooth = !!local && st.local.some((o) => o.t === 'smooth' || o.t === 'erase');
    let SB = null;
    let SG = null;
    if (skin || localSmooth) {
      const k = Math.min(1, 512 / Math.max(outW, outH));
      const kw = Math.max(1, Math.round(outW * k));
      const kh = Math.max(1, Math.round(outH * k));
      const K0 = this.target('K0', kw, kh, false);
      this.pass(this.prog.resample, K0, kw, kh, { uTex: A.tex });
      SB = this.target('SB', kw, kh, false);
      this.pass(this.prog.bilateral, SB, kw, kh, { uTex: K0.tex });
      SG = this.target('SG', kw, kh, false);
      this.blur(K0, this.target('KT', kw, kh, false), SG, 3);
    }

    // 3-2) 색 노이즈 감소용: 1024px 기준의 부드러운 색
    let NC = null;
    if (a.noise > 0) {
      const k = Math.min(1, 1024 / Math.max(outW, outH));
      const nw = Math.max(1, Math.round(outW * k));
      const nh = Math.max(1, Math.round(outH * k));
      const C0 = this.target('C0', nw, nh, false);
      this.pass(this.prog.resample, C0, nw, nh, { uTex: A.tex });
      NC = this.target('NC', nw, nh, false);
      this.blur(C0, this.target('CT', nw, nh, false), NC, 1.5 + (a.noise / 100) * 2);
    }

    // 4) 톤 커브 표
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, P.lut);

    // 5) 최종 현상 → 화면용 캔버스
    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== outH) this.canvas.height = outH;
    const hsl = new Float32Array(24);
    P.hsl.forEach((v, i) => hsl.set(v, i * 3));
    const hasHsl = P.hsl.some((v) => v.some((x) => x));
    const wb = dv.wbGains(a.temp, a.tint);
    this.pass(this.prog.develop, null, outW, outH, {
      uImg: A.tex, uBL: BL.tex, uBM: BM.tex, uSB: SB ? SB.tex : this.dummy, uSG: SG ? SG.tex : this.dummy, uNC: NC ? NC.tex : this.dummy, uMK1: MK1 ? MK1.tex : this.dummy, uMK2: MK2 ? MK2.tex : this.dummy, uLM: LM ? LM.tex : this.dummy, uLut: this.lutTex,
    }, (p) => {
      const f = (n, v) => gl.uniform1f(p.u(n), v);
      gl.uniform3f(p.u('uWB'), ...wb);
      f('uExp', a.exposure / 50);
      f('uContrast', a.contrast / 100);
      f('uHigh', a.highlights / 100);
      f('uShadow', a.shadows / 100);
      f('uWhites', a.whites / 100);
      f('uBlacks', a.blacks / 100);
      f('uBright', a.brightness / 100);
      f('uClarity', a.clarity / 100);
      f('uTexture', a.texture / 100);
      f('uDehaze', a.dehaze / 100);
      f('uVib', a.vibrance / 100);
      f('uSat', a.saturation / 100);
      f('uFade', a.fade / 100);
      f('uVig', a.vignette / 100);
      f('uGrain', a.grain / 100);
      f('uSharp', a.sharpness / 100);
      f('uNoise', a.noise / 100);
      f('uSkin', a.skinSmooth / 100);
      f('uSkinTone', a.skinTone / 100);
      f('uSeed', 7.31);
      f('uBal', P.balance);
      gl.uniform3fv(p.u('uHsl[0]'), hsl);
      gl.uniform3f(p.u('uGS'), ...P.grade.shadows);
      gl.uniform3f(p.u('uGM'), ...P.grade.mids);
      gl.uniform3f(p.u('uGH'), ...P.grade.highs);
      gl.uniform1i(p.u('uHasHsl'), hasHsl ? 1 : 0);
      gl.uniform1i(p.u('uHasSkin'), skin ? 1 : 0);
      gl.uniform1i(p.u('uHasNC'), NC ? 1 : 0);
      gl.uniform1i(p.u('uHasFace'), MK1 ? 1 : 0);
      gl.uniform1i(p.u('uHasLM'), LM ? 1 : 0);
      gl.uniform1i(p.u('uShowLM'), LM && this.showLocal ? 1 : 0);
      f('uDark', a.darkCircle / 100);
      f('uBlush', a.blush / 100);
      f('uLips', a.lips / 100);
      f('uTeeth', a.teeth / 100);
      f('uEyeB', a.eyeBright / 100);
    });
    return { canvas: this.canvas, matrix: M };
  }

  /** 손으로 다듬은 변형 지도를 최신으로 (그리는 중에는 새로 그은 부분만 계산) */
  syncLiquify(ops) {
    if (!this.liqCache) this.liqCache = new OpCache((W, H) => new WarpField(W, H));
    const f = this.liqCache.sync(ops, this.W, this.H);
    if (!f) return null;
    const gl = this.gl;
    if (this.liqCache.changed || !this.liqTex || this.liqObj !== f) {
      let full = this.liqCache.rebuilt || this.liqObj !== f;
      if (!this.liqTex || this.liqDims !== `${f.fw}x${f.fh}`) {
        full = true;
        if (this.liqTex) gl.deleteTexture(this.liqTex);
        this.liqTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.liqTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16F, f.fw, f.fh);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.liqDims = `${f.fw}x${f.fh}`;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.liqTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      // 그리는 중에는 바뀐 줄만 올림
      const rows = f.takeRows();
      const [y0, y1] = full || !rows ? [0, f.fh - 1] : rows;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, f.fw, y1 - y0 + 1, gl.RG, gl.FLOAT, f.data().subarray(y0 * f.fw * 2, (y1 + 1) * f.fw * 2));
      this.liqObj = f;
    }
    return f;
  }

  syncLocal(ops) {
    if (!this.lmCache) this.lmCache = new OpCache((W, H) => new LocalMask(W, H));
    const m = this.lmCache.sync(ops, this.W, this.H);
    if (!m) return null;
    const gl = this.gl;
    if (this.lmCache.changed || !this.lmTex || this.lmObj !== m) {
      let full = this.lmCache.rebuilt || this.lmObj !== m;
      if (!this.lmTex || this.lmDims !== `${m.fw}x${m.fh}`) {
        full = true;
        if (this.lmTex) gl.deleteTexture(this.lmTex);
        this.lmTex = this.texture(m.fw, m.fh, false);
        this.lmDims = `${m.fw}x${m.fh}`;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.lmTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const rows = m.takeRows();
      const [y0, y1] = full || !rows ? [0, m.fh - 1] : rows;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, m.fw, y1 - y0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, m.data().subarray(y0 * m.fw * 4, (y1 + 1) * m.fw * 4));
      this.lmObj = m;
    }
    return m;
  }

  /**
   * 화면에서 누른 곳(원본 비율 좌표, 변형 전)이 실제 원본의 어디인지 (손 변형 · 얼굴형 다듬기 반영)
   * 부분 보정·잡티 제거가 보이는 그대로의 자리에 칠해지도록 씀
   */
  warpPoint(nx, ny) {
    const M = Math.max(this.W, this.H);
    let x = (nx * this.W) / M;
    let y = (ny * this.H) / M;
    const f = this.liqCache?.obj;
    if (f && !f.empty) {
      const [dx, dy] = f.sample(x, y);
      x += dx;
      y += dy;
    }
    const w = this.lastWarps;
    if (w?.n) {
      let px = x;
      let py = y;
      for (let i = 0; i < w.n; i++) {
        const ax = w.a[i * 4];
        const ay = w.a[i * 4 + 1];
        const r = w.a[i * 4 + 2];
        const dx = x - ax;
        const dy = y - ay;
        const dist = Math.hypot(dx, dy);
        if (dist >= r) continue;
        const t = dist / r;
        const k = 1 - t * t;
        if (w.a[i * 4 + 3] < 0.5) {
          px -= dx * w.b[i * 4 + 2] * k;
          py -= dy * w.b[i * 4 + 2] * k;
        } else {
          px -= w.b[i * 4] * k * k;
          py -= w.b[i * 4 + 1] * k * k;
        }
      }
      x = px;
      y = py;
    }
    return [(x * M) / this.W, (y * M) / this.H];
  }

  /** 얼굴 인식 결과(비율 좌표)를 알려 줍니다. null이면 얼굴 없음 */
  setFaces(faces) {
    this.faces = faces && faces.length ? faces : null;
    this.maskKey = null;
  }

  ensureMasks() {
    const k = 1024 / Math.max(this.W, this.H);
    const w = Math.max(2, Math.round(this.W * k));
    const h = Math.max(2, Math.round(this.H * k));
    const key = `${w}x${h}`;
    if (this.maskKey === key) return;
    const { m1, m2 } = buildMasks(this.faces, w, h);
    const gl = this.gl;
    for (const [name, data] of [['mk1Tex', m1], ['mk2Tex', m2]]) {
      if (!this[name]) this[name] = this.texture(w, h, false);
      gl.bindTexture(gl.TEXTURE_2D, this[name]);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    this.maskKey = key;
  }

  dispose() {
    this.trim();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/* ---------- WebGL2가 없을 때: 기존 CPU 방식 (기본 보정만) ---------- */

function toLegacy(st) {
  const a = dv.finalParams(st).adj;
  const legacy = im.defaultState();
  legacy.geo = { ...st.geo, crop: { ...st.geo.crop } };
  Object.assign(legacy.adj, {
    brightness: a.brightness + a.exposure * 0.6,
    contrast: a.contrast,
    highlights: a.highlights,
    shadows: a.shadows,
    saturation: a.saturation,
    vibrance: a.vibrance,
    warmth: a.temp,
    tint: a.tint,
    clarity: a.clarity,
    sharpness: a.sharpness,
    vignette: Math.max(0, -a.vignette),
    fade: a.fade,
  });
  for (const k of Object.keys(legacy.adj)) legacy.adj[k] = Math.max(-100, Math.min(100, legacy.adj[k]));
  return legacy;
}

class CPURenderer {
  constructor() {
    this.gpu = false;
    this.lost = false;
    this.maxTex = 8192;
  }

  setSource(src, W, H) {
    const [w0, h0] = im.dimsOf(src);
    this.src = src;
    this.W = W || w0;
    this.H = H || h0;
  }

  render(st, { region, outW, outH, outScale }) {
    const legacy = toLegacy(st);
    this.canvas = im.renderBase(this.src, this.W, this.H, legacy, region, outW, outH, outScale);
    return { canvas: this.canvas, matrix: dv.geoMatrix3(this.W, this.H, { ...st.geo, pv: 0, ph: 0 }, region, outScale) };
  }

  trim() {}

  setFaces() {}

  warpPoint(nx, ny) {
    return [nx, ny];
  }

  dispose() {}
}

export function createRenderer() {
  try {
    return new GLRenderer();
  } catch (err) {
    console.warn('GPU 보정을 쓸 수 없어 기본 보정으로 전환합니다', err);
    return new CPURenderer();
  }
}

let shared = null;
/** 여러 장 보정·미리보기에 같이 쓰는 렌더러 */
export function sharedRenderer() {
  if (!shared || shared.lost) shared = createRenderer();
  return shared;
}

/* ---------- 그리기 · 모자이크 (원근까지 반영해서 점 단위로 옮겨 그림) ---------- */

function tracePath(ctx, s, M, W, H) {
  const p = s.pts;
  ctx.beginPath();
  const [x0, y0] = dv.mapPoint(M, p[0] * W, p[1] * H);
  ctx.moveTo(x0, y0);
  if (p.length === 2) ctx.lineTo(x0 + 0.01, y0 + 0.01);
  for (let i = 2; i < p.length; i += 2) {
    const [x, y] = dv.mapPoint(M, p[i] * W, p[i + 1] * H);
    ctx.lineTo(x, y);
  }
}

export function drawStrokes(ctx, base, strokes, M, W, H) {
  if (!strokes.length) return;
  const outW = ctx.canvas.width;
  const outH = ctx.canvas.height;
  const unit = Math.max(W, H);
  const width = (s) => s.size * unit * dv.matrixScale(M, s.pts[0] * W, s.pts[1] * H);
  const mosaic = strokes.filter((s) => s.tool === 'mosaic');
  if (mosaic.length) {
    const block = Math.max(4, Math.round(Math.max(outW, outH) / 42));
    const sw = Math.ceil(outW / block);
    const sh = Math.ceil(outH / block);
    const small = im.makeCanvas(sw, sh);
    small.getContext('2d').drawImage(base, 0, 0, sw, sh);
    const pix = im.makeCanvas(outW, outH);
    const pc = pix.getContext('2d');
    pc.imageSmoothingEnabled = false;
    pc.drawImage(small, 0, 0, sw * block, sh * block);
    pc.globalCompositeOperation = 'destination-in';
    pc.lineCap = 'round';
    pc.lineJoin = 'round';
    pc.strokeStyle = '#000';
    for (const s of mosaic) {
      pc.lineWidth = width(s);
      tracePath(pc, s, M, W, H);
      pc.stroke();
    }
    ctx.drawImage(pix, 0, 0);
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.tool === 'mosaic') continue;
    ctx.globalAlpha = s.tool === 'marker' ? 0.42 : 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = width(s);
    tracePath(ctx, s, M, W, H);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- 측정 · 저장 ---------- */

/** 자동 보정 계산용: 자르기·회전만 적용한 작은 이미지를 측정 */
export function measure(renderer, st, region = st.geo.crop) {
  const neutral = { ...dv.defaultState(), geo: st.geo };
  const [fw, fh] = dv.frameDims(renderer.W, renderer.H, st.geo);
  const rw = region.w * fw;
  const rh = region.h * fh;
  const k = 320 / Math.max(rw, rh);
  const { canvas } = renderer.render(neutral, { region, outW: rw * k, outH: rh * k, outScale: k });
  const c = im.makeCanvas(canvas.width, canvas.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return im.analyze(ctx.getImageData(0, 0, c.width, c.height));
}

/**
 * 원본 해상도로 모든 보정을 적용한 2D 캔버스 (브라우저 한계를 넘지 않게 최대 픽셀 제한)
 * @param src 원본 이미지(잡티 제거는 미리 적용된 것)
 */
export function renderFinal(renderer, src, W, H, st, maxPixels = 16_000_000) {
  renderer.setSource(src, W, H);
  const show = renderer.showLocal;
  renderer.showLocal = false; // '칠한 곳 보기' 표시는 저장하지 않음
  const [fw, fh] = dv.frameDims(W, H, st.geo);
  const cw = st.geo.crop.w * fw;
  const ch = st.geo.crop.h * fh;
  let k = cw * ch > maxPixels ? Math.sqrt(maxPixels / (cw * ch)) : 1;
  k = Math.min(k, renderer.maxTex / Math.max(cw, ch));
  const { canvas, matrix } = renderer.render(st, { region: st.geo.crop, outW: cw * k, outH: ch * k, outScale: k });
  const out = im.makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawStrokes(ctx, canvas, st.strokes, matrix, W, H);
  renderer.trim();
  renderer.showLocal = show;
  return out;
}

/** 사진 한 장을 자동 보정한 새 파일 (여러 장 한꺼번에 보정할 때) */
export async function autoEnhanceBlob(blob, type, opts) {
  const src = await im.decode(blob);
  try {
    const [W, H] = im.dimsOf(src);
    const r = sharedRenderer();
    const st = dv.defaultState();
    r.setSource(src, W, H);
    Object.assign(st.adj, dv.autoAdjust(measure(r, st), opts).adj);
    return await im.canvasToBlob(renderFinal(r, src, W, H, st), type);
  } finally {
    src.close?.();
  }
}

/** 썸네일 크기 미리보기용 자동 보정 */
export function previewEnhance(source, opts) {
  const [W, H] = im.dimsOf(source);
  const r = sharedRenderer();
  r.setSource(source, W, H);
  const st = dv.defaultState();
  Object.assign(st.adj, dv.autoAdjust(measure(r, st), opts).adj);
  const k = Math.min(1, 240 / Math.max(W, H));
  const { canvas } = r.render(st, { region: dv.FULL, outW: W * k, outH: H * k, outScale: k });
  const out = im.makeCanvas(canvas.width, canvas.height);
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}
