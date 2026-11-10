// app.js — wires the Deck to the screen: buttons, fader, jog, displays.

import { Deck } from './deck.js';
import { LibraryUI } from './library/library-ui.js';
import { drawPatternView, drawWaveView, drawOverview, overviewPosAt, drawJog, patternLayout } from './views.js';

const $ = (id) => document.getElementById(id);
const deck = new Deck();
window.deck = deck; // handy for poking at from the browser console

// ---------------------------------------------------------------- helpers

function toast(msg, ms = 3500, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Press handler that fires on pointer down (no click delay) with optional up + long-press. */
function press(el, { down, up, long, longMs = 600 }) {
  let timer = null, longFired = false;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    el.classList.add('pressed');
    longFired = false;
    if (long) timer = setTimeout(() => { longFired = true; long(e); }, longMs);
    if (down) down(e);
  });
  const end = (e) => {
    el.classList.remove('pressed');
    clearTimeout(timer);
    if (up) up(e, longFired);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '-:--.-';
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- loading

async function loadFile(file, libraryId = null) {
  try {
    $('track-title').textContent = 'Loading…';
    await deck.loadFile(file, libraryId);
  } catch (err) {
    console.warn(err);
    toast(err.message || String(err), 5000, true);
    $('track-title').textContent = deck.kind ? trackTitle() : 'No track loaded';
    throw err;
  }
}

const library = new LibraryUI({
  toast,
  onLoad: async (blob, meta) => {
    if (deck.playing && !confirm('This deck is playing. Load a new track anyway?')) throw new Error('cancelled');
    await loadFile(new File([blob], meta.name), meta.id);
  },
});
window.library = library;

$('btn-load').addEventListener('click', () => library.show());
$('btn-demo').addEventListener('click', () => library.show());
$('lib-demo').addEventListener('click', async () => {
  const res = await fetch('demo/modpod-demo.mod');
  await library.importFiles([new File([await res.blob()], 'modpod-demo.mod')]);
});
// Drag & drop (desktop testing): import into the library.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) { library.show(); library.importFiles([...e.dataTransfer.files]); }
});

// Fill in things the library only learns once a track is decoded / tapped.
deck.addEventListener('loaded', () => {
  if (deck.kind === 'audio') library.learn(deck.libraryId, { duration: deck.audio.duration, bpm: deck.bpmAudio });
});
deck.addEventListener('grid', () => library.learn(deck.libraryId, { bpm: deck.bpmAudio }));

function trackTitle() {
  if (deck.kind === 'mod') return deck.song.title;
  if (deck.kind === 'tracker') return deck.view.title;
  return deck.name.replace(/\.[^.]+$/, '');
}

deck.addEventListener('loaded', () => {
  $('empty-hint').hidden = true;
  deck.channelOffset = 0;
  $('track-title').textContent = trackTitle();
  if (deck.kind === 'mod') {
    const s = deck.song;
    $('track-info').textContent =
      `MOD ${s.tag} · ${s.channels} ch · ${s.songLength} orders · ${fmtTime(deck.timeline.duration).slice(0, -2)} · ${deck.name}`;
  } else if (deck.kind === 'tracker') {
    const v = deck.view;
    $('track-info').textContent =
      `${v.format} · ${v.channels} ch · ${v.songLength} orders · ${fmtTime(v.duration).slice(0, -2)}${v.artist ? ' · ' + v.artist : ''} · ${deck.name}`;
  } else {
    const a = deck.audio;
    $('track-info').textContent = `${(a.sampleRate / 1000).toFixed(1)} kHz · ${fmtTime(a.duration).slice(0, -2)} · ${deck.name}`;
  }
  buildChannelButtons();
  updateStaticButtons();
});

deck.addEventListener('ended', () => toast('Track ended'));
deck.addEventListener('error', () => toast(deck.lastError, 5000, true));

// ---------------------------------------------------------------- transport

press($('btn-play'), { down: () => deck.togglePlay() });
press($('btn-cue'), { down: () => deck.cueDown(), up: () => deck.cueUp() });

document.querySelectorAll('.hc').forEach((el) => {
  const i = +el.dataset.i;
  press(el, {
    down: () => deck.hotcue(i),
    long: () => { deck.clearHotcue(i); toast(`Hot cue ${'ABCD'[i]} cleared`, 1200); },
    longMs: 800,
  });
});

// ---------------------------------------------------------------- loops

const LOOP_SIZES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
let loopSizeIdx = 4;
const loopActive = () => !!(deck.state && deck.state.loop);
const sizeLabel = (b) => (b < 1 ? `1/${1 / b}` : String(b)) + ' BEAT';

