// Small SVG chart kit for the admin dashboard.
// Follows the dataviz method: categorical slots by entity (never by rank),
// thin columns with a rounded data-end, 2px surface gaps, hairline grid,
// per-X tooltip listing every series, a legend, and a table-view twin.

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function dayLabel(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function roundedTopPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Stacked columns: one column per day, one segment per series.
 * series: [{ id, name, color, values: number[] }] in legend/stack order (bottom first).
 */
export function stackedColumns(container, { days, series, unit = 'characters', height = 220, emptyText = 'No data in this period' }) {
  container.classList.add('viz', 'viz-root');
  container.innerHTML = '';
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = Math.max(0, ...totals);

  const head = document.createElement('div');
  head.className = 'row-actions';
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.setAttribute('aria-label', 'Legend');
  if (series.length >= 2) {
    for (const s of series) {
      const it = document.createElement('span');
      const sw = document.createElement('i');
      sw.style.background = s.color;
      it.append(sw, document.createTextNode(s.name));
      legend.appendChild(it);
    }
  }
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn';
  toggle.textContent = 'Table view';
  head.append(legend, spacer, toggle);
  container.appendChild(head);

  const plotBox = document.createElement('div');
  plotBox.style.position = 'relative';
  container.appendChild(plotBox);
  const tableBox = document.createElement('div');
  tableBox.className = 'tbl-wrap';
  tableBox.hidden = true;
  container.appendChild(tableBox);

  toggle.addEventListener('click', () => {
    const showTable = tableBox.hidden;
    tableBox.hidden = !showTable;
    plotBox.hidden = showTable;
    toggle.textContent = showTable ? 'Chart view' : 'Table view';
  });

  // ---- table twin
  const tbl = document.createElement('table');
  tbl.className = 'tbl';
  const thead = tbl.createTHead().insertRow();
  const th0 = document.createElement('th');
  th0.textContent = 'Day';
  thead.appendChild(th0);
  for (const s of [...series, { name: 'Total' }]) {
    const th = document.createElement('th');
    th.className = 'num';
    th.textContent = s.name;
    thead.appendChild(th);
  }
  const tb = tbl.createTBody();
  for (let i = days.length - 1; i >= 0; i--) {
    if (!totals[i]) continue;
    const tr = tb.insertRow();
    tr.insertCell().textContent = days[i];
    for (const s of series) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = (s.values[i] || 0).toLocaleString();
    }
    const td = tr.insertCell();
    td.className = 'num';
    td.textContent = totals[i].toLocaleString();
  }
  if (!tb.rows.length) {
    const tr = tb.insertRow();
    const td = tr.insertCell();
    td.colSpan = series.length + 2;
    td.className = 'empty';
    td.textContent = emptyText;
  }
  tableBox.appendChild(tbl);

  if (!max) {
    plotBox.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = emptyText;
    plotBox.appendChild(e);
    return;
  }

  // ---- chart
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'status');

  const draw = () => {
    const W = Math.max(280, plotBox.clientWidth || container.clientWidth || 600);
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const full = top < 10000;
    const fmt = (v) => (full ? Math.round(v).toLocaleString() : compact(v));
    const left = Math.max(...ticks.map((t) => fmt(t).length)) * 7 + 14;
    const right = 8;
    const axisBand = 26;
    const H = height + axisBand;
    const plotW = W - left - right;
    const band = plotW / days.length;
    const barW = Math.max(2, Math.min(24, band * 0.66));
    const y = (v) => height - (v / top) * (height - 8);
    plotBox.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Daily ${unit} by engine` });
    const grid = el('g', { class: 'grid' }, svg);
    for (const t of ticks) {
      if (t > 0) el('line', { x1: left, x2: W - right, y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5 }, grid);
      const lab = el('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      lab.textContent = fmt(t);
    }
    el('line', { class: 'baseline', x1: left, x2: W - right, y1: height + 0.5, y2: height + 0.5 }, svg);
    const every = Math.max(1, Math.ceil(48 / band));
    days.forEach((d, i) => {
      if ((days.length - 1 - i) % every !== 0) return;
      const t = el('text', { x: left + band * i + band / 2, y: height + 17, 'text-anchor': 'middle', class: 'tick' }, svg);
      t.textContent = dayLabel(d);
    });
    const bars = el('g', {}, svg);
    days.forEach((d, i) => {
      const x = left + band * i + (band - barW) / 2;
      let acc = 0;
      const segs = series.map((s) => ({ s, v: s.values[i] || 0 })).filter((x2) => x2.v > 0);
      segs.forEach((seg, k) => {
        const y0 = y(acc);
        acc += seg.v;
        const y1 = y(acc);
        const isTop = k === segs.length - 1;
        const gap = isTop ? 0 : 2;
        const h = y0 - y1 - gap;
        if (h <= 0.4) return;
        const yy = y1 + gap;
        if (isTop) el('path', { d: roundedTopPath(x, yy, barW, h, 4), fill: seg.s.color }, bars);
        else el('rect', { x, y: yy, width: barW, height: h, fill: seg.s.color }, bars);
      });
    });
    // hover / focus bands (hit target = the whole day slot, not just the painted bar)
    const hits = el('g', {}, svg);
    days.forEach((d, i) => {
      const r = el('rect', { class: 'band', x: left + band * i, y: 0, width: band, height, tabindex: totals[i] ? 0 : -1 }, hits);
      const label = `${dayLabel(d)}: ${totals[i].toLocaleString()} ${unit}`;
      r.setAttribute('aria-label', label);
      const show = () => {
        tip.innerHTML = '';
        const dt = document.createElement('div');
        dt.className = 'tt-date';
        dt.textContent = dayLabel(d);
        tip.appendChild(dt);
        for (const s of [...series].reverse()) {
          const row = document.createElement('div');
          row.className = 'tt-row';
          const key = document.createElement('i');
          key.style.background = s.color;
          const val = document.createElement('b');
          val.textContent = (s.values[i] || 0).toLocaleString();
          const nm = document.createElement('span');
          nm.textContent = s.name;
          row.append(key, val, nm);
          tip.appendChild(row);
        }
        if (series.length > 1) {
          const tot = document.createElement('div');
          tot.className = 'tt-row tt-total';
          const key = document.createElement('i');
          const val = document.createElement('b');
          val.textContent = totals[i].toLocaleString();
          const nm = document.createElement('span');
          nm.textContent = `total ${unit}`;
          tot.append(key, val, nm);
          tip.appendChild(tot);
        }
        tip.hidden = false;
        const cx = left + band * i + band / 2;
        const tw = tip.offsetWidth;
        const px = Math.min(Math.max(0, cx * (plotBox.clientWidth / W) - tw / 2), plotBox.clientWidth - tw);
        tip.style.left = `${px}px`;
        tip.style.top = `${Math.max(0, y(totals[i]) * (plotBox.clientWidth / W) - tip.offsetHeight - 10)}px`;
        r.classList.add('on');
      };
      const hide = () => {
        tip.hidden = true;
        r.classList.remove('on');
      };
      r.addEventListener('pointerenter', show);
      r.addEventListener('pointerleave', hide);
      r.addEventListener('focus', show);
      r.addEventListener('blur', hide);
    });
    plotBox.appendChild(svg);
    plotBox.appendChild(tip);
  };
  draw();
  let lastW = plotBox.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(plotBox.clientWidth - lastW) > 4 && !plotBox.hidden) {
      lastW = plotBox.clientWidth;
      draw();
    }
  });
  ro.observe(plotBox);
}

/** A ratio against a limit. Severity lives in the fill; label carries icon + words. */
export function meterHtml(used, limit, period, iconFn) {
  const pct = limit ? used / limit : 0;
  const color = pct >= 1 ? '#d03b3b' : pct >= 0.8 ? '#fab219' : 'var(--series-1, #2a78d6)';
  const state = pct >= 1 ? ['alert', 'limit reached'] : pct >= 0.8 ? ['alert', 'near the limit'] : null;
  const width = Math.min(100, Math.round(pct * 1000) / 10);
  return `<div class="meter" style="--m:${color}">
    <div class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}" aria-label="${period} usage"><div class="meter-fill" style="width:${width}%"></div></div>
    <div class="meter-label">${state ? iconFn(state[0]) : ''}<span>${used.toLocaleString()} / ${compact(limit)} chars ${period}${state ? ` — ${state[1]}` : ''} (${Math.round(pct * 100)}%)</span></div>
  </div>`;
}
