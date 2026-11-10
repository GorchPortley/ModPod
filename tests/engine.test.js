// engine.test.js — headless checks for the MOD parser/timeline/engine and the
// audio buffer player. Run with:  npm test   (or: node tests/engine.test.js)
// Pass --wav to also write rendered audio to tests/out/ for listening.

import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseMod, buildTimeline, looksLikeMod, noteName } from '../js/mod/modfile.js';
import { ModPlayer } from '../js/mod/modplayer.js';
import { BufferPlayer } from '../js/audio/bufferplayer.js';
import { buildDemoMod, writeMod } from './makemod.js';

const SR = 48000;
const WAV = process.argv.includes('--wav');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}

/** Render until the song ends (or maxSeconds). Returns { L, R, frames }. */
function renderAll(player, maxSeconds = 120) {
  const block = 128, max = SR * maxSeconds;
  const L = new Float32Array(max), R = new Float32Array(max);
  let n = 0;
  while (n < max) {
    const alive = player.render(L, R, n, block);
    n += block;
    if (!alive) break;
  }
  return { L: L.subarray(0, n), R: R.subarray(0, n), frames: n };
}

function writeWav(path, L, R) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, b);
}

/** Estimate the fundamental via zero crossings (good enough for a pure-ish tone). */
function zeroCrossFreq(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++;
  return (c / 2) / (x.length / SR);
}

console.log('MOD parser');
const demo = buildDemoMod();
const song = parseMod(demo, 'demo.mod');

test('parses header', () => {
  assert.equal(song.channels, 4);
  assert.equal(song.numSamples, 31);
  assert.equal(song.tag, 'M.K.');
  assert.equal(song.title, 'ModPod demo');
  assert.equal(song.songLength, 7);
  assert.equal(song.numPatterns, 4);
  assert.equal(song.samples[3].looped, true);
  assert.equal(song.samples[0].looped, false);
});
test('detects MODs vs other files', () => {
  assert.equal(looksLikeMod(demo, 'x.bin'), true);
  assert.equal(looksLikeMod(new Uint8Array(5000).buffer, 'song.mp3'), false);
});
test('decodes notes', () => {
  // Order 0 → pattern 0, row 0, channel 0 = kick on C-2
  assert.equal(noteName(song.cells.note[0]), 'C-2');
});

console.log('Timeline');
const tl = buildTimeline(song);
test('duration = 7 patterns × 64 rows × 0.12 s', () => {
  assert.ok(Math.abs(tl.duration - 7 * 64 * 0.12) < 1e-6, 'got ' + tl.duration);
});
test('detects the B02 loop back to order 2', () => {
  assert.deepEqual(tl.loopTo, { order: 2, row: 0 });
});

console.log('Engine');
test('plays the whole song and stops at the loop point', () => {
  const p = new ModPlayer(song, SR);
  const { L, R, frames } = renderAll(p);
  const expected = tl.duration * SR;
  assert.ok(Math.abs(frames - expected) < SR * 0.13, `frames ${frames} vs ${expected}`);
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), 'NaN at ' + i);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  assert.ok(peak > 0.1 && peak < 1.5, 'peak ' + peak);
  if (WAV) { mkdirSync('tests/out', { recursive: true }); writeWav('tests/out/demo.wav', L, R); }
});

test('song loop mode keeps going', () => {
  const p = new ModPlayer(song, SR);
  p.songLoop = true;
  const { frames } = renderAll(p, tl.duration + 5);
  assert.ok(frames >= (tl.duration + 5) * SR - 128);
});

test('tempo fader: +10% plays 10% faster', () => {
  const p = new ModPlayer(song, SR);
  p.tempoMul = 1.1; p.pitchMul = 1.1;
  const { frames } = renderAll(p);
  assert.ok(Math.abs(frames - tl.duration * SR / 1.1) < SR * 0.13);
});

