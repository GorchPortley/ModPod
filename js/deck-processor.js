// deck-processor.js — the AudioWorklet. One per deck (one per tablet).
//
// Holds either a ModPlayer or a BufferPlayer and drives it from commands
// posted by the UI thread. Reports position/VU back ~60 times a second.

import { ModPlayer } from './mod/modplayer.js';
import { BufferPlayer } from './audio/bufferplayer.js';

const FADE_MS = 4; // short fade on play/pause so stopping mid-note doesn't click

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.src = null;
    this.kind = null;
    this.playing = false;
    this.fade = 0;              // 0..1 output fade for play/pause
    this.fadeStep = 1 / (sampleRate * FADE_MS / 1000);
    this.gain = 1;
    this.rate = 1;              // tempo fader
    this.bend = 1;              // nudge / jog (temporary)
    this.keylock = false;
    this.settings = { interpolation: 1, stereoSep: 0.5, songLoop: false, rowsPerBeat: 4 };
    this.reportEvery = Math.round(sampleRate / 60);
    this.sinceReport = 0;
    this.outPeak = 0;
    this.tmpL = new Float32Array(128);
    this.tmpR = new Float32Array(128);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  applyRate() {
    if (!this.src) return;
    const t = this.rate * this.bend;
    this.src.tempoMul = t;
    if (this.kind === 'mod') this.src.pitchMul = this.keylock ? 1 : t;
  }

  applySettings() {
    if (this.kind !== 'mod') return;
    const s = this.settings;
    this.src.interpolation = s.interpolation;
    this.src.stereoSep = s.stereoSep;
    this.src.songLoop = s.songLoop;
    this.src.rowsPerBeat = s.rowsPerBeat;
  }

  onMessage(m) {
    switch (m.type) {
      case 'loadMod':
        this.src = new ModPlayer(m.song, sampleRate);
        this.kind = 'mod';
        this.playing = false; this.fade = 0;
        this.applySettings(); this.applyRate();
        break;
      case 'loadAudio':
        this.src = new BufferPlayer(m.channels, m.sampleRate, sampleRate);
        this.kind = 'audio';
        this.playing = false; this.fade = 0;
        this.applyRate();
        break;
      case 'play':
        if (this.src) { this.playing = true; if (this.src.ended) this.restart(); }
        break;
      case 'pause': this.playing = false; break;
      case 'rate': this.rate = m.value; this.applyRate(); break;
      case 'bend': this.bend = m.value; this.applyRate(); break;
      case 'keylock': this.keylock = m.on; this.applyRate(); break;
      case 'gain': this.gain = m.value; break;
      case 'settings':
        Object.assign(this.settings, m.settings);
        this.applySettings();
        break;
      case 'mute':
        if (this.kind === 'mod' && this.src.channels[m.channel]) this.src.channels[m.channel].muted = m.on;
        break;
      case 'seek': this.seek(m); break;
      case 'loop': this.loopCmd(m); break;
      case 'grid':
        if (this.kind === 'audio') { this.src.bpm = m.bpm; this.src.gridOffset = m.offset || 0; }
        break;
    }
    this.report(true);
  }

  restart() {
    if (this.kind === 'mod') this.src.seek(0, 0, 6, 125);
    else this.src.seek(0);
  }

  seek(m) {
    const s = this.src;
    if (!s) return;
    if (this.kind === 'mod') {
      if (m.quantize && this.playing) s.seekQuantized(m.order, m.row, m.speed, m.tempo);
      else s.seek(m.order, m.row, m.speed, m.tempo);
    } else {
      if (m.quantize && this.playing) s.seekQuantized(m.frame);
      else s.seek(m.frame);
    }
  }

  // Loop commands. For MODs everything is in rows; for audio in frames.
  loopCmd(m) {
    const s = this.src;
    if (!s) return;
    if (this.kind === 'mod') {
      const rpb = s.rowsPerBeat;
      switch (m.action) {
        case 'auto': {
          // Start on the current beat (already partly played — keeps it seamless).
          const back = m.quantize ? s.row % rpb : 0;
          const len = Math.max(1, Math.round(m.beats * rpb));
          s.setLoop(s.order, s.row - back, s.speed, s.tempo, len, back);
          break;
        }
        case 'in': s.markLoopIn(m.quantize); break;
        case 'out': s.markLoopOut(m.quantize); break;
        case 'exit': s.clearLoop(); break;
        case 'reloop':
          if (s.lastLoop) { const L = s.lastLoop; s.setLoop(L.order, L.row, L.speed, L.tempo, L.length, 0); s.seek(L.order, L.row, L.speed, L.tempo, true); }
          break;
        case 'scale': // halve / double
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
          if (s.lastLoop) { s.setLoop(s.lastLoop.start, s.lastLoop.end); s.seek(s.lastLoop.start); }
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
    this.outPeak = 0;
    this.port.postMessage({ type: 'state', state: st });
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

    if (this.tmpL.length < n) { this.tmpL = new Float32Array(n); this.tmpR = new Float32Array(n); }
    const tl = this.tmpL, tr = this.tmpR;

    const alive = this.src.render(tl, tr, 0, n);

    const target = this.playing ? 1 : 0;
    const g = this.gain;
    for (let i = 0; i < n; i++) {
      if (this.fade < target) this.fade = Math.min(1, this.fade + this.fadeStep);
      else if (this.fade > target) this.fade = Math.max(0, this.fade - this.fadeStep);
      // Gentle soft clip so an over-driven trim doesn't hard-clip the mixer input.
      let l = tl[i] * g * this.fade, r = tr[i] * g * this.fade;
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
