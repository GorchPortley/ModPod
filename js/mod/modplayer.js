// modplayer.js — ProTracker MOD playback engine, built for DJ use.
//
// Runs inside the AudioWorklet. Plain classes and typed arrays only, so
// it would port almost line-for-line to a C++ class if you ever want to.
//
// DJ-specific additions compared to a normal tracker player:
//   * tempoMul and pitchMul are independent → "master tempo" (key lock) is free:
//     tempo changes the tick rate, pitch changes sample playback rate.
//   * per-channel mute (each channel is effectively a stem)
//   * beat-quantized jumps and seamless row-based loops
//   * volume ramping + note fade-outs so retriggers don't click on a big system

import { PAL_CLOCK, PERIOD_TABLES, NUM_NOTES } from './modfile.js';

const SINE = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];

const RAMP_SAMPLES = 48;  // ~1 ms volume ramp to avoid zipper noise / clicks
const FADE_SAMPLES = 96;  // fade-out length for a voice cut by a new note

function waveValue(wave, pos) {
  // pos 0..63 → -255..255
  const p = pos & 63;
  switch (wave & 3) {
    case 0: return p < 32 ? SINE[p] : -SINE[p - 32];
    case 1: return 255 - p * 8;               // ramp down
    default: return p < 32 ? 255 : -255;      // square (3 = "random" → square)
  }
}

/** One playing sample: position, increment, loop info. Used for active + fading voices. */
class Voice {
  constructor() {
    this.sample = null;
    this.pos = 0;
    this.active = false;
  }
  copyFrom(v) {
    this.sample = v.sample; this.pos = v.pos; this.active = v.active;
  }
}

class Channel {
  constructor(index, numChannels) {
    this.index = index;
    this.voice = new Voice();
    this.fade = new Voice();      // previous note, fading out
    this.fadeGainL = 0; this.fadeGainR = 0; this.fadeLeft = 0; this.fadeStep = 0;
    this.fadeInc = 0;

    this.sampleNum = 0;
    this.instrument = null;       // sample selected by the last instrument number
    this.note = -1;
    this.period = 0;              // current period (affected by slides)
    this.outPeriod = 0;           // period used for output this tick (vibrato/arp)
    this.volume = 0;
    this.outVolume = 0;
    this.finetune = 0;

    this.effect = 0; this.param = 0;
    this.portaTarget = 0; this.portaSpeed = 0; this.glissando = false;
    this.vibSpeed = 0; this.vibDepth = 0; this.vibPos = 0; this.vibWave = 0;
    this.tremSpeed = 0; this.tremDepth = 0; this.tremPos = 0; this.tremWave = 0;
    this.offsetMem = 0;
    this.loopRow = 0; this.loopCount = 0;
    this.delayTick = -1; this.delayPeriod = 0; this.delaySample = 0;

    // Default Amiga panning LRRL.
    const lr = [0, 1, 1, 0][index % 4];
    this.basePan = lr;           // 0 = left, 1 = right
    this.pan = lr;

    this.muted = false;
    this.gainL = 0; this.gainR = 0;   // currently applied (ramped) gains
    this.peak = 0;                    // for VU meters
  }
}

export class ModPlayer {
  constructor(song, sampleRate) {
    this.song = song;
    this.sampleRate = sampleRate;
    this.nch = song.channels;
    this.channels = [];
    for (let i = 0; i < this.nch; i++) this.channels.push(new Channel(i, this.nch));

    // Settings
    this.interpolation = 1;    // 0 = none (crunchy Amiga), 1 = linear, 2 = cubic
    this.stereoSep = 0.5;      // 0 = mono, 1 = hard Amiga panning
    this.songLoop = false;     // loop at song end instead of stopping
    this.rowsPerBeat = 4;
    this.tempoMul = 1;         // from tempo fader
    this.pitchMul = 1;         // = tempoMul unless key lock is on
    this.channelGain = this.nch <= 4 ? 0.5 : this.nch <= 8 ? 0.35 : 0.25;

    this.reset();
  }

