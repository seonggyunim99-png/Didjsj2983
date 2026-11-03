// 나만의 보정(프리셋)과 보정 복사·붙여넣기
// 사진마다 다른 것(자르기·회전, 잡티·사물 지우기, 그리기, 성형·부분 보정 획, 얼굴별 값)은 빼고
// 색감·밝기·필터·인물 보정 값만 옮깁니다. 이 기기 안에만 저장됩니다.
import * as dv from './develop.js';

const KEY_PRESETS = 'pv-presets';
const KEY_CLIP = 'pv-clip';

const read = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};

/** 편집 상태에서 옮길 수 있는 보정 값만 */
export function pickStyle(st) {
  return JSON.parse(JSON.stringify({
    adj: st.adj,
    curve: st.curve,
    hsl: st.hsl,
    grading: st.grading,
    look: st.look,
    lookAmt: st.lookAmt,
    makeup: st.makeup,
  }));
}

/** 보정 값을 편집 상태에 덮어씀 (사진마다 다른 것은 그대로) */
export function applyStyle(st, style) {
  const d = dv.defaultState();
  const s = JSON.parse(JSON.stringify(style));
  st.adj = { ...d.adj, ...s.adj };
  st.curve = s.curve || d.curve;
  st.hsl = { ...d.hsl, ...s.hsl };
  st.grading = { ...d.grading, ...s.grading };
  st.look = s.look || 'none';
  st.lookAmt = s.lookAmt ?? 1;
  st.makeup = { ...d.makeup, ...s.makeup };
  st.enhance = { ...st.enhance, on: false, prev: null };
  st.faceAdj = {};
  return st;
}

/** 사진을 보며 확인할 수 있게: 값이 하나라도 있는지 */
export function styleChanged(style) {
  const st = applyStyle(dv.defaultState(), style);
  return dv.isEdited(st);
}

/** 이 보정에 얼굴·몸·사람 인식이 필요한지 */
export function styleNeeds(adj) {
  const need = { faces: false, poses: false, person: false };
  for (const a of dv.ADJ) {
    if (!adj[a.key]) continue;
    if (a.face || a.key === 'skinSmooth' || a.key === 'skinTone') need.faces = true;
    if (a.pose) need.poses = true;
    if (a.seg) need.person = true;
  }
  return need;
}

export function listPresets() {
  return read(KEY_PRESETS, []);
}

export function savePreset(name, st) {
  const list = listPresets();
  const item = { id: `p${Date.now().toString(36)}`, name: name.trim().slice(0, 20) || '내 보정', style: pickStyle(st), at: Date.now() };
  list.unshift(item);
  return write(KEY_PRESETS, list.slice(0, 30)) ? item : null;
}

export function deletePreset(id) {
  write(KEY_PRESETS, listPresets().filter((p) => p.id !== id));
}

export function getPreset(id) {
  return listPresets().find((p) => p.id === id) || null;
}

export function setClip(st) {
  write(KEY_CLIP, { style: pickStyle(st), at: Date.now() });
}

export function getClip() {
  return read(KEY_CLIP, null);
}
