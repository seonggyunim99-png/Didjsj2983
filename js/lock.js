// 앱 잠금: 4자리 PIN. 다른 사람이 앱을 열어보지 못하게 하는 화면 잠금입니다.
// (사진 파일 자체를 암호화하지는 않아요)
import { icon, el, esc } from './ui.js';
import * as db from './db.js';

const PIN_LEN = 4;
export const LOCK_DELAYS = [[0, '바로'], [60_000, '1분 후'], [300_000, '5분 후']];

let config = null; // { salt, hash, delay }
let lockedPromise = null;
let hiddenAt = 0;
let onForgot = null;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}:photo-vault`);
  if (globalThis.crypto?.subtle) return toHex(await crypto.subtle.digest('SHA-256', data));
  let h = 0x811c9dc5;
  for (const b of data) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `f${h.toString(16)}`;
}

function randomSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return toHex(a);
}

export async function initLock({ forgot }) {
  onForgot = forgot;
  try {
    config = await db.getMeta('lock');
  } catch {
    config = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (config && !lockedPromise && Date.now() - hiddenAt >= (config.delay ?? 0)) lock();
  });
  return !!config;
}

export const isLockEnabled = () => !!config;
export const lockDelay = () => config?.delay ?? 0;
export const isLocked = () => !!lockedPromise;

export async function setPin(pin) {
  const salt = randomSalt();
  config = { salt, hash: await hashPin(pin, salt), delay: config?.delay ?? 0 };
  await db.setMeta('lock', config);
}

export async function setDelay(ms) {
  if (!config) return;
  config.delay = ms;
  await db.setMeta('lock', config);
}

export async function disableLock() {
  config = null;
  await db.setMeta('lock', null);
}

export async function checkPin(pin) {
  return !!config && (await hashPin(pin, config.salt)) === config.hash;
}

/* ---------- 숫자 패드 ---------- */

function keypadHTML() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return `<div class="keypad">${keys.map((k) => {
    if (!k) return '<span></span>';
    if (k === 'del') return `<button type="button" class="key key-del" data-key="del" aria-label="지우기">${icon('backspace')}</button>`;
    return `<button type="button" class="key" data-key="${k}">${k}</button>`;
  }).join('')}</div>`;
}

/**
 * 숫자 패드 동작을 붙입니다. onComplete가 false면 흔들고 지우고, 'reset'이면 조용히 지웁니다.
 */
function attachKeypad(root, onComplete) {
  let value = '';
  let busy = false;
  const dots = root.querySelector('.pin-dots');
  const paint = () => {
    dots.innerHTML = Array.from({ length: PIN_LEN }, (_, i) => `<i class="${i < value.length ? 'on' : ''}"></i>`).join('');
  };
  const press = async (k) => {
    if (busy || root.classList.contains('cooldown')) return;
    if (k === 'del') value = value.slice(0, -1);
    else if (value.length < PIN_LEN) value += k;
    paint();
    if (value.length === PIN_LEN) {
      busy = true;
      const ok = await onComplete(value);
      if (ok === 'reset') {
        value = '';
        paint();
      } else if (ok === false) {
        dots.classList.remove('shake');
        void dots.offsetWidth;
        dots.classList.add('shake');
        navigator.vibrate?.([30, 40, 30]);
        setTimeout(() => {
          value = '';
          paint();
        }, 260);
      }
      busy = false;
    }
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (b) press(b.dataset.key);
  });
  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener('keydown', onKey, true);
  paint();
  return () => document.removeEventListener('keydown', onKey, true);
}

/* ---------- 잠금 화면 ---------- */

export function lock() {
  if (!config) return Promise.resolve();
  if (lockedPromise) return lockedPromise;
  document.body.classList.add('locked');
  const screen = el(`
    <div class="lock-screen" role="dialog" aria-modal="true" aria-label="잠금 화면">
      <div class="lock-box">
        <div class="lock-icon">${icon('lock')}</div>
        <h2>사진 보관함</h2>
        <p class="lock-msg">PIN 4자리를 입력하세요</p>
        <div class="pin-dots"></div>
        ${keypadHTML()}
        <button type="button" class="text-btn lock-forgot">PIN을 잊으셨나요?</button>
      </div>
    </div>`);
  document.body.appendChild(screen);
  let fails = 0;
  const msg = screen.querySelector('.lock-msg');
  lockedPromise = new Promise((resolve) => {
    const detach = attachKeypad(screen, async (pin) => {
      if (await checkPin(pin)) {
        detach();
        screen.classList.add('unlocking');
        document.body.classList.remove('locked');
        setTimeout(() => screen.remove(), 220);
        lockedPromise = null;
        resolve();
        return true;
      }
      fails++;
      if (fails >= 5) {
        screen.classList.add('cooldown');
        let left = 30;
        msg.textContent = `잘못 입력한 횟수가 많아요. ${left}초 뒤에 다시 시도하세요`;
        const t = setInterval(() => {
          left--;
          msg.textContent = `잘못 입력한 횟수가 많아요. ${left}초 뒤에 다시 시도하세요`;
          if (left <= 0) {
            clearInterval(t);
            fails = 0;
            screen.classList.remove('cooldown');
            msg.textContent = 'PIN 4자리를 입력하세요';
          }
        }, 1000);
      } else {
        msg.textContent = `PIN이 맞지 않아요 (${fails}/5)`;
      }
      return false;
    });
    screen.querySelector('.lock-forgot').addEventListener('click', () => onForgot?.());
  });
  return lockedPromise;
}

/** 새 PIN 입력(두 번 확인). 성공하면 PIN 문자열, 취소하면 null */
export function askNewPin() {
  return new Promise((resolve) => {
    const screen = el(`
      <div class="lock-screen setup" role="dialog" aria-modal="true" aria-label="PIN 설정">
        <div class="lock-box">
          <div class="lock-icon">${icon('lock')}</div>
          <h2>새 PIN 설정</h2>
          <p class="lock-msg">사용할 숫자 4자리를 입력하세요</p>
          <div class="pin-dots"></div>
          ${keypadHTML()}
          <button type="button" class="text-btn" data-cancel>취소</button>
        </div>
      </div>`);
    document.body.appendChild(screen);
    const msg = screen.querySelector('.lock-msg');
    let first = null;
    const finish = (v) => {
      detach();
      screen.remove();
      resolve(v);
    };
    const detach = attachKeypad(screen, async (pin) => {
      if (!first) {
        first = pin;
        msg.textContent = '확인을 위해 한 번 더 입력하세요';
        return 'reset';
      }
      if (pin === first) {
        finish(pin);
        return true;
      }
      first = null;
      msg.textContent = '두 번 입력한 PIN이 달라요. 처음부터 다시 입력하세요';
      return false;
    });
    screen.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
  });
}

/** 현재 PIN 확인 (설정 변경 전에) */
export function verifyPin(title = '현재 PIN 입력') {
  return new Promise((resolve) => {
    const screen = el(`
      <div class="lock-screen setup" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="lock-box">
          <div class="lock-icon">${icon('lock')}</div>
          <h2>${esc(title)}</h2>
          <p class="lock-msg">지금 쓰고 있는 PIN을 입력하세요</p>
          <div class="pin-dots"></div>
          ${keypadHTML()}
          <button type="button" class="text-btn" data-cancel>취소</button>
        </div>
      </div>`);
    document.body.appendChild(screen);
    const finish = (v) => {
      detach();
      screen.remove();
      resolve(v);
    };
    const detach = attachKeypad(screen, async (pin) => {
      if (await checkPin(pin)) {
        finish(true);
        return true;
      }
      screen.querySelector('.lock-msg').textContent = 'PIN이 맞지 않아요';
      return false;
    });
    screen.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
  });
}
