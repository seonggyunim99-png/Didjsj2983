// 동영상 보정: 필터 · 밝기 · 색감 · 피부 보정을 영상 전체에 적용해서 새 동영상으로 저장 (소리 포함)
// 저장은 영상을 한 번 재생하면서 보정한 장면을 녹화하므로 영상 길이만큼 걸립니다.
import { icon, esc, toast, confirmDialog } from './ui.js';
import * as dv from './develop.js';
import { createRenderer } from './glrender.js';

const SLIDERS = [
  ['exposure', '노출'], ['contrast', '대비'], ['highlights', '하이라이트'], ['shadows', '그림자'],
  ['temp', '색온도'], ['tint', '틴트'], ['vibrance', '생동감'], ['saturation', '채도'],
  ['clarity', '명료도'], ['vignette', '비네팅'], ['skinSmooth', '피부 보정'], ['fade', '페이드'],
];
const MAX_LONG = 1920;

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** 녹화할 수 있는 형식 (mp4 우선, 안 되면 webm) */
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export function openVideoEditor({ blob, name, onSave, onClose }) {
  const st = dv.defaultState();
  const renderer = createRenderer();
  const url = URL.createObjectURL(blob);
  let tab = 'filter';
  let raf = 0;
  let closed = false;
  let exporting = null;

  const root = document.createElement('div');
  root.className = 'editor vedit';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '동영상 보정');
  root.innerHTML = `
    <header class="ed-top">
      <button type="button" class="ed-icon" data-act="close" aria-label="닫기">${icon('close')}</button>
      <span class="ve-title">동영상 보정</span>
      <button type="button" class="btn primary sm" data-act="save">저장</button>
    </header>
    <div class="ed-stage ve-stage"><canvas class="ed-canvas ve-view"></canvas></div>
    <div class="ve-bar">
      <button type="button" class="ed-icon" data-act="play" aria-label="재생">${icon('play')}</button>
      <input type="range" class="ve-seek" min="0" max="1000" value="0" aria-label="재생 위치">
      <span class="ve-time">0:00 / 0:00</span>
    </div>
    <div class="ed-panel ve-panel"></div>
    <nav class="ed-tabs">
      <button type="button" class="ed-tab on" data-vtab="filter">${icon('filter')}<span>필터</span></button>
      <button type="button" class="ed-tab" data-vtab="adjust">${icon('tune')}<span>조정</span></button>
    </nav>
    <div class="ed-busy"><i></i><span></span><button type="button" class="btn sm ve-cancel" data-act="cancel-export" hidden>멈추기</button></div>
    <video class="cam-video" playsinline preload="auto"></video>`;
  document.body.appendChild(root);
  document.body.classList.add('editor-open');
  requestAnimationFrame(() => root.classList.add('open'));
  const view = root.querySelector('.ve-view');
  const video = root.querySelector('video');
  const panel = root.querySelector('.ve-panel');
  const seek = root.querySelector('.ve-seek');
  const time = root.querySelector('.ve-time');
  video.src = url;

  const busy = (text, cancel = false) => {
    root.classList.toggle('busy', !!text);
    root.querySelector('.ed-busy span').textContent = text || '';
    root.querySelector('.ve-cancel').hidden = !cancel;
  };

  function layout() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw) return;
    const stage = view.parentElement;
    const fit = Math.min(stage.clientWidth / vw, stage.clientHeight / vh);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const k = Math.min(1, fit * dpr, 960 / Math.max(vw, vh));
    view.width = Math.max(2, Math.round(vw * k));
    view.height = Math.max(2, Math.round(vh * k));
    Object.assign(view.style, { width: `${vw * fit}px`, height: `${vh * fit}px`, left: `${(stage.clientWidth - vw * fit) / 2}px`, top: `${(stage.clientHeight - vh * fit) / 2}px` });
  }

  function draw(target = view) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || video.readyState < 2) return;
    renderer.setSource(video, vw, vh);
    const k = target.width / vw;
    const { canvas } = renderer.render(st, { region: dv.FULL, outW: target.width, outH: target.height, outScale: k });
    target.getContext('2d').drawImage(canvas, 0, 0, target.width, target.height);
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (closed || exporting) return;
      draw();
      if (video.duration) {
        seek.value = Math.round((video.currentTime / video.duration) * 1000);
        time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
      }
      if (!video.paused) raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function renderPanel() {
    root.querySelectorAll('[data-vtab]').forEach((b) => b.classList.toggle('on', b.dataset.vtab === tab));
    if (tab === 'filter') {
      panel.innerHTML = `
        <div class="ed-chips">${dv.LOOKS.map((l) => `<button type="button" class="ed-chip${st.look === l.id ? ' on' : ''}" data-look="${l.id}">${esc(l.name)}</button>`).join('')}</div>
        ${st.look === 'none' ? '<p class="ed-hint">필터를 고르면 영상 전체에 같은 색감이 들어가요</p>' : `<div class="ed-slider-row"><span class="ed-slider-label">강도</span><input type="range" data-amt min="0" max="100" value="${Math.round(st.lookAmt * 100)}" aria-label="강도"><output>${Math.round(st.lookAmt * 100)}</output></div>`}`;
    } else {
      panel.innerHTML = SLIDERS.map(([k, label]) => {
        const a = dv.ADJ_BY_KEY[k];
        const v = st.adj[k];
        return `<div class="ed-slider-row${v ? ' changed' : ''}"><span class="ed-slider-label">${label}</span><input type="range" data-adj="${k}" min="${a.min}" max="${a.max}" value="${v}"${a.min < 0 ? ' data-bipolar' : ''} aria-label="${label}"><output>${a.fmt ? a.fmt(v) : v > 0 ? `+${v}` : v}</output></div>`;
      }).join('') + '<p class="ed-hint">피부 보정은 피부색 부분만 부드럽게 해요</p>';
    }
  }

  async function exportVideo() {
    const mime = pickMime();
    if (!mime) {
      toast('이 브라우저에서는 동영상을 저장할 수 없어요');
      return;
    }
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const ok = await confirmDialog({ title: '보정한 동영상 저장', message: `영상을 한 번 재생하면서 보정을 입혀 새 동영상으로 저장해요. 영상 길이(${fmtTime(dur)})만큼 걸리고, 원본은 그대로 남아요.`, ok: '저장' });
    if (!ok) return;
    video.pause();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const k = Math.min(1, MAX_LONG / Math.max(vw, vh));
    const out = document.createElement('canvas');
    out.width = Math.round((vw * k) / 2) * 2;
    out.height = Math.round((vh * k) / 2) * 2;
    const vstream = out.captureStream(30);
    // 소리: 영상 소리를 그대로 녹음 (스피커로는 내보내지 않음)
    let actx = null;
    try {
      actx = new AudioContext();
      const srcNode = actx.createMediaElementSource(video);
      const dest = actx.createMediaStreamDestination();
      srcNode.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => vstream.addTrack(t));
    } catch (err) {
      console.warn('소리 없이 저장', err);
    }
    const chunks = [];
    const rec = new MediaRecorder(vstream, { mimeType: mime, videoBitsPerSecond: Math.round(out.width * out.height * 30 * 0.12) });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    exporting = { stop: false };
    busy('동영상 저장 중… 0%', true);
    const done = new Promise((resolve) => { rec.onstop = resolve; });
    video.currentTime = 0;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    rec.start(500);
    video.muted = false;
    await video.play();
    const step = () => {
      if (!exporting) return;
      draw(out);
      busy(`동영상 저장 중… ${Math.min(99, Math.round((video.currentTime / dur) * 100))}%`, true);
      if (video.ended || exporting.stop) {
        rec.stop();
        return;
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    step();
    video.addEventListener('ended', () => { if (rec.state === 'recording') rec.stop(); }, { once: true });
    await done;
    const stopped = exporting.stop;
    exporting = null;
    video.pause();
    actx?.close();
    busy('');
    if (stopped) {
      toast('저장을 멈췄어요');
      loop();
      return;
    }
    const type = mime.split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    const base = (name || 'video').replace(/\.[^.]+$/, '');
    await onSave(new Blob(chunks, { type }), `${base}_edit.${ext}`);
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    video.pause();
    renderer.dispose();
    URL.revokeObjectURL(url);
    document.body.classList.remove('editor-open');
    root.classList.remove('open');
    setTimeout(() => root.remove(), 200);
    onClose?.();
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.vtab) {
      tab = t.dataset.vtab;
      renderPanel();
    } else if (t.dataset.look) {
      st.look = t.dataset.look;
      st.lookAmt = 1;
      renderPanel();
      loop();
    } else if (t.dataset.act === 'play') {
      if (video.paused) await video.play().catch(() => {});
      else video.pause();
      t.innerHTML = icon(video.paused ? 'play' : 'pause');
      loop();
    } else if (t.dataset.act === 'save') exportVideo();
    else if (t.dataset.act === 'cancel-export' && exporting) exporting.stop = true;
    else if (t.dataset.act === 'close') {
      if (exporting) return;
      if (dv.isEdited(st) && !(await confirmDialog({ title: '보정을 버릴까요?', ok: '버리기', danger: true }))) return;
      close();
    }
  });
  root.addEventListener('input', (e) => {
    const r = e.target;
    if (r === seek) {
      if (video.duration) video.currentTime = (r.value / 1000) * video.duration;
      return;
    }
    const out = r.parentElement.querySelector('output');
    if (r.dataset.adj) {
      const a = dv.ADJ_BY_KEY[r.dataset.adj];
      st.adj[a.key] = +r.value;
      out.textContent = a.fmt ? a.fmt(+r.value) : +r.value > 0 ? `+${r.value}` : r.value;
      r.parentElement.classList.toggle('changed', !!+r.value);
    } else if (r.hasAttribute('data-amt')) {
      st.lookAmt = r.value / 100;
      out.textContent = r.value;
    }
    loop();
  });
  video.addEventListener('loadeddata', () => {
    layout();
    loop();
  });
  video.addEventListener('seeked', () => !exporting && loop());
  video.addEventListener('ended', () => {
    root.querySelector('[data-act="play"]').innerHTML = icon('play');
  });
  window.addEventListener('resize', () => !closed && (layout(), loop()));
  renderPanel();
  return { close };
}
