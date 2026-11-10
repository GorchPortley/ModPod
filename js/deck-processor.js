// deck-processor.js — the AudioWorklet. One per deck (one per tablet).
//
// Signal flow:
//
//   source ──► [master-tempo pitch shifter] ──► play/pause fade ──► trim ──► out
//
// source is one of:
//   ModPlayer     — our own JS ProTracker engine (.mod)
//   TrackerPlayer — libopenmpt via WebAssembly (.xm .s3m .it …)
//   BufferPlayer  — decoded audio (.mp3 .wav .flac …)
//
// Master tempo ("key lock"): the source always plays vinyl-style — tempo and
// pitch move together, so long samples, breakbeats and vocals stay in time
// with the patterns. The pitch shifter then moves the key back by 1/rate.
// For tracker files there's an optional "native" mode instead: only the tick
// rate changes (no shifter artefacts, but long samples drift against the beat).

import { ModPlayer } from './mod/modplayer.js';
import { BufferPlayer } from './audio/bufferplayer.js';
import { TrackerPlayer } from './tracker/trackerplayer.js';
import { getDsp, f32, SHIFTER_PRESETS } from './wasm/dsp.js';

const FADE_MS = 4; // short fade on play/pause so stopping mid-note doesn't click

let M = null;
getDsp().then((m) => { M = m; for (const p of processors) p.dspReady(); });
const processors = new Set();

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    processors.add(this);
    this.src = null;
    this.kind = null;
    this.playing = false;
    this.fade = 0;
    this.fadeStep = 1 / (sampleRate * FADE_MS / 1000);
    this.gain = 1;
    this.rate = 1;              // tempo fader
    this.bend = 1;              // nudge / jog (temporary)
    this.keylock = false;
    this.settings = { interpolation: 1, stereoSep: 0.5, songLoop: false, rowsPerBeat: 4, mtMode: 'stretch', mtQuality: 'tight' };
    this.shifter = 0;           // wasm Shifter*
    this.shifterQuality = null;
    this.shifting = false;      // shifter currently in the signal path
    this.needsSeed = true;      // shifter must be re-primed before its next output
    this.reportEvery = Math.round(sampleRate / 60);
    this.sinceReport = 0;
    this.outPeak = 0;
    this.tmpL = new Float32Array(128);
    this.tmpR = new Float32Array(128);
    this.port.onmessage = (e) => this.onMessage(e.data);
    if (M) this.dspReady();
  }

  dspReady() {
    this.makeShifter();
    this.port.postMessage({ type: 'dspReady' });
  }

  makeShifter() {
    if (!M) return;
    const q = this.settings.mtQuality in SHIFTER_PRESETS ? this.settings.mtQuality : 'tight';
    if (this.shifter && this.shifterQuality === q) return;
    if (this.shifter) M._st_destroy(this.shifter);
    const [block, interval] = SHIFTER_PRESETS[q];
    this.shifter = M._st_create(2, sampleRate, block, interval);
    this.shifterQuality = q;
    this.needsSeed = true;
    this.applyRate();
  }

  /** Should the pitch shifter be in the path right now? */
  wantShift() {
    if (!this.keylock || !this.shifter || !this.src) return false;
    return this.kind === 'audio' || this.settings.mtMode !== 'native';
  }

  applyRate() {
    if (!this.src) return;
    const t = this.rate * this.bend;
    const shift = this.wantShift();
    if (shift && !this.shifting) this.needsSeed = true;
    this.shifting = shift;
    this.src.tempoMul = t;
    if (this.kind !== 'audio') this.src.pitchMul = this.keylock && !shift ? 1 : t;
    if (shift) M._st_set_transpose(this.shifter, 1 / t);
  }

  applySettings() {
    const s = this.settings;
    if (this.src && this.kind !== 'audio') {
      this.src.interpolation = s.interpolation;
      this.src.stereoSep = s.stereoSep;
      this.src.songLoop = s.songLoop;
      this.src.rowsPerBeat = s.rowsPerBeat;
    }
    this.makeShifter();
    this.applyRate();
  }

  setSource(src, kind) {
    if (this.src && this.src.destroy) this.src.destroy();
    this.src = src;
    this.kind = kind;
    this.playing = false; this.fade = 0;
    this.needsSeed = true;
    this.applySettings();
  }

  onMessage(m) {
    try {
      this.handle(m);
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    this.report(true);
  }

  handle(m) {
    switch (m.type) {
      case 'loadMod': this.setSource(new ModPlayer(m.song, sampleRate), 'mod'); break;
      case 'loadTracker': this.setSource(new TrackerPlayer(M, m.bytes, sampleRate), 'tracker'); break;
      case 'loadAudio': this.setSource(new BufferPlayer(m.channels, m.sampleRate, sampleRate), 'audio'); break;
      case 'play':
        if (this.src) { this.playing = true; if (this.src.ended) this.restart(); }
        break;
      case 'pause': this.playing = false; break;
      case 'rate': this.rate = m.value; this.applyRate(); break;
      case 'bend': this.bend = m.value; this.applyRate(); break;
      case 'keylock': this.keylock = m.on; this.applyRate(); break;
      case 'gain': this.gain = m.value; break;
      case 'settings': Object.assign(this.settings, m.settings); this.applySettings(); break;
      case 'mute': if (this.src && this.src.setMute) this.src.setMute(m.channel, m.on); break;
      case 'seek': this.seek(m); break;
      case 'loop': this.loopCmd(m); break;
      case 'grid':
        if (this.kind === 'audio') { this.src.bpm = m.bpm; this.src.gridOffset = m.offset || 0; }
        break;
    }
  }

  restart() {
    if (this.kind === 'mod') this.src.seek(0, 0, 6, 125);
    else if (this.kind === 'tracker') this.src.seekSeconds(0);
    else this.src.seek(0);
    this.needsSeed = true;
  }

  seek(m) {
    const s = this.src;
    if (!s) return;
    const quant = m.quantize && this.playing;
    if (this.kind === 'mod') {
      if (quant) s.seekQuantized(m.order, m.row, m.speed, m.tempo);
      else s.seek(m.order, m.row, m.speed, m.tempo);
    } else if (this.kind === 'tracker') {
      if (quant) s.seekQuantized(m.order, m.row, m.seconds);
      else s.seekSeconds(m.seconds);
    } else {
      if (quant) s.seekQuantized(m.frame);
      else s.seek(m.frame);
    }
    // An immediate jump: re-prime the shifter so we hear the new spot right away.
    if (!quant) this.needsSeed = true;
  }

  // Loop commands. MOD + tracker work in rows; audio in frames.
  loopCmd(m) {
    const s = this.src;
    if (!s) return;
    if (this.kind !== 'audio') {
      const rpb = s.rowsPerBeat;
      switch (m.action) {
        case 'auto': {
          // Start on the current beat (already partly played — keeps it seamless).
          const back = m.quantize ? s.row % rpb : 0;
          s.setLoop(s.order, s.row - back, s.speed, s.tempo, Math.max(1, Math.round(m.beats * rpb)), back);
          break;
        }
        case 'in': s.markLoopIn(m.quantize); break;
        case 'out': s.markLoopOut(m.quantize); break;
        case 'exit': s.clearLoop(); break;
        case 'reloop':
          if (s.lastLoop) {
            const L = s.lastLoop;
            s.setLoop(L.order, L.row, L.speed, L.tempo, L.length, 0);
            s.seekRow(L);
            this.needsSeed = true;
          }
          break;
        case 'scale':
          if (s.loop) s.loop.length = Math.max(1, Math.round(s.loop.length * m.factor));
          break;
      }
      if (s.loop) s.lastLoop = { ...s.loop };
    } else {
      const bf = s.beatFrames();
      switch (m.action) {
        case 'auto': {
          if (!bf) break;
          const start = m.quantize ? s.beatFloor(s.pos) : s.pos;
          s.setLoop(start, start + m.beats * bf);
          break;
        }
        case 'in': s.loopIn = m.quantize && bf ? s.beatFloor(s.pos + bf / 2) : s.pos; break;
        case 'out': {
          if (s.loopIn < 0) break;
          let end = s.pos;
          if (m.quantize && bf) end = s.loopIn + Math.max(1, Math.round((end - s.loopIn) / bf)) * bf;
          s.setLoop(s.loopIn, end);
          if (s.pos >= end) s.pos = s.loopIn;
          break;
        }
        case 'exit': s.clearLoop(); break;
        case 'reloop':
          if (s.lastLoop) { s.setLoop(s.lastLoop.start, s.lastLoop.end); s.seek(s.lastLoop.start); this.needsSeed = true; }
          break;
        case 'scale':
          if (s.loop) s.setLoop(s.loop.start, s.loop.start + (s.loop.end - s.loop.start) * m.factor);
          break;
      }
      if (s.loop) s.lastLoop = { ...s.loop };
    }
  }

  report(force) {
    if (!this.src) return;
    if (!force && this.sinceReport < this.reportEvery) return;
    this.sinceReport = 0;
    const st = this.src.state();
    st.playing = this.playing;
    st.kind = this.kind;
    st.time = currentTime;
    st.out = this.outPeak;
    st.shifting = this.shifting;
    st.latency = this.shifting ? M._st_latency(this.shifter) : 0;
    this.outPeak = 0;
    this.port.postMessage({ type: 'state', state: st });
  }

  ensureTmp(n) {
    if (this.tmpL.length < n) { this.tmpL = new Float32Array(n); this.tmpR = new Float32Array(n); }
  }

  /** Render n frames of source audio into tmpL/tmpR. */
  renderSource(n) {
    this.ensureTmp(n);
    return this.src.render(this.tmpL, this.tmpR, 0, n);
  }

  /** Fill the shifter with upcoming audio so its output starts right there, with no latency. */
  seedShifter() {
    const sh = this.shifter;
    M._st_reset(sh);
    const len = M._st_seek_length(sh);
    this.renderSource(len);
    f32(M, M._st_in(sh, 0, len), len).set(this.tmpL.subarray(0, len));
    f32(M, M._st_in(sh, 1, len), len).set(this.tmpR.subarray(0, len));
    M._st_output_seek(sh, len);
    this.needsSeed = false;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.src || (!this.playing && this.fade <= 0)) {
      L.fill(0); if (R !== L) R.fill(0);
      this.sinceReport += n; this.report(false);
      return true;
    }

    let alive;
    let srcL, srcR;
    if (this.shifting) {
      if (this.needsSeed) this.seedShifter();
      const sh = this.shifter;
      alive = this.renderSource(n);
      f32(M, M._st_in(sh, 0, n), n).set(this.tmpL.subarray(0, n));
      f32(M, M._st_in(sh, 1, n), n).set(this.tmpR.subarray(0, n));
      M._st_process(sh, n);
      // Copy out before anything else can touch wasm memory.
      this.tmpL.set(f32(M, M._st_out(sh, 0, n), n));
      this.tmpR.set(f32(M, M._st_out(sh, 1, n), n));
    } else {
      alive = this.renderSource(n);
    }
    srcL = this.tmpL; srcR = this.tmpR;

    const target = this.playing ? 1 : 0;
    const g = this.gain;
    for (let i = 0; i < n; i++) {
      if (this.fade < target) this.fade = Math.min(1, this.fade + this.fadeStep);
      else if (this.fade > target) this.fade = Math.max(0, this.fade - this.fadeStep);
      // Gentle soft clip so an over-driven trim doesn't hard-clip the mixer input.
      let l = srcL[i] * g * this.fade, r = srcR[i] * g * this.fade;
      if (l > 0.9 || l < -0.9) l = Math.tanh(l);
      if (r > 0.9 || r < -0.9) r = Math.tanh(r);
      L[i] = l;
      if (R !== L) R[i] = r;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > this.outPeak) this.outPeak = a;
    }

    if (!alive) this.playing = false;
    this.sinceReport += n;
    this.report(!alive);
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
