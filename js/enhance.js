// 여러 장 자동 보정: 보정 전/후 미리보기와 한꺼번에 적용
import * as im from './imaging.js';
import { previewEnhance, autoEnhanceBlob, styleBlob } from './glrender.js';
import * as looks from './looks.js';
import * as dv from './develop.js';
import * as lib from './library.js';
import { icon, esc, openModal, fmtNum, progress } from './ui.js';

// 순서가 중요해서 배열로 둡니다 (객체는 정수 키 '1'을 맨 앞으로 정렬해 버려요)
export const STRENGTHS = [['0.6', '자연스럽게'], ['1', '보통'], ['1.4', '강하게']];

/**
 * 보정 전/후를 나란히 보여주고 보정할 사진을 고르게 합니다.
 * @returns {Promise<{ids:string[], strength:number, asCopy:boolean}|null>}
 */
export function reviewEnhance({ title, items, thumbURL, strength = 1, intro = '' }) {
  return new Promise((resolve) => {
    const chosen = new Set(items.map((m) => m.id));
    const sources = new Map();
    let level = strength;
    let asCopy = false;
    const seg = (name, options, cur) => `<div class="segmented" data-seg="${name}">${(Array.isArray(options) ? options : Object.entries(options)).map(([v, l]) => `<button type="button" data-v="${v}" class="${String(cur) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const modal = openModal({
      className: 'picker enhance-review',
      html: `
        <header class="picker-bar">
          <button type="button" class="icon-btn" data-x aria-label="닫기">${icon('close')}</button>
          <h2>${esc(title)}</h2>
          <button type="button" class="btn primary sm" data-ok>보정</button>
        </header>
        <div class="picker-body">
          ${intro ? `<p class="enh-intro">${intro}</p>` : ''}
          <div class="enh-grid">${items.map((m) => `
            <div class="enh-item on" data-id="${esc(m.id)}" role="checkbox" aria-checked="true" tabindex="0">
              <div class="enh-pair">
                <figure><img src="${thumbURL(m) || ''}" alt="" draggable="false"><figcaption>원본</figcaption></figure>
                <figure><canvas width="2" height="2"></canvas><figcaption>보정 후</figcaption></figure>
              </div>
              <span class="tick">${icon('check')}</span>
            </div>`).join('')}
          </div>
        </div>
        <footer class="enh-footer">
          <div class="enh-opt"><span>강도</span>${seg('strength', STRENGTHS, level)}</div>
          <div class="enh-opt"><span>저장</span>${seg('mode', { replace: '원본 보관하고 바꾸기', copy: '사본으로 저장' }, 'replace')}</div>
        </footer>`,
      onClose: (v) => {
        io.disconnect();
        for (const s of sources.values()) s?.close?.();
        resolve(v || null);
      },
    });
    const el = modal.el;
    const ok = el.querySelector('[data-ok]');
    const sync = () => {
      ok.disabled = !chosen.size;
      ok.textContent = chosen.size ? `${fmtNum(chosen.size)}장 보정` : '보정';
    };
    sync();

    async function paint(item) {
      const id = item.dataset.id;
      const m = lib.store.byId.get(id);
      if (!m?.thumb) return;
      try {
        if (!sources.has(id)) sources.set(id, await im.decode(m.thumb));
        const out = previewEnhance(sources.get(id), { strength: level });
        const c = item.querySelector('canvas');
        c.width = out.width;
        c.height = out.height;
        c.getContext('2d').drawImage(out, 0, 0);
        item.classList.add('ready');
      } catch {
        item.classList.add('failed');
      }
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        paint(e.target);
      }
    }, { root: el.querySelector('.picker-body'), rootMargin: '400px 0px' });
    el.querySelectorAll('.enh-item').forEach((it) => io.observe(it));

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) return modal.close();
      if (e.target.closest('[data-ok]')) return modal.close({ ids: [...chosen], strength: level, asCopy });
      const segBtn = e.target.closest('[data-seg] [data-v]');
      if (segBtn) {
        const segEl = segBtn.closest('[data-seg]');
        segEl.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b === segBtn));
        if (segEl.dataset.seg === 'strength') {
          level = +segBtn.dataset.v;
          el.querySelectorAll('.enh-item.ready').forEach(paint);
        } else {
          asCopy = segBtn.dataset.v === 'copy';
        }
        return;
      }
      const item = e.target.closest('.enh-item');
      if (item) {
        const id = item.dataset.id;
        if (chosen.has(id)) chosen.delete(id);
        else chosen.add(id);
        item.classList.toggle('on', chosen.has(id));
        item.setAttribute('aria-checked', String(chosen.has(id)));
        sync();
      }
    });
  });
}

/** 고른 사진들을 자동 보정해서 저장합니다. 편집 전 원본은 보관돼요. */
export async function runBatchEnhance(ids, { strength = 1, asCopy = false } = {}) {
  const result = { done: 0, failed: 0, stopped: false };
  let stop = false;
  progress.show('자동 보정하는 중', () => { stop = true; });
  for (let i = 0; i < ids.length; i++) {
    if (stop) {
      result.stopped = true;
      break;
    }
    const m = lib.store.byId.get(ids[i]);
    progress.update(i, ids.length, m?.name || '');
    if (!m || m.kind !== 'image') continue;
    try {
      const blob = await lib.getOriginal(m.id);
      const out = await autoEnhanceBlob(blob, m.type, { strength });
      await lib.saveEdit(m.id, out, { asCopy });
      result.done++;
    } catch (err) {
      console.error('자동 보정 실패', m.name, err);
      result.failed++;
    }
  }
  progress.update(ids.length, ids.length);
  progress.hide();
  return result;
}

/**
 * 저장해 둔 보정(프리셋 · 복사한 보정)을 여러 장에 한꺼번에 적용
 * 얼굴·몸·배경 보정이 들어 있으면 사진마다 인식해서 적용합니다.
 */
export async function runBatchStyle(ids, style, { asCopy = false, title = '보정 적용하는 중' } = {}) {
  const result = { done: 0, failed: 0, stopped: false };
  let stop = false;
  const st = looks.applyStyle(dv.defaultState(), style);
  const need = looks.styleNeeds(st.adj);
  progress.show(title, () => { stop = true; });
  for (let i = 0; i < ids.length; i++) {
    if (stop) {
      result.stopped = true;
      break;
    }
    const m = lib.store.byId.get(ids[i]);
    progress.update(i, ids.length, m?.name || '');
    if (!m || m.kind !== 'image') continue;
    try {
      const blob = await lib.getOriginal(m.id);
      const out = await styleBlob(blob, m.type, st, need);
      await lib.saveEdit(m.id, out, { asCopy });
      result.done++;
    } catch (err) {
      console.error('보정 적용 실패', m.name, err);
      result.failed++;
    }
  }
  progress.update(ids.length, ids.length);
  progress.hide();
  return result;
}
