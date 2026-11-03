// 빠른 스크롤: 오른쪽 손잡이를 끌면 월 단위로 빠르게 이동합니다.
const THUMB_H = 46;

function monthLabel(dayKey) {
  const [y, m] = dayKey.split('-');
  return `${y}년 ${m}월`;
}

export function createScroller({ topInset, bottomInset }) {
  const el = document.createElement('div');
  el.className = 'scroller';
  el.hidden = true;
  el.innerHTML = `<div class="scroller-thumb" role="scrollbar" aria-label="빠른 스크롤" aria-orientation="vertical">
      <span class="scroller-label"></span>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>
    </div>`;
  document.body.appendChild(el);
  const thumb = el.querySelector('.scroller-thumb');
  const label = el.querySelector('.scroller-label');

  let sections = [];
  let enabled = false;
  let hideTimer = 0;
  let drag = null;

  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const metrics = () => {
    const top = topInset();
    const bottom = window.innerHeight - bottomInset();
    return { top, track: Math.max(1, bottom - top - THUMB_H) };
  };

  function labelAt(y) {
    let lo = 0;
    let hi = sections.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sections[mid].top <= y) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return sections[found]?.label || '';
  }

  function position() {
    const { top, track } = metrics();
    const r = Math.min(1, Math.max(0, window.scrollY / maxScroll()));
    thumb.style.transform = `translateY(${top + r * track}px)`;
    label.textContent = labelAt(window.scrollY + top + 8);
  }

  function show() {
    el.classList.add('show');
    clearTimeout(hideTimer);
    if (!drag) hideTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  window.addEventListener('scroll', () => {
    if (!enabled) return;
    position();
    show();
  }, { passive: true });

  thumb.addEventListener('pointerdown', (e) => {
    if (!enabled) return;
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    const rect = thumb.getBoundingClientRect();
    drag = { offset: e.clientY - rect.top };
    el.classList.add('dragging', 'show');
    clearTimeout(hideTimer);
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { top, track } = metrics();
    const r = Math.min(1, Math.max(0, (e.clientY - drag.offset - top) / track));
    window.scrollTo(0, r * maxScroll());
    position();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove('dragging');
    show();
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);

  return {
    refresh(root) {
      sections = [...root.querySelectorAll('.day')].map((s) => ({
        top: s.getBoundingClientRect().top + window.scrollY,
        label: monthLabel(s.dataset.day),
      }));
      enabled = sections.length > 1 && document.documentElement.scrollHeight > window.innerHeight * 2.2;
      el.hidden = !enabled;
      if (enabled) position();
      else el.classList.remove('show');
    },
    disable() {
      enabled = false;
      el.hidden = true;
    },
  };
}
