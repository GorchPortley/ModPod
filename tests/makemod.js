// makemod.js — builds a small original 4-channel MOD from code.
// Used by the tests, and to generate demo/modpod-demo.mod so there's
// something to load on day one.
//
//   node tests/makemod.js demo/modpod-demo.mod

import { writeFileSync } from 'node:fs';

const PERIODS = [ // C-1..B-3
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
const NOTE = (name) => { // "C-2" → period
  const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  const n = names.indexOf(name.slice(0, 2)) + (parseInt(name[2], 10) - 1) * 12;
  return PERIODS[n];
};

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---- samples (signed 8-bit) -------------------------------------------------
function kick() {
  const n = 3000, d = new Int8Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = 180 * Math.exp(-i / 500) + 45;
    ph += f / 8287;
    d[i] = Math.round(Math.sin(ph * 2 * Math.PI) * Math.exp(-i / 1400) * 127);
  }
  return { name: 'kick', data: d, volume: 64 };
}
function hat() {
  const r = rng(7), n = 900, d = new Int8Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1; const hp = w - prev; prev = w;
    d[i] = Math.round(hp * 0.5 * Math.exp(-i / 180) * 127);
  }
  return { name: 'hat', data: d, volume: 40 };
}
function snare() {
  const r = rng(3), n = 2400, d = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const tone = Math.sin(i * 2 * Math.PI * 190 / 8287) * Math.exp(-i / 300);
    d[i] = Math.round(((r() * 2 - 1) * 0.7 * Math.exp(-i / 600) + tone * 0.5) * 120);
  }
  return { name: 'snare', data: d, volume: 50 };
}
function bass() { // looped saw, one cycle = 32 samples
  const n = 64, d = new Int8Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.round(((i % 32) / 16 - 1) * 100);
  return { name: 'saw bass', data: d, volume: 48, loopStart: 0, loopLength: 64 };
}
function square() { // looped square, one cycle = 32 samples
  const n = 64, d = new Int8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i % 32) < 16 ? 90 : -90;
  return { name: 'square lead', data: d, volume: 36, loopStart: 0, loopLength: 64 };
}

// ---- pattern helpers ---------------------------------------------------------
function emptyPattern(ch) { return Array.from({ length: 64 }, () => Array.from({ length: ch }, () => [0, 0, 0, 0])); }
function put(pat, row, c, note, smp, eff = 0, prm = 0) { pat[row][c] = [note ? NOTE(note) : 0, smp, eff, prm]; }

export function buildDemoMod() {
  const samples = [kick(), snare(), hat(), bass(), square()];
  const S = { kick: 1, snare: 2, hat: 3, bass: 4, lead: 5 };
  const patterns = [];

  // Pattern 0: intro — kick + hats + bass
  // Pattern 1: main — + snare + arpeggiated lead
  // Pattern 2: break — bass with vibrato + lead porta, pattern loop on hats
  const bassLine = ['C-1', 'C-1', 'D#1', 'C-1', 'G-1', 'C-1', 'A#1', 'G-1'];
  for (let p = 0; p < 3; p++) {
    const pat = emptyPattern(4);
    for (let r = 0; r < 64; r++) {
      if (p !== 2 && r % 4 === 0) put(pat, r, 0, 'C-2', S.kick);
      if (r % 4 === 2) put(pat, r, 1, 'C-3', S.hat);
      if (p === 1 && r % 8 === 4) put(pat, r, 1, 'C-2', S.snare);
      if (r % 2 === 0) {
        const nn = bassLine[(r / 2) % 8];
        put(pat, r, 2, nn, S.bass, p === 2 ? 0x4 : 0xc, p === 2 ? 0x46 : (r % 4 === 0 ? 48 : 30));
      }
    }
    if (p === 1) {
      for (let r = 0; r < 64; r += 8) put(pat, r, 3, r % 16 ? 'G-2' : 'C-3', S.lead, 0x0, 0x37); // arpeggio
      put(pat, 60, 3, null, 0, 0xa, 0x04); // vol slide down
    }
    if (p === 2) {
      put(pat, 0, 3, 'C-2', S.lead);
      put(pat, 16, 3, 'G-2', S.lead, 0x3, 0x04);   // tone portamento up
      put(pat, 32, 3, 'D#3', 0, 0x3, 0x00);
      put(pat, 48, 3, null, 0, 0xa, 0x02);
    }
    patterns.push(pat);
  }
  // Tempo: set explicitly at the very start.
  patterns[0][0][3] = [0, 0, 0xf, 125];

  const orders = [0, 0, 1, 1, 2, 1, 1];
  // Last order ends with a jump back to order 2 (song loops — tests end detection).
  const last = JSON.parse(JSON.stringify(patterns[1]));
  last[63][3] = [0, 0, 0xb, 2];
  patterns.push(last);
  orders[orders.length - 1] = 3;

  return writeMod('ModPod demo', samples, patterns, orders, 4);
}

export function writeMod(title, samples, patterns, orders, channels = 4, tag = 'M.K.') {
  const sampleBytes = samples.reduce((a, s) => a + s.data.length, 0);
  const size = 1084 + patterns.length * 64 * channels * 4 + sampleBytes;
  const b = new Uint8Array(size);
  for (let i = 0; i < Math.min(20, title.length); i++) b[i] = title.charCodeAt(i);
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const s = samples[i];
    if (!s) continue;
    for (let k = 0; k < Math.min(22, s.name.length); k++) b[o + k] = s.name.charCodeAt(k);
    const words = s.data.length >> 1;
    b[o + 22] = words >> 8; b[o + 23] = words & 255;
    b[o + 24] = s.finetune || 0;
    b[o + 25] = s.volume;
    const ls = (s.loopStart || 0) >> 1, ll = s.loopLength ? s.loopLength >> 1 : 1;
    b[o + 26] = ls >> 8; b[o + 27] = ls & 255;
    b[o + 28] = ll >> 8; b[o + 29] = ll & 255;
  }
  b[950] = orders.length; b[951] = 127;
  orders.forEach((o, i) => { b[952 + i] = o; });
  for (let i = 0; i < 4; i++) b[1080 + i] = tag.charCodeAt(i);
  let off = 1084;
  for (const pat of patterns) {
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < channels; c++) {
        const [per, smp, eff, prm] = pat[r][c];
        b[off++] = (smp & 0xf0) | ((per >> 8) & 0x0f);
        b[off++] = per & 255;
        b[off++] = ((smp & 0x0f) << 4) | (eff & 0x0f);
        b[off++] = prm;
      }
    }
  }
  for (const s of samples) for (let i = 0; i < s.data.length; i++) b[off++] = s.data[i] & 255;
  return b.buffer;
}

if (process.argv[1] && process.argv[1].endsWith('makemod.js') && process.argv[2]) {
  writeFileSync(process.argv[2], new Uint8Array(buildDemoMod()));
  console.log('wrote', process.argv[2]);
}
