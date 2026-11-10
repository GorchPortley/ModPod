// dsp.js — loads the WebAssembly DSP module (libopenmpt + Signalsmith Stretch,
// see native/). Used both on the UI thread and inside the AudioWorklet.

import createModpodDsp from './modpod-dsp.js';

// The AudioWorklet scope has no `crypto`; the C++ code only uses it to seed
// random numbers (dither / phase randomisation), so Math.random is fine.
if (!globalThis.crypto) {
  globalThis.crypto = {
    getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 4294967296) >>> 0; return a; },
  };
}

// Nor `performance` (libopenmpt reads a clock while loading a module).
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

let promise = null;
export function getDsp() {
  if (!promise) promise = createModpodDsp();
  return promise;
}

/** Copy bytes into wasm memory; caller must M._free() the returned pointer. */
export function copyIn(M, bytes) {
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  return p;
}

/** A Float32Array view into wasm memory. Always make a fresh one: memory can grow. */
export function f32(M, ptr, n) {
  return new Float32Array(M.HEAPF32.buffer, ptr, n);
}

// Master-tempo quality presets: [block, interval] in seconds. Bigger = smoother, more latency.
export const SHIFTER_PRESETS = {
  tight: [0.06, 0.015],
  smooth: [0.12, 0.03],
};
