// Small UI toolkit: toasts, popover menus, modals, formatting helpers.
import { icon, hydrateIcons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

// ------------------------------------------------------------------ toasts
export function toast(message, { type = '', timeout = 4200, action, onAction } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="t-msg"></span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.querySelector('.t-msg').textContent = message;
  const close = () => el.remove();
  if (action) el.querySelector('button').addEventListener('click', () => { close(); onAction?.(); });
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ------------------------------------------------------------------ popover
let popCleanup = null;

export function closePopover() {
  if (popCleanup) {
    const f = popCleanup;
    popCleanup = null;
    f();
  }
}

export function isPopoverOpen() {
  return !$('#popover').hidden;
}

/** Position the popover near an anchor element or a {x, y} point. */
export function openPopover(anchor, build, { onClose, align = 'start', keepFocus = false } = {}) {
  closePopover();
  const pop = $('#popover');
  pop.innerHTML = '';
  pop.hidden = false;
  build(pop);
  hydrateIcons(pop);
  const place = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 4;
    if (top + ph > vh - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4;
    top = Math.max(8, Math.min(top, vh - ph - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };
  place();
  const onDown = (e) => {
    if (!pop.contains(e.target) && !(anchor.contains && anchor.contains(e.target))) closePopover();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  window.addEventListener('resize', closePopover, { once: true });
  popCleanup = () => {
    pop.hidden = true;
    pop.innerHTML = '';
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  if (!keepFocus) pop.querySelector('input, button')?.focus({ preventScroll: true });
  return { pop, place };
}

/**
 * items: [{ label, icon, hint, desc, onClick, danger, disabled } | 'sep' | { title }]
 */
export function openMenu(anchor, items, opts = {}) {
  return openPopover(anchor, (pop) => {
    pop.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === 'sep') {
        pop.insertAdjacentHTML('beforeend', '<div class="menu-sep" role="separator"></div>');
        continue;
      }
      if (it.title) {
        pop.insertAdjacentHTML('beforeend', `<div class="menu-title">${esc(it.title)}</div>`);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `menu-item${it.danger ? ' danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      b.innerHTML = `${it.html ?? (it.icon ? icon(it.icon) : '')}<span>${esc(it.label)}${it.desc ? `<span class="mi-desc">${esc(it.desc)}</span>` : ''}</span>${it.hint ? `<span class="mi-hint">${esc(it.hint)}</span>` : ''}`;
      b.addEventListener('click', () => {
        closePopover();
        it.onClick?.();
      });
      pop.appendChild(b);
    }
    pop.addEventListener('keydown', (e) => {
      const btns = [...pop.querySelectorAll('.menu-item:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    });
  }, opts);
}

// ------------------------------------------------------------------ modal
export function openModal({ title, body, buttons = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close data-icon="x" title="Close"></button></div>
    <div class="modal-body"></div><div class="modal-foot"></div></div>`;
  const bodyEl = back.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = back.querySelector('.modal-foot');
  const prevFocus = document.activeElement;
  const close = (v) => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(v);
    prevFocus?.focus?.({ preventScroll: true });
  };
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`;
    el.textContent = b.label;
    el.addEventListener('click', async () => {
      const r = await b.onClick?.(el);
      if (r !== false) close(b.value);
    });
    foot.appendChild(el);
  }
  if (!buttons.length) foot.remove();
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-close]').addEventListener('click', () => close());
  document.body.appendChild(back);
  hydrateIcons(back);
  (back.querySelector('.modal-body input, .modal-body select, .modal-foot .btn.primary') || back.querySelector('[data-close]')).focus();
  return { el: back, body: bodyEl, close };
}

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      buttons: [
        { label: 'Cancel', onClick: () => { result = false; } },
        { label: ok, primary: !danger, danger, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
