// views.js — canvas displays: pattern view (MOD), scrolling waveform (audio),
// and the overview strip used for needle-search.


const HOTCUE_COLORS = ['#ff3b6b', '#3bff9d', '#3bb8ff', '#ffd23b'];
export { HOTCUE_COLORS };

/** Resize a canvas' backing store to its CSS size × devicePixelRatio. */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
}

// Column layouts for the pattern view, widest first. We pick the widest that
// fits the screen at a readable size. Widths are in characters incl. spacing.
const LAYOUTS = [
  { cols: [[0, 0], [1, 4], [2, 7], [3, 11]], w: 16 },  // C-5 01 v64 A0F
  { cols: [[0, 0], [1, 4], [3, 7]], w: 12 },           // C-5 01 A0F
  { cols: [[0, 0], [3, 4]], w: 9 },                    // C-5 A0F
  { cols: [[0, 0]], w: 5 },                            // C-5
];
const COL_COLOR = ['#e8eef8', '#5fd3ff', '#7ee08a', '#ffb347'];
const MIN_FONT = 10;

/** How the pattern view lays out channels right now (also used for swipe-to-scroll). */
export function patternLayout(w, nch, hasVol) {
  const layouts = hasVol ? LAYOUTS : LAYOUTS.slice(1);
  for (const L of layouts) {
    const font = (w / (4 + nch * L.w)) / 0.62;
    if (font >= MIN_FONT) return { layout: L, font: Math.min(22, font), visible: nch };
  }
  const L = LAYOUTS[LAYOUTS.length - 1];
  const charW = MIN_FONT * 0.62;
  return { layout: L, font: MIN_FONT, visible: Math.max(1, Math.floor((w / charW - 4) / L.w)) };
}

const isEmpty = (t) => !t || /^[.\s]*$/.test(t);

