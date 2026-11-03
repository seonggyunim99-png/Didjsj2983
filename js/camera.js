// 뷰티 카메라: 촬영 화면에 필터와 뷰티를 실시간으로 보여 주고, 찍으면 원본 해상도로 보정해서 보관함에 저장
import { icon, toast } from './ui.js';
import * as dv from './develop.js';
import * as im from './imaging.js';
import { createRenderer, sharedRenderer, renderFinal } from './glrender.js';
import { detectFaces, detectFacesVideo, AUTO_BEAUTY } from './face.js';

const LEVELS = [['0', '끔'], ['0.6', '자연'], ['1', '보통'], ['1.5', '진하게']];
const SHAPE_KEYS = ['skinSmooth', 'skinTone', 'faceSlim', 'eyes', 'nose', 'chin'];

/** 지금 고른 필터·뷰티 → 편집 상태 (live면 카메라 화면용: 얼굴형과 피부만) */
function stateFor(look, level, live) {
  const st = dv.defaultState();
  st.look = look;
  st.lookAmt = 1;
  for (const [k, v] of Object.entries(AUTO_BEAUTY)) {
    if (live && !SHAPE_KEYS.includes(k)) continue;
    st.adj[k] = Math.round(v * level);
  }
  return st;
}

export function openCamera({ onCapture, onClose }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('이 브라우저에서는 카메라를 쓸 수 없어요');
    return null;
  }
  const looks = dv.LOOKS.filter((l) => ['none', 'clear', 'warm', 'cool', 'film', 'portra', 'pastel', 'cafe', 'mono'].includes(l.id));
  let look = 'none';
  let level = 1;
  let facing = 'user';
  let stream = null;
  let raf = 0;
  let frame = 0;
  let faces = null;
  let detecting = false;
  let closed = false;
  const renderer = createRenderer();

  const root = document.createElement('div');
  root.className = 'cam';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '뷰티 카메라');
  root.innerHTML = `
    <div class="cam-top">
      <button type="button" class="cam-icon" data-act="close" aria-label="닫기">${icon('close')}</button>
      <span class="cam-title">뷰티 카메라</span>
      <button type="button" class="cam-icon" data-act="flip" aria-label="카메라 전환">${icon('flip')}</button>
    </div>
    <div class="cam-stage"><canvas class="cam-view"></canvas><div class="cam-msg">카메라를 켜는 중…</div><div class="cam-flash"></div></div>
    <div class="cam-bottom">
      <div class="cam-chips cam-looks">${looks.map((l) => `<button type="button" class="cam-chip${l.id === look ? ' on' : ''}" data-look="${l.id}">${l.name}</button>`).join('')}</div>
      <div class="cam-chips cam-levels"><span>뷰티</span>${LEVELS.map(([v, l]) => `<button type="button" class="cam-chip${+v === level ? ' on' : ''}" data-level="${v}">${l}</button>`).join('')}</div>
      <div class="cam-shoot"><button type="button" class="cam-shutter" data-act="shoot" aria-label="찍기"><i></i></button></div>
    </div>
    <video class="cam-video" playsinline muted autoplay></video>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('open'));
  const view = root.querySelector('.cam-view');
  const video = root.querySelector('.cam-video');
  const msg = root.querySelector('.cam-msg');

  async function start() {
    stream?.getTracks().forEach((t) => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (err) {
      msg.textContent = '카메라를 켜지 못했어요. 브라우저의 카메라 권한을 확인해 주세요.';
      return;
    }
    if (closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    msg.hidden = true;
    root.classList.toggle('mirror', facing === 'user');
    loop();
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (closed) return;
      raf = requestAnimationFrame(tick);
      if (video.readyState < 2 || !video.videoWidth) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // 화면 크기에 맞춰 (너무 크면 느려지므로 긴 변 960px까지)
      const stage = view.parentElement;
      const k = Math.min(960 / Math.max(vw, vh), (Math.max(stage.clientWidth, stage.clientHeight) * Math.min(2, devicePixelRatio || 1)) / Math.max(vw, vh));
      const ow = Math.max(2, Math.round(vw * k));
      const oh = Math.max(2, Math.round(vh * k));
      renderer.setSource(video, vw, vh);
      // 얼굴은 두 장면에 한 번 (기기 부담을 줄임)
      frame++;
      if (level > 0 && frame % 2 === 0 && !detecting) {
        detecting = true;
        detectFacesVideo(video, performance.now()).then((f) => { faces = f; }).catch(() => { faces = null; }).finally(() => { detecting = false; });
      }
      renderer.setFaces(level > 0 ? faces : null, true);
      try {
        const { canvas } = renderer.render(stateFor(look, level, true), { region: dv.FULL, outW: ow, outH: oh, outScale: k });
        if (view.width !== ow) view.width = ow;
        if (view.height !== oh) view.height = oh;
        view.getContext('2d').drawImage(canvas, 0, 0);
      } catch (err) {
        console.warn(err);
      }
    };
    tick();
  }

  async function shoot() {
    if (!video.videoWidth) return;
    const btn = root.querySelector('.cam-shutter');
    btn.disabled = true;
    root.classList.add('flash');
    setTimeout(() => root.classList.remove('flash'), 180);
    try {
      // 지금 장면을 원본 해상도로
      const W = video.videoWidth;
      const H = video.videoHeight;
      const c = im.makeCanvas(W, H);
      const ctx = c.getContext('2d');
      if (facing === 'user') {
        // 셀카는 보이는 그대로(좌우 반전) 저장
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, W, H);
      const st = stateFor(look, level, false);
      const r = sharedRenderer();
      r.setFaces(level > 0 ? await detectFaces(c).catch(() => null) : null);
      const out = renderFinal(r, c, W, H, st);
      r.setFaces(null);
      const blob = await im.canvasToBlob(out, 'image/jpeg');
      await onCapture(blob);
    } catch (err) {
      console.error(err);
      toast(`찍지 못했어요: ${err.message}`);
    }
    btn.disabled = false;
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    renderer.dispose();
    root.classList.remove('open');
    setTimeout(() => root.remove(), 200);
    onClose?.();
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.look) {
      look = t.dataset.look;
      root.querySelectorAll('[data-look]').forEach((b) => b.classList.toggle('on', b === t));
    } else if (t.dataset.level) {
      level = +t.dataset.level;
      root.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('on', b === t));
    } else if (t.dataset.act === 'close') close();
    else if (t.dataset.act === 'flip') {
      facing = facing === 'user' ? 'environment' : 'user';
      faces = null;
      start();
    } else if (t.dataset.act === 'shoot') shoot();
  });
  start();
  return { close };
}