  reset() {
    this.order = 0; this.row = 0; this.tick = 0;
    this.speed = 6; this.tempo = 125;
    this.tickRemain = 0;
    this.patDelay = 0; this.inPatDelay = false;
    this.posJump = -1; this.breakRow = -1; this.loopJump = -1;
    this.ended = false;
    this.visited = new Uint8Array(128 * 64);
    this.pendingSeek = null;
    this.loop = null; // { order, row, speed, tempo, length, count }
    this.loopIn = null;
    this.firstTick = true;
    for (const c of this.channels) {
      c.voice.active = false; c.fade.active = false; c.fadeLeft = 0;
      c.volume = 0; c.outVolume = 0; c.period = 0; c.outPeriod = 0;
      c.loopRow = 0; c.loopCount = 0; c.delayTick = -1;
    }
  }

  // ---------------------------------------------------------------- positioning

  /** Jump to (order,row). Notes are faded out; speed/tempo come from the timeline. */
  seek(order, row, speed, tempo, cutNotes = true) {
    this.order = Math.max(0, Math.min(order, this.song.songLength - 1));
    this.row = Math.max(0, Math.min(row, 63));
    if (speed) this.speed = speed;
    if (tempo) this.tempo = tempo;
    this.tick = 0;
    this.tickRemain = 0;
    this.firstTick = true;
    this.patDelay = 0; this.inPatDelay = false;
    this.posJump = -1; this.breakRow = -1; this.loopJump = -1;
    this.ended = false;
    this.visited.fill(0);
    if (cutNotes) {
      for (const c of this.channels) {
        this.startFade(c);
        c.voice.active = false;
        c.loopRow = 0; c.loopCount = 0; c.delayTick = -1;
      }
    }
  }

  /** Jump to a loop start (keeps playing notes; restores the loop's speed/tempo). */
  seekRow(L) { this.seek(L.order, L.row, L.speed, L.tempo, true); }

  setMute(ch, on) { if (this.channels[ch]) this.channels[ch].muted = on; }

  /** Queue a jump that happens on the next beat boundary (quantize). */
  seekQuantized(order, row, speed, tempo) {
    this.pendingSeek = { order, row, speed, tempo };
  }

  // DJ loops are measured in rows actually played, so they work across
  // pattern breaks and odd pattern lengths.
  setLoop(order, row, speed, tempo, length, alreadyPlayed = 0) {
    this.loop = { order, row, speed, tempo, length: Math.max(1, length), count: alreadyPlayed };
  }
  clearLoop() { this.loop = null; }

  /** Loop-in: remember where we are (optionally snapped back to the beat start). */
  markLoopIn(quantize) {
    const back = quantize ? this.row % this.rowsPerBeat : 0;
    this.loopIn = { order: this.order, row: this.row - back, speed: this.speed, tempo: this.tempo, count: back };
  }

  /** Loop-out: loop from loop-in to the end of the current row (rounded to beats if quantized). */
  markLoopOut(quantize) {
    const li = this.loopIn;
    if (!li) return;
    let len = li.count + 1;
    if (quantize) len = Math.max(this.rowsPerBeat, Math.round(len / this.rowsPerBeat) * this.rowsPerBeat);
    this.setLoop(li.order, li.row, li.speed, li.tempo, len, Math.min(li.count, len - 1));
    this.loopIn = null;
  }

  beatStartOffset() { return this.row % this.rowsPerBeat; }

  // ---------------------------------------------------------------- effects helpers

  periodFor(ch, note) {
    return PERIOD_TABLES[ch.finetune & 15][Math.max(0, Math.min(note, NUM_NOTES - 1))];
  }

  clampPeriod(p) {
    // ProTracker clamps to 113..856 for 4-channel MODs; be lenient for others.
    if (this.nch === 4) return Math.max(113, Math.min(856, p));
    return Math.max(28, Math.min(6848, p));
  }

  startFade(ch) {
    if (!ch.voice.active || (ch.gainL === 0 && ch.gainR === 0)) return;
    ch.fade.copyFrom(ch.voice);
    ch.fadeInc = ch.voice.inc || 0;
    ch.fadeGainL = ch.gainL; ch.fadeGainR = ch.gainR;
    ch.fadeLeft = FADE_SAMPLES;
  }

