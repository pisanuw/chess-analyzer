// Small SVG charts: horizontal bars, a single-series line, and the game eval graph. No dependencies.
import { esc, formatEval, movePrefix } from './api.js';
import { spentPerMove, winProb } from './shared.js';

const flaggedJudgment = j => j === 'inaccuracy' || j === 'mistake' || j === 'blunder';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function tooltip(container) {
  let tip = container.querySelector('.tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; container.appendChild(tip); }
  return {
    show(x, y, html) { tip.innerHTML = html; tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.style.display = 'block'; },
    hide() { tip.style.display = 'none'; },
  };
}

/** Horizontal bar chart. items: [{ label, value, sub }] sorted by caller. */
export function barChart(container, items, { format = v => String(v), maxValue = null, onClick = null } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const rowH = 26, labelW = 150, valueW = 46, W = Math.max(360, container.clientWidth || 600), H = items.length * rowH + 8;
  const max = maxValue || Math.max(...items.map(i => i.value), 1);
  const plotW = W - labelW - valueW - 8;
  const label = `Bar chart: ${items.map(i => `${i.label} ${format(i.value)}`).join(', ')}`.slice(0, 400);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  const tip = tooltip(container);
  items.forEach((it, i) => {
    const y = i * rowH + 4;
    const w = Math.max(0, (it.value / max) * plotW);
    svg.appendChild(svgEl('text', { x: labelW - 8, y: y + 16, 'text-anchor': 'end' }, it.label));
    const bar = svgEl('rect', { x: labelW, y: y + 4, width: w, height: rowH - 10, rx: 0, class: 'bar' + (it.dim ? ' dim' : '') });
    svg.appendChild(bar);
    if (w > 0) svg.appendChild(svgEl('rect', { x: labelW + Math.max(0, w - 4), y: y + 4, width: Math.min(4, w), height: rowH - 10, rx: 2, class: 'bar' + (it.dim ? ' dim' : '') }));
    svg.appendChild(svgEl('text', { x: labelW + w + 6, y: y + 16 }, format(it.value)));
    const hit = svgEl('rect', { x: 0, y, width: W, height: rowH, class: 'hit' });
    hit.addEventListener('mousemove', e => {
      const r = container.getBoundingClientRect();
      tip.show(e.clientX - r.left, e.clientY - r.top, `<b>${esc(it.label)}</b> ${esc(format(it.value))}${it.sub ? '<br>' + esc(it.sub) : ''}`);
    });
    hit.addEventListener('mouseleave', () => tip.hide());
    if (onClick) hit.addEventListener('click', () => onClick(it));
    svg.appendChild(hit);
  });
  svg.appendChild(svgEl('line', { x1: labelW, y1: 0, x2: labelW, y2: H, class: 'base' }));
  container.appendChild(svg);
}

/** Single-series line chart. points: [{ x: label, y: number, sub }]. */
export function lineChart(container, points, { yMin = 0, yMax = 100, format = v => String(v), onClick = null } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  if (points.length < 1) { container.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const W = Math.max(360, container.clientWidth || 600), H = 180, padL = 36, padR = 12, padT = 10, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xs = i => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const ys = v => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const label = `Line chart of ${points.length} point${points.length === 1 ? '' : 's'}, from ${format(points[0].y)} to ${format(points[points.length - 1].y)}`;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  for (const t of [yMin, (yMin + yMax) / 2, yMax]) {
    svg.appendChild(svgEl('line', { x1: padL, y1: ys(t), x2: W - padR, y2: ys(t), class: 'axis' }));
    svg.appendChild(svgEl('text', { x: padL - 6, y: ys(t) + 4, 'text-anchor': 'end' }, format(t)));
  }
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('path', { d, class: 'line' }));
  const tip = tooltip(container);
  const cursor = svgEl('line', { x1: 0, y1: padT, x2: 0, y2: padT + plotH, class: 'cursor', visibility: 'hidden' });
  svg.appendChild(cursor);
  points.forEach((p, i) => {
    svg.appendChild(svgEl('circle', { cx: xs(i), cy: ys(p.y), r: 4, class: 'dot' }));
    if (points.length <= 12 || i % Math.ceil(points.length / 12) === 0) {
      svg.appendChild(svgEl('text', { x: xs(i), y: H - 6, 'text-anchor': 'middle' }, p.x));
    }
  });
  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, class: 'hit' });
  const idxAt = e => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(points.length - 1, Math.round(((px - padL) / plotW) * (points.length - 1))));
  };
  hit.addEventListener('mousemove', e => {
    const i = idxAt(e);
    const p = points[i];
    cursor.setAttribute('x1', xs(i)); cursor.setAttribute('x2', xs(i)); cursor.setAttribute('visibility', 'visible');
    const r = container.getBoundingClientRect();
    tip.show(e.clientX - r.left, e.clientY - r.top, `<b>${esc(p.x)}</b> ${esc(format(p.y))}${p.sub ? '<br>' + esc(p.sub) : ''}`);
  });
  hit.addEventListener('mouseleave', () => { tip.hide(); cursor.setAttribute('visibility', 'hidden'); });
  if (onClick) hit.addEventListener('click', e => onClick(points[idxAt(e)]));
  svg.appendChild(hit);
  container.appendChild(svg);
}