press($('btn-loop-in'), { down: () => deck.loop('in') });
press($('btn-loop-out'), { down: () => deck.loop('out') });
press($('btn-loop-exit'), { down: () => deck.loop(loopActive() ? 'exit' : 'reloop') });
press($('btn-autoloop'), {
  down: () => {
    if (deck.kind === 'audio' && !deck.bpmAudio) { toast('Tap the BPM first (TAP) so auto-loops know how long a beat is.'); return; }
    deck.loop(loopActive() ? 'exit' : 'auto', { beats: LOOP_SIZES[loopSizeIdx] });
  },
});
function scaleLoop(dir) {
  loopSizeIdx = Math.max(0, Math.min(LOOP_SIZES.length - 1, loopSizeIdx + dir));
  if (loopActive()) deck.loop('scale', { factor: dir > 0 ? 2 : 0.5 });
  $('btn-autoloop').textContent = sizeLabel(LOOP_SIZES[loopSizeIdx]);
}
press($('btn-loop-half'), { down: () => scaleLoop(-1) });
press($('btn-loop-double'), { down: () => scaleLoop(1) });
press($('btn-quant'), { down: () => { deck.setSetting('quantize', !deck.settings.quantize); updateStaticButtons(); } });

// Tap tempo (audio tracks — MODs know their own tempo). Hold TAP to type a BPM.
let taps = [];
press($('btn-tap'), {
  down: () => {
    if (deck.kind !== 'audio') { toast('Tracker files know their own BPM. If it reads double or half, change rows per beat in ⚙ Settings.'); return; }
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 4) {
      const bpm = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1));
      // Put a grid line where the user tapped (compensating for output latency).
      const lat = (deck.ctx.outputLatency || deck.ctx.baseLatency || 0) * deck.audio.sampleRate * deck.rate;
      deck.setGrid(Math.round(bpm * 10) / 10, Math.max(0, deck.extrapolatedFrame() - lat));
    }
  },
  long: () => {
    if (deck.kind !== 'audio') return;
    const v = parseFloat(prompt('Track BPM', deck.bpmAudio || ''));
    if (v > 30 && v < 300) deck.setGrid(v, deck.cue ? deck.cue.frame : 0);
  },
  longMs: 900,
});

// ---------------------------------------------------------------- channels (MOD stems)

function buildChannelButtons() {
  const row = $('channels');
  row.innerHTML = '';
  if (!deck.rowBased) { row.style.display = 'none'; return; }
  row.style.display = '';
  for (let c = 0; c < deck.view.channels; c++) {
    const b = document.createElement('button');
    b.className = 'btn pad';
    b.innerHTML = `${c + 1}<span class="vu"></span>`;
    press(b, {
      long: () => { deck.solo(c); },
      up: (e, wasLong) => { if (!wasLong) deck.toggleMute(c); },
      longMs: 500,
    });
    row.appendChild(b);
  }
}

// ---------------------------------------------------------------- tempo fader

const RANGES = [0.06, 0.08, 0.16, 0.5];
let faderV = 0; // -1..1, + = faster
function applyFader() {
  const range = deck.settings.pitchRange;
  deck.setRate(1 + faderV * range);
  const dir = deck.settings.faderInvert ? -1 : 1;
  $('fader-knob').style.top = `${50 + faderV * 44 * dir}%`;
}
(() => {
  const fader = $('fader');
  let lastY = 0, lastTap = 0, dragging = false;
  fader.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fader.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (now - lastTap < 300) { faderV = 0; applyFader(); }
    lastTap = now;
    lastY = e.clientY; dragging = true;
  });
  fader.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = fader.clientHeight * 0.88;
    const dir = deck.settings.faderInvert ? -1 : 1;
    faderV = Math.max(-1, Math.min(1, faderV + ((e.clientY - lastY) / h) * 2 * dir));
    lastY = e.clientY;
    applyFader();
  });
  const end = () => { dragging = false; };
  fader.addEventListener('pointerup', end);
  fader.addEventListener('pointercancel', end);
})();

press($('btn-range'), {
  down: () => {
    const i = (RANGES.indexOf(deck.settings.pitchRange) + 1) % RANGES.length;
    deck.setSetting('pitchRange', RANGES[i]);
    applyFader();
    updateStaticButtons();
  },
});
press($('btn-tempo-reset'), { down: () => { faderV = 0; applyFader(); } });
press($('btn-keylock'), {
  down: () => {
    deck.setKeylock(!deck.settings.keylock);
    updateStaticButtons();
  },
});
// Nudge = temporary pitch bend while held.
press($('btn-nudge-down'), { down: () => deck.setBend(0.96), up: () => deck.setBend(1) });
press($('btn-nudge-up'), { down: () => deck.setBend(1.04), up: () => deck.setBend(1) });

// ---------------------------------------------------------------- jog wheel

