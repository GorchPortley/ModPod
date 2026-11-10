// views.js — canvas displays: pattern view (MOD), scrolling waveform (audio),
// and the overview strip used for needle-search.

import { noteName } from './mod/modfile.js';

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

const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const EFF = '0123456789ABCDEF';

/** Map an (order,row) plus a row offset to the actual position, following the order list. */
function stepRows(song, order, row, k) {
  row += k;
  while (row < 0) { if (order === 0) return null; order--; row += 64; }
  while (row > 63) { if (order >= song.songLength - 1) return null; order++; row -= 64; }
  return { order, row };
}

export function drawPatternView(canvas, deck) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.fillStyle = '#07090c';
  ctx.fillRect(0, 0, w, h);
  const song = deck.song, st = deck.state;
  if (!song || !st) return;

  const nch = song.channels;
  const rpb = deck.settings.rowsPerBeat;
  const charsPerCh = 11;              // "C-2 01 A0F "
  const totalChars = 4 + nch * charsPerCh;
  const fontSize = Math.max(9, Math.min(22, (w / totalChars) / 0.62));
  const charW = fontSize * 0.62;
  const rowH = Math.round(fontSize * 1.35);
  ctx.font = `${fontSize}px "SF Mono", Menlo, Consolas, "Roboto Mono", monospace`;
  ctx.textBaseline = 'middle';

  // Smooth scrolling between rows using the tick.
  const frac = st.speed ? Math.min(st.tick / st.speed, 0.999) : 0;
  const centerY = h / 2;
  const visible = Math.ceil(h / rowH / 2) + 1;
  const xStart = Math.max(4, (w - totalChars * charW) / 2);

  for (let k = -visible; k <= visible; k++) {
    const p = stepRows(song, st.order, st.row, k);
    if (!p) continue;
    const y = centerY + (k - frac) * rowH;
    if (p.row % (rpb * 4) === 0) { ctx.fillStyle = '#1a2230'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    else if (p.row % rpb === 0) { ctx.fillStyle = '#121822'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    if (p.row === 0) { ctx.fillStyle = '#3a4a66'; ctx.fillRect(0, y - rowH / 2, w, 1); }

    // Loop region.
    const L = st.loop;
    if (L) {
      const rel = (p.order - L.order) * 64 + (p.row - L.row);
      if (rel >= 0 && rel < L.length) { ctx.fillStyle = 'rgba(60,220,120,0.13)'; ctx.fillRect(0, y - rowH / 2, w, rowH); }
    }

    const pat = Math.min(song.orders[p.order], song.numPatterns - 1);
    let x = xStart;
    ctx.fillStyle = p.row % rpb === 0 ? '#9fb3d1' : '#56657d';
    ctx.fillText(hex2(p.row), x, y);
    x += charW * 4;
    for (let c = 0; c < nch; c++) {
      const i = (pat * 64 + p.row) * nch + c;
      const muted = deck.mutes[c];
      const note = song.cells.note[i], per = song.cells.period[i];
      const smp = song.cells.sample[i], e = song.cells.effect[i], prm = song.cells.param[i];
      ctx.globalAlpha = muted ? 0.25 : 1;
      ctx.fillStyle = per ? '#e8eef8' : '#2e3746';
      ctx.fillText(per ? (note >= 0 ? noteName(note) : '???') : '...', x, y);
      ctx.fillStyle = smp ? '#5fd3ff' : '#2e3746';
      ctx.fillText(smp ? hex2(smp) : '..', x + charW * 4, y);
      ctx.fillStyle = e || prm ? '#ffb347' : '#2e3746';
      ctx.fillText(e || prm ? EFF[e] + hex2(prm) : '...', x + charW * 7, y);
      ctx.globalAlpha = 1;
      x += charW * charsPerCh;
    }
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

  if (deck.kind === 'mod') {
    const song = deck.song;
    const ow = w / song.songLength;
    for (let o = 0; o < song.songLength; o++) {
      const pat = song.orders[o];
      const reached = deck.timeline.orderTime[o] >= 0;
      ctx.fillStyle = `hsl(${(pat * 47) % 360} 55% ${reached ? 32 : 14}%)`;
      ctx.fillRect(o * ow + 0.5, 6, ow - 1, h - 12);
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
    const p0 = deck.kind === 'mod' ? { order: L.order, row: L.row } : { frame: L.start };
    const x0 = toX(p0);
    const x1 = deck.kind === 'mod'
      ? x0 + (L.length / 64) * (w / deck.song.songLength)
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
  if (deck.kind === 'mod') return (p.order + p.row / 64) / deck.song.songLength;
  return p.frame / deck.audio.length;
}

/** Convert an x position on the overview to a deck position (snapped to a bar for MODs). */
export function overviewPosAt(deck, fraction) {
  fraction = Math.max(0, Math.min(0.9999, fraction));
  if (deck.kind === 'mod') {
    const t = fraction * deck.song.songLength;
    const order = Math.floor(t);
    const bar = deck.settings.rowsPerBeat * 4;
    const row = Math.floor(((t - order) * 64) / bar) * bar;
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