export function drawPatternView(canvas, deck) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#07090c';
  ctx.fillRect(0, 0, w, h);
  const view = deck.view, st = deck.state;
  if (!view || !st) return;

  const nch = view.channels;
  const rpb = deck.rowsPerBeat;
  const { layout, font, visible } = patternLayout(w, nch, view.hasVolumeColumn);
  const first = Math.max(0, Math.min(deck.channelOffset || 0, nch - visible));
  deck.channelOffset = first;
  const charW = font * 0.62;
  const rowH = Math.round(font * 1.35);
  ctx.font = `${font}px "SF Mono", Menlo, Consolas, "Roboto Mono", monospace`;
  ctx.textBaseline = 'middle';

  // Smooth scrolling between rows using the tick.
  const frac = st.speed ? Math.min(st.tick / st.speed, 0.999) : 0;
  const centerY = h / 2;
  const span = Math.ceil(h / rowH / 2) + 1;
  const xStart = Math.max(4, (w - (4 + visible * layout.w) * charW) / 2);
  const loopStart = st.loop ? view.absRow(st.loop.order, st.loop.row) : 0;

  for (let k = -span; k <= span; k++) {
    const p = view.step(st.order, st.row, k);
    if (!p) continue;
    const y = centerY + (k - frac) * rowH;
    if (p.row % (rpb * 4) === 0) { ctx.fillStyle = '#1a2230'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    else if (p.row % rpb === 0) { ctx.fillStyle = '#121822'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    if (p.row === 0) { ctx.fillStyle = '#3a4a66'; ctx.fillRect(0, y - rowH / 2, w, 1); }
    if (st.loop) {
      const rel = view.absRow(p.order, p.row) - loopStart;
      if (rel >= 0 && rel < st.loop.length) { ctx.fillStyle = 'rgba(60,220,120,0.13)'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    }

    const pat = view.orderPattern(p.order);
    let x = xStart;
    ctx.fillStyle = p.row % rpb === 0 ? '#9fb3d1' : '#56657d';
    ctx.fillText(p.row.toString(16).toUpperCase().padStart(2, '0'), x, y);
    x += charW * 4;
    for (let c = first; c < first + visible; c++) {
      const cell = view.cell(pat, p.row, c);
      ctx.globalAlpha = deck.mutes[c] ? 0.25 : 1;
      for (const [col, off] of layout.cols) {
        const t = cell[col];
        ctx.fillStyle = isEmpty(t) ? '#2e3746' : COL_COLOR[col];
        ctx.fillText(t || '...', x + off * charW, y);
      }
      ctx.globalAlpha = 1;
      x += charW * layout.w;
    }
  }
  // Channel numbers when only some channels fit (swipe sideways to see the rest).
  if (visible < nch) {
    ctx.fillStyle = 'rgba(7,9,12,0.85)';
    ctx.fillRect(0, 0, w, rowH);
    ctx.fillStyle = '#9fb3d1';
    let x = xStart + charW * 4;
    for (let c = first; c < first + visible; c++) { ctx.fillText(String(c + 1), x, rowH / 2); x += charW * layout.w; }
    ctx.textAlign = 'right';
    ctx.fillText(`ch ${first + 1}–${first + visible} of ${nch}  ⇆`, w - 6, rowH / 2);
    ctx.textAlign = 'start';
  }
  // Play line.
  ctx.strokeStyle = '#ff8c1a';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, centerY - rowH / 2, w - 2, rowH);
}

export function drawWaveView(canvas, deck) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#07090c';
  ctx.fillRect(0, 0, w, h);
  const a = deck.audio;
  if (!a) return;
  const frame = deck.extrapolatedFrame();
  const secondsVisible = 6;
  const framesPerPx = (secondsVisible * a.sampleRate) / w;
  const startFrame = frame - (w / 2) * framesPerPx;
  const mid = h / 2;

  // Loop region.
  const L = deck.state && deck.state.loop;
  if (L) {
    const x0 = (L.start - startFrame) / framesPerPx, x1 = (L.end - startFrame) / framesPerPx;
    ctx.fillStyle = 'rgba(60,220,120,0.15)';
    ctx.fillRect(x0, 0, x1 - x0, h);
  }

  // Beat grid.
  if (deck.bpmAudio > 0) {
    const bf = (60 / deck.bpmAudio) * a.sampleRate;
    let b = Math.ceil((startFrame - deck.gridOffset) / bf);
    for (;; b++) {
      const f = deck.gridOffset + b * bf;
      const x = (f - startFrame) / framesPerPx;
      if (x > w) break;
      ctx.fillStyle = ((b % 4) + 4) % 4 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)';
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
  }

  ctx.fillStyle = '#3bb8ff';
  for (let x = 0; x < w; x++) {
    const f0 = startFrame + x * framesPerPx, f1 = f0 + framesPerPx;
    if (f1 < 0 || f0 >= a.length) continue;
    const b0 = Math.max(0, Math.floor(f0 / a.peakBin)), b1 = Math.min(a.peaks.length - 1, Math.floor(f1 / a.peakBin));
    let m = 0;
    for (let b = b0; b <= b1; b++) if (a.peaks[b] > m) m = a.peaks[b];
    const hh = m * (h / 2 - 4);
    if (x < w / 2) ctx.fillStyle = '#2a6f99';
    else ctx.fillStyle = '#3bb8ff';
    ctx.fillRect(x, mid - hh, 1, hh * 2 || 1);
  }

  drawMarkersZoomed(ctx, deck, startFrame, framesPerPx, h);
  ctx.fillStyle = '#ff8c1a';
  ctx.fillRect(w / 2 - 1, 0, 2, h);
}

function drawMarkersZoomed(ctx, deck, startFrame, fpp, h) {
  const mark = (p, color) => {
    if (!p) return;
    const x = (p.frame - startFrame) / fpp;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x - 7, 0); ctx.lineTo(x + 7, 0); ctx.lineTo(x, 10); ctx.fill();
    ctx.fillRect(x, 0, 1, h);
  };
  mark(deck.cue, '#ff8c1a');
  deck.hotcues.forEach((hc, i) => mark(hc, HOTCUE_COLORS[i]));
}

