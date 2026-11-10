// bufferplayer.js — plays a decoded audio track (mp3/wav/flac/ogg…) like a
// CD deck: variable speed ("vinyl" pitch — tempo and pitch move together),
// loops, and a simple beat grid (bpm + first-beat offset) for quantize/autoloop.
//
// Runs inside the AudioWorklet. Key lock (time-stretch) for audio tracks is
// not implemented yet — that's a later step.

export class BufferPlayer {
  constructor(channels, srcRate, sampleRate) {
    this.L = channels[0];
    this.R = channels[1] || channels[0];
    this.length = this.L.length;
    this.srcRate = srcRate;
    this.sampleRate = sampleRate;
    this.pos = 0;            // in source frames (fractional)
    this.tempoMul = 1;
    this.ended = false;
    this.loop = null;        // { start, end } in frames
    this.loopIn = -1;
    this.bpm = 0;            // 0 = unknown
    this.gridOffset = 0;     // frame of a downbeat
    this.pendingSeek = -1;
    this.peak = 0;
  }

  beatFrames() { return this.bpm > 0 ? (60 / this.bpm) * this.srcRate : 0; }

  /** Nearest beat at or before frame f (or f if no grid). */
  beatFloor(f) {
    const bf = this.beatFrames();
    if (!bf) return f;
    return this.gridOffset + Math.floor((f - this.gridOffset) / bf) * bf;
  }

  seek(frame) {
    this.pos = Math.max(0, Math.min(frame, this.length - 1));
    this.ended = false;
  }

  seekQuantized(frame) {
    if (!this.beatFrames()) { this.seek(frame); return; }
    this.pendingSeek = frame;
  }

  setLoop(start, end) {
    if (end - start < 64) return;
    this.loop = { start, end };
  }
  clearLoop() { this.loop = null; }

  cubic(d, i, frac) {
    const n = this.length;
    const xm = d[i > 0 ? i - 1 : 0], x0 = d[i];
    const x1 = d[i + 1 < n ? i + 1 : i], x2 = d[i + 2 < n ? i + 2 : i];
    const c1 = 0.5 * (x1 - xm);
    const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * frac + c2) * frac + c1) * frac + x0;
  }

  render(outL, outR, offset, n) {
    const inc = (this.srcRate / this.sampleRate) * this.tempoMul;
    const bf = this.beatFrames();
    let peak = this.peak;
    for (let k = offset; k < offset + n; k++) {
      if (this.ended) { outL[k] = 0; outR[k] = 0; continue; }
      const i = this.pos | 0;
      const frac = this.pos - i;
      const l = this.cubic(this.L, i, frac);
      const r = this.cubic(this.R, i, frac);
      outL[k] = l; outR[k] = r;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > peak) peak = a;

      const prev = this.pos;
      this.pos += inc;
      if (this.pendingSeek >= 0 && bf) {
        // Crossed a beat line? Then jump, preserving the phase within the beat.
        const b0 = Math.floor((prev - this.gridOffset) / bf);
        const b1 = Math.floor((this.pos - this.gridOffset) / bf);
        if (b1 !== b0) {
          const phase = this.pos - (this.gridOffset + b1 * bf);
          this.pos = this.pendingSeek + phase;
          this.pendingSeek = -1;
        }
      }
      if (this.loop && this.pos >= this.loop.end) {
        this.pos -= this.loop.end - this.loop.start;
      }
      if (this.pos >= this.length - 1) { this.pos = this.length - 1; this.ended = true; }
    }
    this.peak = peak;
    return !this.ended;
  }

  state() {
    const s = {
      frame: this.pos, ended: this.ended, vu: [this.peak],
      loop: this.loop ? { start: this.loop.start, end: this.loop.end } : null,
      pendingSeek: this.pendingSeek >= 0,
      loopInSet: this.loopIn >= 0,
    };
    this.peak = 0;
    return s;
  }
}