  triggerNote(ch, offset) {
    const s = ch.instrument;
    if (!s || s.length === 0) return;
    this.startFade(ch);
    const v = ch.voice;
    v.sample = s;
    v.pos = 0;
    v.active = true;
    if (offset) {
      if (offset < s.length) v.pos = offset;
      else if (s.looped) v.pos = s.loopStart;
      else v.active = false;
    }
    ch.gainL = 0; ch.gainR = 0; // ramp in from silence
    if (!(ch.vibWave & 4)) ch.vibPos = 0;
    if (!(ch.tremWave & 4)) ch.tremPos = 0;
  }

  volSlide(ch, p) {
    const x = p >> 4, y = p & 15;
    if (x) ch.volume = Math.min(64, ch.volume + x);
    else ch.volume = Math.max(0, ch.volume - y);
  }

  tonePorta(ch) {
    if (!ch.portaTarget) return;
    if (ch.period < ch.portaTarget) {
      ch.period = Math.min(ch.period + ch.portaSpeed, ch.portaTarget);
    } else if (ch.period > ch.portaTarget) {
      ch.period = Math.max(ch.period - ch.portaSpeed, ch.portaTarget);
    }
    ch.outPeriod = ch.period;
    if (ch.glissando) {
      // Round to nearest semitone.
      const t = PERIOD_TABLES[ch.finetune & 15];
      let best = ch.period, err = Infinity;
      for (let n = 0; n < NUM_NOTES; n++) {
        const e = Math.abs(t[n] - ch.period);
        if (e < err) { err = e; best = t[n]; }
      }
      ch.outPeriod = best;
    }
  }

  vibrato(ch) {
    const delta = (waveValue(ch.vibWave, ch.vibPos) * ch.vibDepth) / 128;
    ch.outPeriod = ch.period + delta;
    ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63;
  }

  tremolo(ch) {
    const delta = (waveValue(ch.tremWave, ch.tremPos) * ch.tremDepth) / 64;
    ch.outVolume = Math.max(0, Math.min(64, ch.volume + delta));
    ch.tremPos = (ch.tremPos + ch.tremSpeed) & 63;
  }

  arpeggio(ch, p) {
    const step = this.tick % 3;
    if (step === 0 || ch.period <= 0) { ch.outPeriod = ch.period; return; }
    const semis = step === 1 ? p >> 4 : p & 15;
    // Find the note of the current period in this finetune's table.
    const t = PERIOD_TABLES[ch.finetune & 15];
    let n = 0;
    while (n < NUM_NOTES - 1 && t[n] > ch.period) n++;
    ch.outPeriod = t[Math.min(n + semis, NUM_NOTES - 1)];
  }

  // ---------------------------------------------------------------- row / tick

  processRow() {
    const song = this.song;
    const pat = Math.min(song.orders[this.order], song.numPatterns - 1);
    const base = (pat * 64 + this.row) * this.nch;
    const { period: periods, note: notes, sample: smps, effect: effs, param: prms } = song.cells;

    for (let c = 0; c < this.nch; c++) {
      const ch = this.channels[c];
      const i = base + c;
      const period = periods[i], note = notes[i], smp = smps[i];
      const e = effs[i], p = prms[i];
      ch.effect = e; ch.param = p;
      ch.delayTick = -1;

      const isDelay = e === 0x0e && (p >> 4) === 0xd && (p & 15) > 0;
      if (isDelay) {
        ch.delayTick = p & 15; ch.delayPeriod = period; ch.delayNote = note; ch.delaySample = smp;
      } else {
        this.readCell(ch, period, note, smp, e, p);
      }

      ch.outPeriod = ch.period;
      ch.outVolume = ch.volume;

      // Tick-0 effects.
      switch (e) {
        case 0x3: if (p) ch.portaSpeed = p; break;
        case 0x4:
          if (p >> 4) ch.vibSpeed = p >> 4;
          if (p & 15) ch.vibDepth = p & 15;
          break;
        case 0x7:
          if (p >> 4) ch.tremSpeed = p >> 4;
          if (p & 15) ch.tremDepth = p & 15;
          break;
        case 0x8: ch.pan = p / 255; break;
        case 0xb: this.posJump = p; if (this.breakRow < 0) this.breakRow = 0; break;
        case 0xc: ch.volume = ch.outVolume = Math.min(p, 64); break;
        case 0xd: {
          let r = (p >> 4) * 10 + (p & 15);
          if (r > 63) r = 0;
          this.breakRow = r;
          break;
        }
        case 0xe: this.extendedTick0(ch, p); break;
        case 0xf:
          if (p === 0) break;          // F00 = stop in PT; ignored (we're DJing!)
          if (p < 32) this.speed = p; else this.tempo = p;
          break;
      }
    }
  }

