// tracker.test.js — the WebAssembly side: libopenmpt TrackerPlayer + the
// master-tempo pitch shifter. Run with: node tests/tracker.test.js
import { strict as assert } from 'node:assert';
import { getDsp, f32 } from '../js/wasm/dsp.js';
import { TrackerPlayer } from '../js/tracker/trackerplayer.js';
import { TrackerSongView } from '../js/songview.js';
import { parseMod, buildTimeline, writeModForTest } from './helpers.js';

const SR = 48000;
const M = await getDsp();
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const demo = new Uint8Array((await import('./makemod.js')).buildDemoMod());

function renderAll(p, maxSec) {
  const max = SR * maxSec, L = new Float32Array(max), R = new Float32Array(max);
  let n = 0;
  while (n < max) { const alive = p.render(L, R, n, Math.min(128, max - n)); n += 128; if (!alive) break; }
  return { L: L.subarray(0, Math.min(n, max)), frames: Math.min(n, max) };
}
function zeroCrossFreq(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++;
  return c / 2 / (x.length / SR);
}

console.log('libopenmpt engine');
await test('song view reads structure + pattern text', () => {
  const v = new TrackerSongView(M, demo, 'demo.mod');
  assert.equal(v.channels, 4); assert.equal(v.songLength, 7); assert.equal(v.patternRows(0), 64);
  assert.equal(v.cell(0, 0, 0)[0], 'C-5');           // libopenmpt names PT's C-2 as C-5
  assert.ok(Math.abs(v.duration - 53.76) < 0.05, 'duration ' + v.duration);
  assert.ok(Math.abs(v.timeAt(2, 0) - 2 * 64 * 0.12) < 0.01);
  v.destroy();
});
await test('agrees with our JS MOD engine on song length', () => {
  const tl = buildTimeline(parseMod(demo.buffer.slice(0), 'demo.mod'));
  const p = new TrackerPlayer(M, demo, SR);
  const { frames } = renderAll(p, 120);
  assert.ok(Math.abs(frames / SR - tl.duration) < 0.15, `${frames / SR} vs ${tl.duration}`);
  p.destroy();
});
await test('4-beat DJ loop repeats rows 0..15 exactly', () => {
  const p = new TrackerPlayer(M, demo, SR);
  p.setLoop(0, 0, 6, 125, 16, 0);
  const rows = new Set();
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < SR * 6 / 128; i++) { p.render(L, R, 0, 128); rows.add(p.order * 64 + p.row); }
  assert.deepEqual([...rows].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  p.destroy();
});
await test('loop length in time is exact (≤ 2 ms error per pass)', () => {
  // Count frames between consecutive arrivals at the loop start.
  const p = new TrackerPlayer(M, demo, SR);
  p.setLoop(0, 0, 6, 125, 16, 0);
  const L = new Float32Array(1), R = new Float32Array(1);
  const hits = [];
  let lastRow = -1;
  for (let f = 0; f < SR * 8; f++) {
    p.render(L, R, 0, 1);
    if (p.row === 0 && lastRow !== 0) hits.push(f);
    lastRow = p.row;
  }
  const expected = 16 * 0.12 * SR;
  for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i] - hits[i - 1] - expected) < SR * 0.002, `pass ${i}: ${hits[i] - hits[i - 1]} vs ${expected}`);
  p.destroy();
});
await test('quantized seek waits for the next beat', () => {
  const p = new TrackerPlayer(M, demo, SR);
  const L = new Float32Array(128), R = new Float32Array(128);
  while (p.row < 1) p.render(L, R, 0, 128);
  p.seekQuantized(2, 32, 2 * 64 * 0.12 + 32 * 0.12);
  while (p.pendingSeek) p.render(L, R, 0, 128);
  assert.equal(p.order, 2); assert.equal(p.row, 32);
  p.destroy();
});
await test('muting every channel gives silence', () => {
  const p = new TrackerPlayer(M, demo, SR);
  for (let c = 0; c < p.nch; c++) p.setMute(c, true);
  const { L } = renderAll(p, 2);
  assert.ok(L.slice(SR * 0.1).every((v) => Math.abs(v) < 1e-6));
  p.destroy();
});
await test('tempo ×1.2 (vinyl) plays 1.2× faster', () => {
  const p = new TrackerPlayer(M, demo, SR);
  p.tempoMul = 1.2; p.pitchMul = 1.2;
  const { frames } = renderAll(p, 120);
  assert.ok(Math.abs(frames / SR - 53.76 / 1.2) < 0.2, frames / SR);
  p.destroy();
});