// One sustained square note, to measure pitch.
function toneSong() {
  const sq = new Int8Array(64);
  for (let i = 0; i < 64; i++) sq[i] = (i % 32) < 16 ? 100 : -100;
  const pat = Array.from({ length: 64 }, () => Array.from({ length: 4 }, () => [0, 0, 0, 0]));
  pat[0][0] = [428, 1, 0, 0]; // C-2, 32-sample cycle → 3546894.6/428/32 ≈ 259 Hz
  return parseMod(writeMod('tone', [{ name: 'sq', data: sq, volume: 64, loopStart: 0, loopLength: 64 }], [pat], [0]), 't.mod');
}
test('pitch: C-2 on a 32-sample cycle ≈ 259 Hz', () => {
  const p = new ModPlayer(toneSong(), SR);
  const { L } = renderAll(p, 2);
  const f = zeroCrossFreq(L.subarray(SR * 0.1, SR * 1.0));
  assert.ok(Math.abs(f - 259) < 3, 'got ' + f);
});
test('key lock: tempo +20% keeps the pitch', () => {
  const p = new ModPlayer(toneSong(), SR);
  p.tempoMul = 1.2; p.pitchMul = 1;
  const { L, frames } = renderAll(p, 10);
  assert.ok(Math.abs(frames - 64 * 0.12 * SR / 1.2) < SR * 0.13, 'length');
  const f = zeroCrossFreq(L.subarray(SR * 0.1, SR * 1.0));
  assert.ok(Math.abs(f - 259) < 3, 'got ' + f);
});
test('no key lock: tempo +20% raises the pitch 20%', () => {
  const p = new ModPlayer(toneSong(), SR);
  p.tempoMul = 1.2; p.pitchMul = 1.2;
  const { L } = renderAll(p, 10);
  const f = zeroCrossFreq(L.subarray(SR * 0.1, SR * 1.0));
  assert.ok(Math.abs(f - 259 * 1.2) < 4, 'got ' + f);
});

test('auto-loop of 4 beats repeats rows 0..15', () => {
  const p = new ModPlayer(song, SR);
  p.setLoop(0, 0, 6, 125, 16, 0);
  const rows = new Set();
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < SR * 10 / 128; i++) { p.render(L, R, 0, 128); rows.add(p.order * 64 + p.row); }
  assert.deepEqual([...rows].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
});

test('loop in/out (quantized) snaps to whole beats', () => {
  const p = new ModPlayer(song, SR);
  const L = new Float32Array(128), R = new Float32Array(128);
  while (p.row < 5) p.render(L, R, 0, 128);   // row 5 = beat 2, 1 row in
  p.markLoopIn(true);                           // snaps back to row 4
  while (p.row < 11) p.render(L, R, 0, 128);
  p.markLoopOut(true);                          // 7 rows → rounds to 8
  assert.equal(p.loop.row, 4);
  assert.equal(p.loop.length, 8);
  const rows = new Set();
  for (let i = 0; i < SR * 5 / 128; i++) { p.render(L, R, 0, 128); rows.add(p.row); }
  assert.deepEqual([...rows].sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10, 11]);
});

test('quantized seek waits for the next beat', () => {
  const p = new ModPlayer(song, SR);
  const L = new Float32Array(128), R = new Float32Array(128);
  while (p.row < 1) p.render(L, R, 0, 128);
  p.seekQuantized(2, 32, 6, 125);
  while (p.order === 0 && p.row < 4 && p.pendingSeek) p.render(L, R, 0, 128);
  assert.equal(p.order, 2); assert.equal(p.row, 32);
});

test('muting all channels gives silence', () => {
  const p = new ModPlayer(song, SR);
  p.channels.forEach((c) => { c.muted = true; });
  const { L } = renderAll(p, 3);
  let peak = 0; for (let i = SR * 0.05; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]));
  assert.ok(peak < 1e-6, 'peak ' + peak);
});

test('every interpolation mode renders finite audio', () => {
  for (const mode of [0, 1, 2]) {
    const p = new ModPlayer(song, SR);
    p.interpolation = mode;
    const { L } = renderAll(p, 5);
    for (let i = 0; i < L.length; i++) assert.ok(Number.isFinite(L[i]));
  }
});

console.log('Audio deck');
test('buffer player: rate, loop and quantized seek', () => {
  const len = 44100 * 4;
  const sine = new Float32Array(len);
  for (let i = 0; i < len; i++) sine[i] = Math.sin(2 * Math.PI * 441 * i / 44100) * 0.5;
  const p = new BufferPlayer([sine], 44100, SR);
  const { frames } = renderAll(p, 10);
  assert.ok(Math.abs(frames - 4 * SR) < 256, 'length ' + frames);

  const p2 = new BufferPlayer([sine], 44100, SR);
  p2.tempoMul = 2;
  assert.ok(Math.abs(renderAll(p2, 10).frames - 2 * SR) < 256);

  const p3 = new BufferPlayer([sine], 44100, SR);
  p3.bpm = 120; // beat = 22050 frames
  p3.setLoop(0, 22050);
  assert.ok(renderAll(p3, 6).frames >= 6 * SR - 128, 'loop should not end');

  const p4 = new BufferPlayer([sine], 44100, SR);
  p4.bpm = 120;
  const L = new Float32Array(128), R = new Float32Array(128);
  p4.render(L, R, 0, 128);
  p4.seekQuantized(88200);
  while (p4.pendingSeek >= 0) p4.render(L, R, 0, 128);
  assert.ok(p4.pos >= 88200 && p4.pos < 88200 + 300, 'pos ' + p4.pos);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