  readCell(ch, period, note, smp, e, p) {
    if (smp > 0 && smp <= this.song.numSamples) {
      const s = this.song.samples[smp - 1];
      ch.sampleNum = smp;
      ch.instrument = s;
      ch.volume = s.volume;
      ch.finetune = s.finetune;
    }
    if (period > 0) {
      if (e === 0x0e && (p >> 4) === 0x5) ch.finetune = p & 15;
      const target = note >= 0 ? this.periodFor(ch, note) : period;
      if (e === 0x3 || e === 0x5) {
        ch.portaTarget = target;
        if (!ch.voice.active) { ch.period = target; this.triggerNote(ch, 0); }
      } else {
        ch.note = note;
        ch.period = target;
        let offset = 0;
        if (e === 0x9) {
          if (p) ch.offsetMem = p;
          offset = ch.offsetMem * 256;
        }
        this.triggerNote(ch, offset);
      }
    }
  }

  extendedTick0(ch, p) {
    const x = p >> 4, y = p & 15;
    switch (x) {
      case 0x1: ch.period = this.clampPeriod(ch.period - y); ch.outPeriod = ch.period; break;
      case 0x2: ch.period = this.clampPeriod(ch.period + y); ch.outPeriod = ch.period; break;
      case 0x3: ch.glissando = y !== 0; break;
      case 0x4: ch.vibWave = y; break;
      case 0x6:
        if (y === 0) ch.loopRow = this.row;
        else if (ch.loopCount === 0) { ch.loopCount = y; this.loopJump = ch.loopRow; }
        else if (--ch.loopCount > 0) this.loopJump = ch.loopRow;
        break;
      case 0x7: ch.tremWave = y; break;
      case 0x8: ch.pan = y / 15; break;
      case 0xa: ch.volume = Math.min(64, ch.volume + y); ch.outVolume = ch.volume; break;
      case 0xb: ch.volume = Math.max(0, ch.volume - y); ch.outVolume = ch.volume; break;
      case 0xc: if (y === 0) { ch.volume = 0; ch.outVolume = 0; } break;
      case 0xe: if (!this.inPatDelay && !this.patDelay) this.patDelay = y; break;
    }
  }

  processEffectsTick() {
    for (const ch of this.channels) {
      const e = ch.effect, p = ch.param;
      ch.outPeriod = ch.period;
      ch.outVolume = ch.volume;
      switch (e) {
        case 0x0: if (p) this.arpeggio(ch, p); break;
        case 0x1: ch.period = this.clampPeriod(ch.period - p); ch.outPeriod = ch.period; break;
        case 0x2: ch.period = this.clampPeriod(ch.period + p); ch.outPeriod = ch.period; break;
        case 0x3: this.tonePorta(ch); break;
        case 0x4: this.vibrato(ch); break;
        case 0x5: this.tonePorta(ch); this.volSlide(ch, p); ch.outVolume = ch.volume; break;
        case 0x6: this.vibrato(ch); this.volSlide(ch, p); ch.outVolume = ch.volume; break;
        case 0x7: this.tremolo(ch); break;
        case 0xa: this.volSlide(ch, p); ch.outVolume = ch.volume; break;
        case 0xe: {
          const x = p >> 4, y = p & 15;
          if (x === 0x9 && y && this.tick % y === 0) {
            this.triggerNote(ch, 0);
          } else if (x === 0xc && this.tick === y) {
            ch.volume = 0; ch.outVolume = 0;
          } else if (x === 0xd && this.tick === ch.delayTick) {
            this.readCell(ch, ch.delayPeriod, ch.delayNote, ch.delaySample, 0, 0);
            ch.outPeriod = ch.period; ch.outVolume = ch.volume;
          }
          break;
        }
      }
    }
  }

