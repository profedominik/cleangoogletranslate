// Per-device view preferences (localStorage), seeded from server defaults.
const KEY = 'ct:prefs';

const DEFAULTS = {
  lineNumbers: true,
  zebra: true,
  highlight: true,
  showTranslation: true,
  layout: 'auto', // auto | side | stacked
  fontSize: 16,
  font: 'sans', // sans | serif | mono
  lineHeight: 1.55,
  theme: 'auto',
  split: 0.5,
  drawerPinned: false,
  lastSource: null,
  lastTarget: null,
  lastEngine: null,
  lastNote: null,
};

let state = { ...DEFAULTS };
const listeners = new Set();

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export const prefs = {
  init(serverUi = {}) {
    const stored = read();
    state = { ...DEFAULTS, ...serverUi, ...stored };
    return state;
  },
  get(k) {
    return state[k];
  },
  all() {
    return { ...state };
  },
  set(k, v) {
    if (state[k] === v) return;
    state[k] = v;
    try {
      const stored = read();
      stored[k] = v;
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch { /* private mode */ }
    for (const fn of listeners) fn(k, v);
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