const fmtSpent = s => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;

/** Eval graph across a game: white win probability by ply, with player moments
 * marked and, when the PGN has clocks, a time-spent strip underneath (the
 * classic patterns: the long think before the blunder, the blitzed collapse). */
export function evalGraph(container, moves, { currentPly = 0, onSelect = null, timeControl = null } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  const n = moves.length;
  if (!n) return;
  const spents = spentPerMove(moves, timeControl);
  const hasTime = spents.some(s => s != null);
  const W = Math.max(300, container.clientWidth || 520), pad = 4;
  const evalH = 110, timeH = hasTime ? 30 : 0, H = evalH + timeH;
  const xs = ply => pad + (ply / n) * (W - 2 * pad);
  // White's win probability after the move: the stored mover-perspective value,
  // or derived from the White-POV eval for a record that lacks it.
  const wpWhite = m => (m.wpAfter != null ? (m.color === 'white' ? m.wpAfter : 100 - m.wpAfter) : winProb(m.evalAfter ?? 0));
  const ys = wp => pad + (1 - wp / 100) * (evalH - 2 * pad);
  const flagged = moves.filter(m => m.isPlayer && flaggedJudgment(m.judgment)).length;
  const label = `Evaluation graph across ${n} move${n === 1 ? '' : 's'}, White win probability; ${flagged} flagged player moment${flagged === 1 ? '' : 's'}`;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, style: 'background: var(--surface-2); border-radius: 6px' });
  let d = `M${xs(0)},${ys(50)}`;
  moves.forEach(m => { d += ` L${xs(m.ply).toFixed(1)},${ys(wpWhite(m)).toFixed(1)}`; });
  svg.appendChild(svgEl('path', { d: d + ` L${xs(n)},${ys(0)} L${xs(0)},${ys(0)} Z`, class: 'area' }));
  svg.appendChild(svgEl('path', { d, class: 'line' }));
  svg.appendChild(svgEl('line', { x1: pad, y1: ys(50), x2: W - pad, y2: ys(50), class: 'axis' }));
  for (const m of moves) {
    if (m.isPlayer && flaggedJudgment(m.judgment)) {
      svg.appendChild(svgEl('circle', { cx: xs(m.ply), cy: ys(wpWhite(m)), r: m.judgment === 'inaccuracy' ? 3 : 4.5, class: 'dot flagged' }));
    }
  }
  if (hasTime) {
    const maxSpent = Math.max(30, ...spents.filter(s => s != null));
    svg.appendChild(svgEl('line', { x1: pad, y1: evalH, x2: W - pad, y2: evalH, class: 'axis' }));
    const bw = Math.max(1, (W - 2 * pad) / n - 1);
    moves.forEach((m, i) => {
      if (!spents[i]) return;
      const h = Math.max(1.5, (spents[i] / maxSpent) * (timeH - 6));
      svg.appendChild(svgEl('rect', { x: (xs(m.ply) - bw / 2).toFixed(1), y: (H - pad - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), class: `tbar ${m.color}` }));
    });
  }
  const cursor = svgEl('line', { x1: xs(currentPly), y1: pad, x2: xs(currentPly), y2: H - pad, class: 'cursor' });
  svg.appendChild(cursor);
  const tip = tooltip(container);
  const hit = svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'hit' });
  const plyAt = e => {
    const r = svg.getBoundingClientRect();
    return Math.max(1, Math.min(n, Math.round(((e.clientX - r.left) / r.width) * n)));
  };
  hit.addEventListener('mousemove', e => {
    const ply = plyAt(e);
    const m = moves[ply - 1];
    const r = container.getBoundingClientRect();
    const think = spents[ply - 1] != null ? ` · ${fmtSpent(spents[ply - 1])} think` : '';
    tip.show(e.clientX - r.left, e.clientY - r.top, `<b>${movePrefix(m)} ${esc(m.san)}</b> ${esc(formatEval(m.evalAfter))}${flaggedJudgment(m.judgment) ? ' (' + m.judgment + ')' : ''}${think}`);
  });
  hit.addEventListener('mouseleave', () => tip.hide());
  if (onSelect) hit.addEventListener('click', e => onSelect(plyAt(e)));
  svg.appendChild(hit);
  container.appendChild(svg);
  return { setPly(ply) { cursor.setAttribute('x1', xs(ply)); cursor.setAttribute('x2', xs(ply)); } };
}

