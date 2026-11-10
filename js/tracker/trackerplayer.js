// trackerplayer.js — XM / S3M / IT / … playback via libopenmpt (WebAssembly),
// with the same DJ interface as ModPlayer: tempo/pitch multipliers, channel
// mutes, row-based loops, beat-quantized jumps. Runs inside the AudioWorklet.
//
// libopenmpt renders whatever number of frames we ask for, so to make loop
// jumps land exactly on a row boundary we predict how many frames are left in
// the current row and, near the end, render in tiny chunks until the row ticks
// over — then jump.

import { copyIn, f32 } from '../wasm/dsp.js';

const INTERP = [1, 2, 8]; // our setting 0/1/2 → libopenmpt filter length (none / linear / windowed sinc)

export class TrackerPlayer {
  constructor(M, bytes, sampleRate) {
    this.M = M;
    const p = copyIn(M, bytes);
    this.h = M._mpt_create(p, bytes.length, sampleRate);
    M._free(p);
    if (!this.h) throw new Error(M.UTF8ToString(M._mpt_error()));
    this.sampleRate = sampleRate;
    this.nch = M._mpt_num_channels(this.h);
    this.muted = new Array(this.nch).fill(false);
    this.vu = new Float32Array(this.nch);
    this._tempoMul = 1; this._pitchMul = 1;
    this._interpolation = 1; this._stereoSep = 0.5; this._songLoop = false;
    this.rowsPerBeat = 4;
    this.loop = null; this.loopIn = null; this.pendingSeek = null;
    this.ended = false;
    this.framesInRow = 0;
    this.refresh();
    this.applyRender();
  }

  destroy() { if (this.h) { this.M._mpt_destroy(this.h); this.h = 0; } }

  // ---- settings (same property names as ModPlayer, so the processor treats them alike)
  get tempoMul() { return this._tempoMul; }
  set tempoMul(v) { if (v !== this._tempoMul) { this._tempoMul = v; this.applyFactors(); } }
  get pitchMul() { return this._pitchMul; }
  set pitchMul(v) { if (v !== this._pitchMul) { this._pitchMul = v; this.applyFactors(); } }
  set interpolation(v) { this._interpolation = v; this.applyRender(); }
  set stereoSep(v) { this._stereoSep = v; this.applyRender(); }
  set songLoop(v) { this._songLoop = v; this.applyRender(); }

  applyFactors() { this.M._mpt_set_factors(this.h, this._tempoMul, this._pitchMul); }
  applyRender() {
    this.M._mpt_set_render(this.h, INTERP[this._interpolation] || 2, Math.round(this._stereoSep * 100), this._songLoop ? -1 : 0);
  }

  setMute(ch, on) {
    if (ch < 0 || ch >= this.nch) return;
    this.muted[ch] = on;
    this.M._mpt_set_mute(this.h, ch, on ? 1 : 0);
  }

  refresh() {
    const M = this.M, h = this.h;
    this.order = M._mpt_order(h);
    this.row = M._mpt_row(h);
    this.speed = M._mpt_speed(h) || 6;
    this.tempo = M._mpt_tempo(h) || 125;
  }

  // ---- positioning

  /** Seek by time: libopenmpt rebuilds tempo/volume/effect state properly. */
  seekSeconds(seconds) {
    // libopenmpt lands on the first row starting at/after `seconds`; aim 0.1 ms early so
    // floating-point rounding can't push us onto the next row.
    this.M._mpt_seek_seconds(this.h, Math.max(0, seconds - 1e-4));
    this.ended = false;
    this.framesInRow = 0;
    this.pendingSeek = null;
    this.refresh();
  }

  /** Jump to a row keeping current state — seamless for loops. */
  seekRow(L) {
    this.M._mpt_seek_order_row(this.h, L.order, L.row);
    this.framesInRow = 0;
    this.ended = false;
    this.refresh();
  }

