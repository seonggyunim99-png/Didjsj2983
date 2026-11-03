// GPU(WebGL2) 보정 엔진. 슬라이더를 움직이는 즉시 결과를 보여주고, 원본 해상도 저장도 빠르게 처리합니다.
// WebGL2를 쓸 수 없는 오래된 기기에서는 기존(CPU) 방식으로 기본 보정만 적용합니다.
import * as dv from './develop.js';
import * as im from './imaging.js';
import { buildWarps, buildMasks, legMap, LIP_COLORS, BLUSH_COLORS, SHADOW_COLORS, detectFaces, detectPoses, segmentPerson } from './face.js';
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
uniform sampler2D uErase; // 보정 지우개 (화면에 보이는 자리 기준)
uniform int uHasErase;
uniform vec4 uOpA[64];
uniform vec4 uOpB[64];
uniform vec4 uLegO; // 다리 길게: 화면 쪽 구간 경계 (o1, o2, o3, H)
uniform vec4 uLegS; // 원본 쪽 구간 경계 (T, y0, y1, 켜짐)
vec2 warp(vec2 q) {
  vec2 p = q;
  for (int i = 0; i < 64; i++) {
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
float legMap(float y) {
  float o1 = uLegO.x, o2 = uLegO.y, o3 = uLegO.z, H = uLegO.w;
  float T = uLegS.x, y0 = uLegS.y, y1 = uLegS.z;
  if (y < o1) return o1 > 0.0 ? y * T / o1 : y;
  if (y < o2) return T + (y - o1);
  if (y < o3) return y0 + (y - o2) * (y1 - y0) / (o3 - o2);
  return H - o3 > 0.0 ? y1 + (y - o3) * (H - y1) / (H - o3) : y;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);
  vec3 s = uInv * vec3(p, 1.0);
  vec2 sp = s.xy / s.z;
  float M = max(uSrcSize.x, uSrcSize.y);
  vec2 sp0 = sp;
  if (uHasLiq == 1) sp += texture(uLiq, sp / uSrcSize).rg * M;
  if (uLegS.w > 0.5) sp.y = legMap(sp.y);
  if (uOpN > 0) sp = warp(sp / M) * M;
  if (uHasErase == 1) sp = mix(sp, sp0, clamp((texture(uErase, sp0 / uSrcSize).r * 255.0 - 128.0) / 127.0, 0.0, 1.0));
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

// 배경 흐림용: 사람 부분을 빼고(가중치 0) 배경 색만 남김 → 흐린 뒤 a로 나누면 사람 색이 번지지 않음
const FS_PREMUL = `${HEAD}
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform vec2 uOut;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  float w = 1.0 - smoothstep(0.15, 0.6, texture(uMask, uv).r);
  o = vec4(texture(uTex, uv).rgb * w, w);
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
uniform sampler2D uNC;
uniform sampler2D uMK1;
uniform sampler2D uMK2;
uniform sampler2D uLM;
uniform sampler2D uER;
uniform sampler2D uMK3; // 얼굴 번호
uniform sampler2D uPM; // 사람 영역
uniform sampler2D uBGB; // 흐린 배경 (사람 색 뺀 것)
uniform vec4 uFP[18]; // 얼굴마다 3개: (피부, 화사, 다크서클, 볼) (입술, 치아, 눈, 눈썹) (립, 블러셔, 섀도, -)
uniform vec3 uLipC, uBlushC, uShadowC;
uniform int uHasPM, uHasBGB;
uniform float uBgLight, uBgMono;
uniform sampler2D uLut;
uniform vec2 uOut;
uniform vec3 uWB;
uniform float uExp, uContrast, uHigh, uShadow, uWhites, uBlacks, uBright;
uniform float uClarity, uTexture, uDehaze, uVib, uSat, uFade, uVig, uGrain, uSharp, uNoise, uSkin, uSkinTone, uSeed;
uniform vec3 uHsl[8];
uniform vec3 uGS, uGM, uGH;
uniform float uBal;
uniform int uHasHsl, uHasSkin, uHasNC, uHasFace, uHasLM, uShowLM, uHasER;
uniform float uDark, uBlush, uLips, uTeeth, uEyeB;
float lumaS(vec3 c) { return max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.03); }

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
  float person = 1.0;
  if (uHasPM == 1) person = texture(uPM, uv).r;
  float sharpK = 1.0; // 흐린 배경에는 선명하게·결 살리기를 하지 않음
  if (uHasBGB == 1) {
    vec4 bb = texture(uBGB, uv);
    vec3 bg = bb.a > 0.02 ? bb.rgb / bb.a : c;
    float k = (1.0 - person) * smoothstep(0.0, 0.15, bb.a);
    c = mix(c, bg, k);
    sharpK = 1.0 - k;
  }

  // 작은 디테일 (텍스처 · 선명하게)
  vec3 n3 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) n3 += texture(uImg, uv + vec2(float(x), float(y)) * px).rgb;
  float dSmall = (luma(src.rgb) - luma(n3 / 9.0)) * sharpK;
  vec3 fine = (src.rgb - n3 / 9.0) * sharpK; // 아주 작은 결 (모공·피부결) — 피부 보정에서 남김

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
    vec3 dn = mix(c, acc / ws, min(1.0, uNoise * 1.2) * sharpK);
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
  // 보정 지우개: 문지른 곳은 인물·부분 보정을 빼고 원래대로
  float er = 0.0;
  if (uHasER == 1) er = clamp((texture(uER, uv).r * 255.0 - 128.0) / 127.0, 0.0, 1.0);
  lm *= 1.0 - er;

  // 얼굴 부위 영역 (얼굴 인식이 있을 때)
  vec4 k1 = vec4(0.0);
  vec4 k2 = vec4(0.0);
  vec4 F0 = vec4(0.0), F1 = vec4(0.0), F2 = vec4(0.0);
  if (uHasFace == 1) {
    k1 = texture(uMK1, uv) * (1.0 - er);
    k2 = texture(uMK2, uv) * (1.0 - er);
    int fi = int(floor(texture(uMK3, uv).r * 255.0 / 32.0 + 0.5)) - 1;
    if (fi >= 0 && fi < 6) {
      F0 = uFP[fi * 3];
      F1 = uFP[fi * 3 + 1];
      F2 = uFP[fi * 3 + 2];
    } else {
      k1 = vec4(0.0);
      k2 = vec4(0.0);
    }
  }

  // 피부 (주파수 분리): 얼룩·잡티(중간 크기)만 부드럽게 하고, 모공·피부결(아주 작은 결)은 원본 해상도 그대로 남김
  // → 확대해도 뭉개지거나 플라스틱처럼 보이지 않음
  vec3 n9 = n3 / 9.0;
  if (uHasSkin == 1) {
    vec3 sb = texture(uSB, uv).rgb;
    float m = skinMask(sb) * (1.0 - er);
    float sk = uSkin;
    float tone = uSkinTone;
    if (uHasFace == 1) {
      m = k1.r * (0.35 + 0.65 * skinMask(sb)); // 얼굴 피부 영역 위주 (지운 곳은 k1이 0)
      sk = F0.x;
      tone = F0.y;
    }
    vec3 smoothSkin = mix(sb, n9, 0.2) + fine * (0.92 - 0.25 * sk);
    c = mix(c, smoothSkin, m * sk);
    c = mix(c, c + (vec3(1.0) - c) * vec3(0.10, 0.085, 0.08) * tone, m);
    dSmall *= 1.0 - m * sk * 0.5;
  }
  if (lm.w < -0.004) {
    vec3 sb = texture(uSB, uv).rgb;
    float k = min(1.0, -lm.w);
    c = mix(c, mix(sb, n9, 0.2) + fine * (0.92 - 0.25 * k), k);
    dSmall *= 1.0 - k * 0.5;
  }

  // 뷰티: 다크서클 · 볼 혈색 · 입술 · 치아 · 눈
  if (uHasFace == 1) {
    // 다크서클: 살짝 밝히고 푸르스름한 기운만 덜어냄
    vec3 lifted = c + (1.0 - c) * vec3(0.12, 0.105, 0.095);
    lifted = mix(vec3(luma(lifted)), lifted, 0.9);
    c = mix(c, lifted, k1.a * F0.z * 0.75);
    // 볼 혈색: 은은한 장밋빛
    c = mix(c, c * vec3(1.03, 0.93, 0.95) + vec3(0.012, 0.0, 0.006), k2.r * F0.w * 0.5);
    // 입술: 원래 입술색을 살린 채 혈색과 생기만 더함
    vec3 lip = c * vec3(1.05, 0.93, 0.96);
    lip = luma(lip) + (lip - luma(lip)) * 1.22;
    c = mix(c, lip, k1.g * F1.x * 0.6);
    // 치아: 누런 기만 빼고 살짝 밝게 (회색·파란빛이 되지 않게)
    float tm = k1.b * F1.y * smoothstep(0.28, 0.5, luma(c));
    c = mix(c, mix(c, vec3(luma(c)), 0.7) * 1.04 + vec3(0.0, 0.002, 0.006), tm * 0.7);
    // 눈: 흰자·눈동자 결만 또렷하게
    c += k2.g * F1.z * (dSmall * 1.4 + 0.025);
    // 메이크업 — 립: 고른 색으로 물들이되 원래 입술의 명암·윤기는 그대로
    if (F2.x > 0.0) {
      float L = luma(c);
      vec3 tint = uLipC * (L / lumaS(uLipC));
      tint = mix(tint, uLipC, 0.25);
      c = mix(c, clamp(tint, 0.0, 1.0), k1.g * F2.x * 0.72);
    }
    // 블러셔: 볼에 은은하게 (곱하기)
    c = mix(c, c * (uBlushC / lumaS(uBlushC)), k2.r * F2.y * 0.2);
    // 아이섀도: 눈두덩에 (곱하기)
    c = mix(c, c * (uShadowC / lumaS(uShadowC)) * 0.88, k2.b * F2.z * 0.55);
    // 눈썹 진하게: 결을 살린 채 어둡게
    c = mix(c, c * 0.68, k2.a * F1.w * 0.75);
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

  // 배경 밝기 · 흑백 (사람은 그대로)
  if (uHasPM == 1) {
    float bgm = 1.0 - person;
    if (uBgLight != 0.0) c = mix(c, uBgLight > 0.0 ? c + (1.0 - c) * uBgLight * 0.45 : c * (1.0 + uBgLight * 0.55), bgm);
    c = mix(c, vec3(luma(c)), bgm * uBgMono);
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
      premul: makeProgram(gl, FS_PREMUL),
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

    // 1) 기하 변환 (+ 얼굴형 · 몸매 다듬기)
    const faces = this.faces?.length ? this.faces : null;
    const poses = this.poses?.length ? this.poses : null;
    const adjFor = (i) => dv.faceAdj(a, st, i);
    const bodyOn = poses && (a.legs > 0 || a.waist > 0 || a.shoulder);
    const warps = faces || bodyOn ? buildWarps(faces, adjFor, this.W, this.H, bodyOn ? poses : null, a) : { n: 0, leg: null };
    this.lastWarps = warps;
    const leg = warps.leg;
    const liq = this.syncLiquify(st.liquify);
    const erase = this.syncMask('er', st.erase);
    const geoTex = (src) => ({ uSrc: src, uLiq: liq ? this.liqTex : this.dummy, uErase: erase ? this.erTex : this.dummy });
    const geoSet = (p) => {
      gl.uniform1i(p.u('uHasLiq'), liq ? 1 : 0);
      gl.uniform1i(p.u('uHasErase'), erase ? 1 : 0);
      gl.uniformMatrix3fv(p.u('uInv'), false, transpose3(inv));
      gl.uniform2f(p.u('uSrcSize'), this.W, this.H);
      gl.uniform1i(p.u('uOpN'), warps.n);
      if (warps.n) {
        gl.uniform4fv(p.u('uOpA[0]'), warps.a);
        gl.uniform4fv(p.u('uOpB[0]'), warps.b);
      }
      if (leg) {
        gl.uniform4f(p.u('uLegO'), leg.o1, leg.o2, leg.o3, leg.H);
        gl.uniform4f(p.u('uLegS'), leg.T, leg.y0, leg.y1, 1);
      } else gl.uniform4f(p.u('uLegS'), 0, 0, 0, 0);
    };
    const A = this.target('A', outW, outH, false, true);
    this.pass(this.prog.geo, A, outW, outH, geoTex(this.srcTex), geoSet);
    // 얼굴 부위 영역도 같은 변형으로
    const COLOR_KEYS = ['skinSmooth', 'skinTone', 'darkCircle', 'blush', 'lips', 'teeth', 'eyeBright', 'mkLip', 'mkBlush', 'mkShadow', 'brow'];
    const facesAdj = faces ? faces.map((_, i) => adjFor(i)) : [];
    const beauty = facesAdj.some((fa) => COLOR_KEYS.some((k) => fa[k] > 0));
    let MK1 = null;
    let MK2 = null;
    let MK3 = null;
    if (faces && beauty) {
      this.ensureMasks();
      MK1 = this.target('MK1', outW, outH, false);
      this.pass(this.prog.geo, MK1, outW, outH, geoTex(this.mk1Tex), geoSet);
      MK2 = this.target('MK2', outW, outH, false);
      this.pass(this.prog.geo, MK2, outW, outH, geoTex(this.mk2Tex), geoSet);
      MK3 = this.target('MK3', outW, outH, false);
      this.pass(this.prog.geo, MK3, outW, outH, geoTex(this.mk3Tex), geoSet);
    }
    // 사람 영역 (배경 흐림 · 밝기 · 흑백)
    let PM = null;
    if (this.person && (a.bgBlur > 0 || a.bgLight || a.bgMono > 0)) {
      this.ensurePerson();
      PM = this.target('PM', outW, outH, false);
      this.pass(this.prog.geo, PM, outW, outH, geoTex(this.pmTex), geoSet);
    }
    // 보정 지우개 영역: 변형 없이 화면 자리 그대로
    let ER = null;
    if (erase) {
      ER = this.target('ER', outW, outH, false);
      this.pass(this.prog.geo, ER, outW, outH, { uSrc: this.erTex, uLiq: this.dummy, uErase: this.dummy }, (p) => {
        gl.uniformMatrix3fv(p.u('uInv'), false, transpose3(inv));
        gl.uniform2f(p.u('uSrcSize'), this.W, this.H);
        gl.uniform1i(p.u('uOpN'), 0);
        gl.uniform1i(p.u('uHasLiq'), 0);
        gl.uniform1i(p.u('uHasErase'), 0);
        gl.uniform4f(p.u('uLegS'), 0, 0, 0, 0);
      });
    }
    // 부분 보정 영역도 같은 변형으로
    const local = this.syncMask('lm', st.local);
    let LM = null;
    if (local) {
      LM = this.target('LM', outW, outH, false);
      this.pass(this.prog.geo, LM, outW, outH, geoTex(this.lmTex), geoSet);
    }
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 1-2) 배경 흐림: 사람 색을 뺀 배경만 1/4 크기에서 흐림 (사진 크기 기준이라 미리보기와 저장 결과가 같음)
    let BGB = null;
    if (PM && a.bgBlur > 0) {
      const bw = Math.max(1, Math.round(outW / 4));
      const bh = Math.max(1, Math.round(outH / 4));
      const B0 = this.target('B0', bw, bh, true);
      this.pass(this.prog.premul, B0, bw, bh, { uTex: A.tex, uMask: PM.tex });
      BGB = this.target('BGB', bw, bh, true);
      const sigma = Math.max(0.6, ((a.bgBlur / 100) * 0.014 * Math.max(outW, outH)) / 4);
      this.blur(B0, this.target('BT', bw, bh, true), BGB, sigma);
      // 한 번 더 (가우스 두 번 → 더 둥글고 부드러운 흐림)
      this.blur(BGB, this.target('BT', bw, bh, true), B0, sigma * 0.6);
      BGB = B0;
    }

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
    const skin = a.skinSmooth > 0 || a.skinTone > 0 || facesAdj.some((fa) => fa.skinSmooth > 0 || fa.skinTone > 0);
    const localSmooth = !!local && st.local.some((o) => o.t === 'smooth' || o.t === 'erase');
    let SB = null;
    if (skin || localSmooth) {
      const k = Math.min(1, 512 / Math.max(outW, outH));
      const kw = Math.max(1, Math.round(outW * k));
      const kh = Math.max(1, Math.round(outH * k));
      const K0 = this.target('K0', kw, kh, false);
      this.pass(this.prog.resample, K0, kw, kh, { uTex: A.tex });
      SB = this.target('SB', kw, kh, false);
      this.pass(this.prog.bilateral, SB, kw, kh, { uTex: K0.tex });
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
      uImg: A.tex, uBL: BL.tex, uBM: BM.tex, uSB: SB ? SB.tex : this.dummy, uNC: NC ? NC.tex : this.dummy, uMK1: MK1 ? MK1.tex : this.dummy, uMK2: MK2 ? MK2.tex : this.dummy, uLM: LM ? LM.tex : this.dummy, uER: ER ? ER.tex : this.dummy, uMK3: MK3 ? MK3.tex : this.dummy, uPM: PM ? PM.tex : this.dummy, uBGB: BGB ? BGB.tex : this.dummy, uLut: this.lutTex,
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
      gl.uniform1i(p.u('uHasER'), ER ? 1 : 0);
      gl.uniform1i(p.u('uHasPM'), PM ? 1 : 0);
      gl.uniform1i(p.u('uHasBGB'), BGB ? 1 : 0);
      f('uBgLight', a.bgLight / 100);
      f('uBgMono', a.bgMono / 100);
      // 얼굴별 값
      const fp = new Float32Array(18 * 4);
      facesAdj.slice(0, 6).forEach((fa, i) => {
        fp.set([fa.skinSmooth, fa.skinTone, fa.darkCircle, fa.blush, fa.lips, fa.teeth, fa.eyeBright, fa.brow, fa.mkLip, fa.mkBlush, fa.mkShadow, 0].map((v) => (v || 0) / 100), i * 12);
      });
      gl.uniform4fv(p.u('uFP[0]'), fp);
      const col = (list, id) => (list.find((x) => x[0] === id) || list[0])[2];
      const mk = st.makeup || {};
      gl.uniform3f(p.u('uLipC'), ...col(LIP_COLORS, mk.lip));
      gl.uniform3f(p.u('uBlushC'), ...col(BLUSH_COLORS, mk.blush));
      gl.uniform3f(p.u('uShadowC'), ...col(SHADOW_COLORS, mk.shadow));
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

  /** 칠한 영역 지도(부분 보정 'lm' · 보정 지우개 'er')를 최신으로 */
  syncMask(k, ops) {
    const cacheKey = `${k}Cache`;
    if (!this[cacheKey]) this[cacheKey] = new OpCache((W, H) => new LocalMask(W, H));
    const cache = this[cacheKey];
    const m = cache.sync(ops, this.W, this.H);
    if (!m) return null;
    const gl = this.gl;
    const texKey = `${k}Tex`;
    if (cache.changed || !this[texKey] || this[`${k}Obj`] !== m) {
      let full = cache.rebuilt || this[`${k}Obj`] !== m;
      if (!this[texKey] || this[`${k}Dims`] !== `${m.fw}x${m.fh}`) {
        full = true;
        if (this[texKey]) gl.deleteTexture(this[texKey]);
        this[texKey] = this.texture(m.fw, m.fh, false);
        this[`${k}Dims`] = `${m.fw}x${m.fh}`;
      }
      gl.bindTexture(gl.TEXTURE_2D, this[texKey]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const rows = m.takeRows();
      const [y0, y1] = full || !rows ? [0, m.fh - 1] : rows;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, m.fw, y1 - y0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, m.data().subarray(y0 * m.fw * 4, (y1 + 1) * m.fw * 4));
      this[`${k}Obj`] = m;
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
    const x0 = x;
    const y0 = y;
    const f = this.liqCache?.obj;
    if (f && !f.empty) {
      const [dx, dy] = f.sample(x, y);
      x += dx;
      y += dy;
    }
    const w = this.lastWarps;
    if (w?.leg) y = legMap(w.leg, (y * M)) / M;
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
    const er = this.erCache?.obj;
    if (er && !er.empty) {
      const e = Math.max(0, Math.min(1, er.value(x0, y0)));
      x += (x0 - x) * e;
      y += (y0 - y) * e;
    }
    return [(x * M) / this.W, (y * M) / this.H];
  }

  /** 몸 지점 (자세 인식 결과) */
  setPoses(poses) {
    this.poses = poses && poses.length ? poses : null;
  }

  /** 사람 영역 { w, h, data } (배경 효과용) */
  setPerson(person) {
    this.person = person || null;
    this.pmKey = null;
  }

  ensurePerson() {
    if (this.pmKey === this.person) return;
    const gl = this.gl;
    const { w, h, data } = this.person;
    if (this.pmTex) gl.deleteTexture(this.pmTex);
    this.pmTex = this.texture(w, h, false);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = data[i];
      rgba[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.pmTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.pmKey = this.person;
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
    const { m1, m2, m3 } = buildMasks(this.faces, w, h);
    const gl = this.gl;
    for (const [name, data] of [['mk1Tex', m1], ['mk2Tex', m2], ['mk3Tex', m3]]) {
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

  setPoses() {}

  setPerson() {}

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

/**
 * 저장해 둔 보정(프리셋·복사한 보정)을 사진 한 장에 적용한 새 파일
 * @param st 적용할 편집 상태, need 필요한 인식 { faces, poses, person }
 */
export async function styleBlob(blob, type, st, need = {}) {
  const src = await im.decode(blob);
  const r = sharedRenderer();
  try {
    const [W, H] = im.dimsOf(src);
    // 인식은 작은 사본으로 (속도) — 결과는 비율 좌표라 원본에도 그대로 맞음
    let small = src;
    if ((need.faces || need.poses || need.person) && r.gpu) {
      const k = Math.min(1, 1600 / Math.max(W, H));
      small = im.makeCanvas(W * k, H * k);
      small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
      r.setFaces(need.faces ? await detectFaces(small).catch(() => null) : null);
      r.setPoses(need.poses ? await detectPoses(small).catch(() => null) : null);
      r.setPerson(need.person ? await segmentPerson(small, small.width, small.height).catch(() => null) : null);
    }
    return await im.canvasToBlob(renderFinal(r, src, W, H, st), type);
  } finally {
    r.setFaces(null);
    r.setPoses(null);
    r.setPerson(null);
    src.close?.();
  }
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