const jog = { active: false, angle: 0, lastT: 0, vel: 0, searchAcc: 0 };
(() => {
  const el = $('jog');
  const angleOf = (e) => {
    const r = el.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    jog.active = true; jog.angle = angleOf(e); jog.lastT = performance.now(); jog.vel = 0; jog.searchAcc = 0;
  });
  el.addEventListener('pointermove', (e) => {
    if (!jog.active) return;
    const a = angleOf(e);
    let d = a - jog.angle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    jog.angle = a;
    const now = performance.now();
    const dt = Math.max(1, now - jog.lastT) / 1000;
    jog.lastT = now;
    if (deck.playing) {
      // Spin speed → pitch bend. ~1 rev/s ≈ ±30 % at most.
      jog.vel = jog.vel * 0.6 + (d / dt) * 0.4;
      deck.setBend(1 + Math.max(-0.3, Math.min(0.3, jog.vel * 0.05)));
    } else if (deck.rowBased) {
      jog.searchAcc += d;
      const step = Math.PI / 12; // 15° per row
      while (Math.abs(jog.searchAcc) >= step) {
        const s = Math.sign(jog.searchAcc);
        deck.search(s);
        jog.searchAcc -= s * step;
      }
    } else {
      deck.search((d / (2 * Math.PI)) * 1.8); // one turn = 1.8 s like a 33⅓ record
    }
  });
  const end = () => { jog.active = false; deck.setBend(1); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- pattern view: swipe to scroll channels

(() => {
  const el = $('main-view');
  let startX = null, startOff = 0;
  el.addEventListener('pointerdown', (e) => { if (deck.rowBased) { startX = e.clientX; startOff = deck.channelOffset || 0; } });
  el.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const { layout, font } = patternLayout(el.clientWidth, deck.view.channels, deck.view.hasVolumeColumn);
    const chW = layout.w * font * 0.62;
    deck.channelOffset = Math.max(0, Math.round(startOff - (e.clientX - startX) / chW));
  });
  const end = () => { startX = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- overview needle search

(() => {
  const el = $('overview');
  let down = false;
  const seekAt = (e, commit) => {
    if (!deck.loaded) return;
    const r = el.getBoundingClientRect();
    const p = overviewPosAt(deck, (e.clientX - r.left) / r.width);
    if (!deck.playing || commit) deck.seekTo(p, deck.playing && deck.settings.quantize);
  };
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); down = true; seekAt(e, false); });
  el.addEventListener('pointermove', (e) => { if (down) seekAt(e, false); });
  el.addEventListener('pointerup', (e) => { if (down) seekAt(e, true); down = false; });
  el.addEventListener('pointercancel', () => { down = false; });
})();

// ---------------------------------------------------------------- time display mode

let showRemain = true;
$('time-box').addEventListener('pointerdown', () => { showRemain = !showRemain; $('time-label').textContent = showRemain ? 'REMAIN' : 'ELAPSED'; });

// ---------------------------------------------------------------- settings dialog

function syncSettingsForm() {
  const s = deck.settings;
  $('set-interp').value = s.interpolation;
  $('set-sep').value = Math.round(s.stereoSep * 100);
  $('set-sep-val').textContent = Math.round(s.stereoSep * 100) + '%';
  $('set-rpb').value = deck.rowsPerBeat;
  $('set-rpb').disabled = !deck.rowBased;
  $('set-mtmode').value = s.mtMode;
  $('set-mtquality').value = s.mtQuality;
  $('set-songloop').value = s.songLoop ? 1 : 0;
  $('set-gain').value = Math.round(s.gain * 100);
  $('set-gain-val').textContent = Math.round(s.gain * 100) + '%';
  $('set-fader').value = s.faderInvert ? 1 : 0;
  $('set-wake').checked = s.wakeLock;
}
$('btn-settings').addEventListener('click', () => { syncSettingsForm(); $('settings').showModal(); });
$('set-interp').addEventListener('change', (e) => deck.setSetting('interpolation', +e.target.value));
$('set-sep').addEventListener('input', (e) => { deck.setSetting('stereoSep', e.target.value / 100); syncSettingsForm(); });
$('set-rpb').addEventListener('change', (e) => { if (deck.rowBased) deck.setRowsPerBeat(+e.target.value); });
$('set-mtmode').addEventListener('change', (e) => deck.setSetting('mtMode', e.target.value));
$('set-mtquality').addEventListener('change', (e) => deck.setSetting('mtQuality', e.target.value));
$('set-songloop').addEventListener('change', (e) => deck.setSetting('songLoop', e.target.value === '1'));
$('set-gain').addEventListener('input', (e) => { deck.setSetting('gain', e.target.value / 100); syncSettingsForm(); });
$('set-fader').addEventListener('change', (e) => { deck.setSetting('faderInvert', e.target.value === '1'); applyFader(); });
$('set-wake').addEventListener('change', (e) => { deck.setSetting('wakeLock', e.target.checked); requestWakeLock(); });
$('btn-fullscreen').addEventListener('click', () => {
  const d = document.documentElement;
  (d.requestFullscreen || d.webkitRequestFullscreen || (() => {})).call(d);
});