  seekQuantized(order, row, seconds) { this.pendingSeek = { order, row, seconds }; }

  setLoop(order, row, speed, tempo, length, alreadyPlayed = 0) {
    this.loop = { order, row, speed, tempo, length: Math.max(1, length), count: alreadyPlayed };
  }
  clearLoop() { this.loop = null; }
  markLoopIn(quantize) {
    const back = quantize ? this.row % this.rowsPerBeat : 0;
    this.loopIn = { order: this.order, row: this.row - back, speed: this.speed, tempo: this.tempo, count: back };
  }
  markLoopOut(quantize) {
    const li = this.loopIn;
    if (!li) return;
    let len = li.count + 1;
    if (quantize) len = Math.max(this.rowsPerBeat, Math.round(len / this.rowsPerBeat) * this.rowsPerBeat);
    this.setLoop(li.order, li.row, li.speed, li.tempo, len, Math.min(li.count, len - 1));
    this.loopIn = null;
  }

  // ---- rendering

  /** Is a jump due at the end of the current row? */
  jumpArmed() {
    if (this.loop && this.loop.count + 1 >= this.loop.length) return true;
    if (this.pendingSeek && (this.row + 1) % this.rowsPerBeat === 0) return true;
    return false;
  }

  framesLeftInRow() {
    const rowFrames = (this.speed * this.sampleRate * 2.5) / (this.tempo * this._tempoMul);
    return Math.ceil(rowFrames - this.framesInRow);
  }

  render(outL, outR, offset, n) {
    const M = this.M, h = this.h;
    let pos = offset;
    const end = offset + n;
    while (pos < end) {
      if (this.ended) { outL.fill(0, pos, end); outR.fill(0, pos, end); return false; }
      let chunk = Math.min(end - pos, 256);
      if (this.jumpArmed()) {
        const left = this.framesLeftInRow();
        chunk = Math.min(chunk, 32, left > 3 ? left - 2 : 1);
      }
      const got = M._mpt_render(h, chunk);
      if (!got) { this.ended = true; continue; }
      outL.set(f32(M, M._mpt_left(h), got), pos);
      outR.set(f32(M, M._mpt_right(h), got), pos);
      pos += got;
      this.framesInRow += got;
      for (let c = 0; c < this.nch; c++) {
        const v = M._mpt_channel_vu(h, c);
        if (v > this.vu[c]) this.vu[c] = v;
      }
      const o = M._mpt_order(h), r = M._mpt_row(h);
      if (o !== this.order || r !== this.row) this.onNewRow(o, r);
    }
    return true;
  }

  onNewRow(o, r) {
    this.order = o; this.row = r;
    this.framesInRow = 0;
    this.speed = this.M._mpt_speed(this.h) || this.speed;
    this.tempo = this.M._mpt_tempo(this.h) || this.tempo;
    if (this.loopIn) this.loopIn.count++;
    if (this.loop) {
      if (++this.loop.count >= this.loop.length) {
        this.loop.count = 0;
        this.seekRow(this.loop);
      }
      return;
    }
    if (this.pendingSeek && r % this.rowsPerBeat === 0) {
      const s = this.pendingSeek;
      this.seekSeconds(s.seconds);
    }
  }

  state() {
    const tickFrames = (this.sampleRate * 2.5) / (this.tempo * this._tempoMul);
    const vu = Array.from(this.vu);
    this.vu.fill(0);
    return {
      order: this.order, row: this.row,
      tick: Math.min(this.speed - 1, Math.floor(this.framesInRow / tickFrames)),
      speed: this.speed, tempo: this.tempo,
      seconds: this.M._mpt_position_seconds(this.h),
      ended: this.ended, vu,
      loop: this.loop ? { order: this.loop.order, row: this.loop.row, length: this.loop.length, count: this.loop.count } : null,
      pendingSeek: !!this.pendingSeek,
      loopInSet: !!this.loopIn,
    };
  }
}