console.log('Master tempo (pitch shifter)');
await test('vinyl ×1.12 then shift by 1/1.12 restores the original pitch', () => {
  const sh = M._st_create(2, SR, 0.06, 0.015);
  const f0 = 220, rate = 1.12;
  M._st_set_transpose(sh, 1 / rate);
  const total = SR * 2, out = new Float32Array(total);
  for (let pos = 0; pos < total; pos += 128) {
    for (let c = 0; c < 2; c++) {
      const inp = f32(M, M._st_in(sh, c, 128), 128);
      for (let k = 0; k < 128; k++) inp[k] = Math.sin(2 * Math.PI * f0 * rate * (pos + k) / SR) * 0.5;
    }
    M._st_process(sh, 128);
    out.set(f32(M, M._st_out(sh, 0, 128), 128), pos);
  }
  const f = zeroCrossFreq(out.subarray(SR * 0.5, SR * 1.9));
  assert.ok(Math.abs(f - f0) < 3, `got ${f.toFixed(1)} Hz, want ${f0}`);
  M._st_destroy(sh);
});
await test('outputSeek starts output immediately (no latency gap)', () => {
  const sh = M._st_create(2, SR, 0.06, 0.015);
  M._st_set_transpose(sh, 1);
  const len = M._st_seek_length(sh);
  for (let c = 0; c < 2; c++) {
    const inp = f32(M, M._st_in(sh, c, len), len);
    for (let k = 0; k < len; k++) inp[k] = Math.sin(2 * Math.PI * 440 * k / SR) * 0.5;
  }
  M._st_output_seek(sh, len);
  for (let c = 0; c < 2; c++) { const inp = f32(M, M._st_in(sh, c, 256), 256); for (let k = 0; k < 256; k++) inp[k] = Math.sin(2 * Math.PI * 440 * (len + k) / SR) * 0.5; }
  M._st_process(sh, 256);
  const o = f32(M, M._st_out(sh, 0, 256), 256);
  let peak = 0; for (const v of o.subarray(16)) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.2, 'first output block is silent: ' + peak);
  M._st_destroy(sh);
});

console.log('Samples stay in time with the tempo (your question)');
await test('a 1-bar sample still lasts exactly 1 bar at +10 % in vinyl mode', () => {
  // A long sample that's exactly 16 rows long at 125 BPM, triggered on row 0 and row 16.
  // In vinyl mode the second trigger must land as the first one finishes.
  const len = Math.round(16 * 0.12 * 8287.14 / 2) * 2;      // C-2 plays at ~8287 Hz
  const smp = new Int8Array(len);
  for (let i = 0; i < len; i++) smp[i] = i < len - 200 ? 60 : 0; // DC block, then silence at the end
  const pat = Array.from({ length: 64 }, () => Array.from({ length: 4 }, () => [0, 0, 0, 0]));
  pat[0][0] = [428, 1, 0, 0]; pat[16][0] = [428, 1, 0, 0];
  const bytes = new Uint8Array(writeModForTest('bar', [{ name: 'bar', data: smp, volume: 64 }], [pat], [0]));
  const gapFrames = (rate) => {
    const p = new TrackerPlayer(M, bytes, SR);
    p.tempoMul = rate; p.pitchMul = rate;
    const { L } = renderAll(p, 4);
    // Find the first silent stretch after the start: the sample's tail.
    let i = 1000; while (i < L.length && Math.abs(L[i]) > 0.01) i++;
    const silentAt = i;
    while (i < L.length && Math.abs(L[i]) <= 0.01) i++;
    p.destroy();
    return { silentAt, retrigAt: i };
  };
  const a = gapFrames(1), b = gapFrames(1.1);
  // Both the sample end and the next trigger scale by 1/1.1 → their ratio is unchanged.
  assert.ok(Math.abs(b.retrigAt / a.retrigAt - 1 / 1.1) < 0.01, 'retrigger moved ' + (b.retrigAt / a.retrigAt));
  assert.ok(Math.abs(b.silentAt / a.silentAt - 1 / 1.1) < 0.01, 'sample length ' + (b.silentAt / a.silentAt));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