// ---------------------------------------------------------------- keyboard (desktop testing)

const keysDown = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'INPUT' || $('settings').open || library.open) return;
  keysDown.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); deck.togglePlay(); }
  else if (e.code === 'KeyC') deck.cueDown();
  else if (/^Digit[1-4]$/.test(e.code)) deck.hotcue(+e.code.slice(5) - 1);
  else if (e.code === 'KeyL') deck.loop(loopActive() ? 'exit' : 'auto', { beats: LOOP_SIZES[loopSizeIdx] });
  else if (e.code === 'ArrowLeft') deck.setBend(0.96);
  else if (e.code === 'ArrowRight') deck.setBend(1.04);
});
window.addEventListener('keyup', (e) => {
  keysDown.delete(e.code);
  if (e.code === 'KeyC') deck.cueUp();
  else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') deck.setBend(1);
});

// ---------------------------------------------------------------- wake lock + service worker

let wakeLock = null;
async function requestWakeLock() {
  if (!deck.settings.wakeLock) { if (wakeLock) { wakeLock.release(); wakeLock = null; } return; }
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } catch { /* not allowed yet */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWakeLock(); });
document.addEventListener('pointerdown', () => { deck.resume(); requestWakeLock(); }, { once: true });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------------------------------------------------------------- per-frame UI update

function updateStaticButtons() {
  const s = deck.settings;
  $('btn-quant').classList.toggle('on', s.quantize);
  $('btn-keylock').classList.toggle('on', s.keylock);
  $('btn-range').textContent = `±${Math.round(s.pitchRange * 100)}%`;
  $('btn-tap').disabled = deck.kind !== 'audio';
}

function frame() {
  requestAnimationFrame(frame);
  const st = deck.state;

  if (deck.rowBased) drawPatternView($('main-view'), deck);
  else drawWaveView($('main-view'), deck);
  drawOverview($('overview'), deck);
  drawJog($('jog'), deck);

  // Transport lights
  const playing = deck.playing;
  $('btn-play').classList.toggle('lit', playing && !deck.cueing);
  $('btn-play').classList.toggle('blink', !playing && deck.loaded);
  const atCue = deck.loaded && !playing && deck.samePos(deck.currentPos(), deck.cue);
  $('btn-cue').classList.toggle('lit', atCue || deck.cueing);

  document.querySelectorAll('.hc').forEach((el) => el.classList.toggle('set', !!deck.hotcues[+el.dataset.i]));
  const looping = loopActive();
  $('btn-autoloop').classList.toggle('loop-on', looping);
  $('btn-loop-exit').textContent = looping ? 'EXIT' : 'RELOOP';
  $('btn-loop-exit').classList.toggle('loop-on', looping);
  $('btn-loop-in').classList.toggle('armed', !!(st && st.loopInSet));

  // Readouts
  const effRate = deck.rate * deck.bend;
  const pct = (deck.rate - 1) * 100;
  $('tempo-value').textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  $('tempo-value').classList.toggle('zero', Math.abs(pct) < 0.005);

  if (deck.loaded && st) {
    const el = deck.elapsed(), dur = deck.duration();
    const remain = (dur - el) / effRate;
    $('time').textContent = showRemain ? '-' + fmtTime(remain) : fmtTime(el / effRate);
    $('time-box').classList.toggle('warn', playing && showRemain && remain < 30 && !(deck.rowBased && deck.settings.songLoop));
    const base = deck.baseBpm();
    $('bpm').textContent = base ? (base * effRate).toFixed(1) : '---.-';
    if (deck.rowBased) {
      $('bpm-base').textContent = `${base.toFixed(1)} · spd ${st.speed}/${Math.round(st.tempo)} · ${deck.rowsPerBeat} r/b`;
      const pat = deck.view.orderPattern(st.order);
      $('pos').textContent = `ORD ${st.order}/${deck.view.songLength - 1} · PAT ${pat} · ROW ${String(st.row).padStart(2, '0')}`;
      const btns = $('channels').children;
      for (let c = 0; c < btns.length; c++) {
        btns[c].classList.toggle('muted', deck.mutes[c]);
        btns[c].firstElementChild.style.width = `${Math.min(100, (st.vu[c] || 0) * 140)}%`;
      }
    } else {
      $('bpm-base').textContent = base ? `${base.toFixed(1)} tapped` : 'hold TAP to set';
      $('pos').textContent = '';
    }
    $('master-vu').firstElementChild.style.height = `${Math.min(100, (st.out || 0) * 100)}%`;
  }
}

applyFader();
updateStaticButtons();
requestAnimationFrame(frame);