  /** Called once per tick. */
  doTick() {
    if (this.firstTick) {
      this.firstTick = false;
      this.visited[this.order * 64 + this.row] = 1;
      this.processRow();
      return;
    }
    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      if (this.patDelay > 0) {
        this.patDelay--; this.inPatDelay = true;
        this.processEffectsTick();
        return;
      }
      this.inPatDelay = false;
      this.advanceRow();
      if (this.ended) return;
      this.processRow();
    } else {
      this.processEffectsTick();
    }
  }

  advanceRow() {
    const song = this.song;
    let order = this.order, row = this.row;
    let natural = true;

    if (this.loopJump >= 0) {
      row = this.loopJump; natural = false;
      for (let r = row; r <= this.row; r++) this.visited[order * 64 + r] = 0;
    } else if (this.posJump >= 0 || this.breakRow >= 0) {
      order = this.posJump >= 0 ? this.posJump : order + 1;
      row = this.breakRow >= 0 ? this.breakRow : 0;
    } else if (++row >= 64) {
      row = 0; order++;
    }
    this.loopJump = -1; this.posJump = -1; this.breakRow = -1;
    if (order >= song.songLength) order = song.restart;
    if (order !== this.order) for (const c of this.channels) { c.loopRow = 0; }

    if (this.loopIn) this.loopIn.count++;

    // DJ loop.
    if (this.loop) {
      if (++this.loop.count >= this.loop.length) {
        const L = this.loop;
        L.count = 0;
        this.order = L.order; this.row = L.row;
        this.speed = L.speed; this.tempo = L.tempo;
        this.visited.fill(0);
        this.visited[this.order * 64 + this.row] = 1;
        return;
      }
    }

    // Quantized jump: wait for a beat boundary.
    if (this.pendingSeek && row % this.rowsPerBeat === 0) {
      const s = this.pendingSeek;
      this.pendingSeek = null;
      this.order = s.order; this.row = s.row;
      if (s.speed) this.speed = s.speed;
      if (s.tempo) this.tempo = s.tempo;
      this.visited.fill(0);
      this.visited[this.order * 64 + this.row] = 1;
      return;
    }

    const key = order * 64 + row;
    if (natural && this.visited[key] && !this.songLoop) {
      this.ended = true;
      return;
    }
    if (this.visited[key]) this.visited.fill(0);
    this.visited[key] = 1;
    this.order = order; this.row = row;
  }

  // ---------------------------------------------------------------- mixing

  updateGains() {
    for (const ch of this.channels) {
      const sep = this.stereoSep;
      const pan = 0.5 + (ch.pan - 0.5) * sep; // narrow the stereo image
      // Equal-power pan, normalised so centre = 1/√2 per side ≈ -3 dB.
      const vol = ch.muted ? 0 : (ch.outVolume / 64) * this.channelGain;
      ch.targetL = vol * Math.cos(pan * Math.PI / 2) * Math.SQRT2;
      ch.targetR = vol * Math.sin(pan * Math.PI / 2) * Math.SQRT2;
      const per = ch.outPeriod > 0 ? ch.outPeriod : ch.period;
      ch.voice.inc = per > 0 ? (PAL_CLOCK / per) * this.pitchMul / this.sampleRate : 0;
    }
  }

  /**
   * Render n frames into outL/outR (adds nothing — overwrites).
   * Returns false once the song has ended (and loop is off).
   */
  render(outL, outR, offset, n) {
    let pos = offset;
    const end = offset + n;
    while (pos < end) {
      if (this.tickRemain <= 0) {
        if (this.ended) { outL.fill(0, pos, end); outR.fill(0, pos, end); return false; }
        this.doTick();
        if (this.ended) continue;
        this.updateGains();
        this.tickRemain += (this.sampleRate * 2.5) / (this.tempo * this.tempoMul);
      }
      const chunk = Math.min(end - pos, Math.max(1, Math.ceil(this.tickRemain)));
      this.mixChunk(outL, outR, pos, chunk);
      pos += chunk;
      this.tickRemain -= chunk;
    }
    return true;
  }

  mixChunk(outL, outR, start, n) {
    outL.fill(0, start, start + n);
    outR.fill(0, start, start + n);
    for (const ch of this.channels) {
      let peak = ch.peak;
      // Fading-out voice (previous note).
      if (ch.fadeLeft > 0 && ch.fade.active) {
        const f = ch.fade;
        const s = f.sample;
        const len = Math.min(n, ch.fadeLeft);
        for (let i = 0; i < len; i++) {
          const g = (ch.fadeLeft - i) / FADE_SAMPLES;
          const v = this.fetch(s, f.pos);
          outL[start + i] += v * ch.fadeGainL * g;
          outR[start + i] += v * ch.fadeGainR * g;
          if (!this.advance(f, ch.fadeInc)) break;
        }
        ch.fadeLeft -= len;
        if (ch.fadeLeft <= 0) f.active = false;
      }

      const v = ch.voice;
      if (!v.active || v.inc <= 0) { ch.gainL = 0; ch.gainR = 0; ch.peak = peak; continue; }
      const s = v.sample;
      let gL = ch.gainL, gR = ch.gainR;
      const tL = ch.targetL, tR = ch.targetR;
      const rampN = Math.min(n, RAMP_SAMPLES);
      const dL = (tL - gL) / RAMP_SAMPLES, dR = (tR - gR) / RAMP_SAMPLES;
      for (let i = 0; i < n; i++) {
        if (i < rampN) {
          gL += dL; gR += dR;
          if ((dL > 0 && gL > tL) || (dL < 0 && gL < tL)) gL = tL;
          if ((dR > 0 && gR > tR) || (dR < 0 && gR < tR)) gR = tR;
        } else { gL = tL; gR = tR; }
        const x = this.fetch(s, v.pos);
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        outL[start + i] += x * gL;
        outR[start + i] += x * gR;
        if (!this.advance(v, v.inc)) break;
      }
      ch.gainL = gL; ch.gainR = gR;
      ch.peak = ch.muted ? 0 : peak * ch.outVolume / 64;
    }
  }

  /** Advance a voice; handles looping. Returns false if the voice stopped. */
  advance(v, inc) {
    v.pos += inc;
    const s = v.sample;
    if (s.looped) {
      const loopEnd = s.loopStart + s.loopLength;
      if (v.pos >= loopEnd) v.pos = s.loopStart + ((v.pos - loopEnd) % s.loopLength);
    } else if (v.pos >= s.length) {
      v.active = false;
      return false;
    }
    return true;
  }

  /** Read sample value at fractional position with the selected interpolation. */
  fetch(s, pos) {
    const d = s.data;
    const i = pos | 0;
    if (this.interpolation === 0) return d[i] || 0;
    const frac = pos - i;
    const at = (k) => {
      if (k < s.length && (!s.looped || k < s.loopStart + s.loopLength)) return d[k];
      if (s.looped) return d[s.loopStart + ((k - s.loopStart) % s.loopLength)];
      return 0;
    };
    const x0 = d[i] || 0, x1 = at(i + 1);
    if (this.interpolation === 1) return x0 + (x1 - x0) * frac;
    // Cubic Hermite
    const xm = i > 0 ? d[i - 1] : x0, x2 = at(i + 2);
    const c1 = 0.5 * (x1 - xm);
    const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * frac + c2) * frac + c1) * frac + x0;
  }

  /** Snapshot for the UI. Peaks reset after reading. */
  state() {
    const vu = new Array(this.nch);
    for (let i = 0; i < this.nch; i++) { vu[i] = this.channels[i].peak; this.channels[i].peak = 0; }
    return {
      order: this.order, row: this.row, tick: this.tick, speed: this.speed, tempo: this.tempo,
      ended: this.ended, vu,
      loop: this.loop ? { order: this.loop.order, row: this.loop.row, length: this.loop.length, count: this.loop.count } : null,
      pendingSeek: !!this.pendingSeek,
      loopInSet: !!this.loopIn,
    };
  }
}