/** Overview strip. Returns nothing; use overviewPosAt() for touch → position. */
export function drawOverview(canvas, deck) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#07090c';
  ctx.fillRect(0, 0, w, h);
  if (!deck.loaded || !deck.state) return;
  const toX = (p) => posFraction(deck, p) * w;

  if (deck.rowBased) {
    const v = deck.view;
    const ow = w / v.songLength;
    for (let o = 0; o < v.songLength; o++) {
      if (v.isSeparator(o)) { ctx.fillStyle = '#222'; ctx.fillRect(o * ow + ow / 2 - 0.5, 6, 1, h - 12); continue; }
      const pat = v.orderPattern(o);
      const reached = deck.kind === 'mod' ? deck.timeline.orderTime[o] >= 0 : v.orderTime[o] >= 0;
      ctx.fillStyle = `hsl(${(pat * 47) % 360} 55% ${reached ? 32 : 14}%)`;
      ctx.fillRect(o * ow + 0.5, 6, Math.max(1, ow - 1), h - 12);
      if (ow > 18) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(String(pat), o * ow + 3, 8);
      }
    }
  } else {
    const a = deck.audio, mid = h / 2;
    const perPx = a.peaks.length / w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let b = Math.floor(x * perPx); b < Math.floor((x + 1) * perPx); b++) if (a.peaks[b] > m) m = a.peaks[b];
      const hh = m * (h / 2 - 3);
      ctx.fillStyle = '#2a6f99';
      ctx.fillRect(x, mid - hh, 1, hh * 2 || 1);
    }
  }

  // Played portion dimmed.
  const px = toX(deck.currentPos());
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, px, h);

  // Loop
  const L = deck.state.loop;
  if (L) {
    const p0 = deck.rowBased ? { order: L.order, row: L.row } : { frame: L.start };
    const x0 = toX(p0);
    const x1 = deck.rowBased
      ? x0 + (L.length / Math.max(1, deck.view.orderRows(L.order))) * (w / deck.view.songLength)
      : toX({ frame: L.end });
    ctx.fillStyle = 'rgba(60,220,120,0.35)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
  }

  // Markers
  const tri = (p, color, top) => {
    if (!p) return;
    const x = toX(p);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (top) { ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); }
    else { ctx.moveTo(x - 5, h); ctx.lineTo(x + 5, h); ctx.lineTo(x, h - 7); }
    ctx.fill();
  };
  tri(deck.cue, '#ff8c1a', false);
  deck.hotcues.forEach((hc, i) => tri(hc, HOTCUE_COLORS[i], true));

  ctx.fillStyle = '#fff';
  ctx.fillRect(px - 1, 0, 2, h);
}

function posFraction(deck, p) {
  if (deck.rowBased) return (p.order + p.row / Math.max(1, deck.view.orderRows(p.order))) / deck.view.songLength;
  return p.frame / deck.audio.length;
}

/** Convert an x position on the overview to a deck position (snapped to a bar for MODs). */
export function overviewPosAt(deck, fraction) {
  fraction = Math.max(0, Math.min(0.9999, fraction));
  if (deck.rowBased) {
    const v = deck.view;
    const t = fraction * v.songLength;
    let order = Math.floor(t);
    while (order > 0 && v.isSeparator(order)) order--;
    const rows = Math.max(1, v.orderRows(order));
    const bar = deck.rowsPerBeat * 4;
    const row = Math.min(rows - 1, Math.floor(((t - Math.floor(t)) * rows) / bar) * bar);
    return { order, row };
  }
  return { frame: Math.floor(fraction * deck.audio.length) };
}

/** Rotating platter indicator for the jog wheel. */
export function drawJog(canvas, deck, touchAngle) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(w, h) / 2 - 4, cx = w / 2, cy = h / 2;
  const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grad.addColorStop(0, '#1d232c'); grad.addColorStop(1, '#0d1015');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = deck.playing ? '#ff8c1a' : '#3a4352';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Platter angle: one revolution per 1.8 s of track time (33⅓ rpm), like a CDJ display.
  const angle = (deck.elapsed() / 1.8) * Math.PI * 2 + (touchAngle || 0);
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(angle);
  ctx.fillStyle = '#e8eef8';
  ctx.fillRect(-2, -r + 6, 4, r * 0.35);
  ctx.restore();
  ctx.fillStyle = '#5a6577';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(deck.playing ? 'BEND' : 'SEARCH', cx, cy);
  ctx.textAlign = 'start';
}
