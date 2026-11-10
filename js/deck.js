// deck.js — the deck controller (UI thread side).
//
// Owns the AudioContext + worklet node, loads files, keeps the latest
// playback state, and implements the CDJ behaviours (cue, hot cues, loops).
// No DOM code in here — app.js wires it to the screen.

import { parseMod, buildTimeline, timelineAt } from './mod/modfile.js';
import { detect } from './library/formats.js';

const STORE_KEY = 'modpod.tracks.v1';
const SETTINGS_KEY = 'modpod.settings.v1';

export const DEFAULT_SETTINGS = {
  interpolation: 1,     // 0 none / 1 linear / 2 cubic
  stereoSep: 0.5,       // 0 mono … 1 hard Amiga panning
  songLoop: false,      // stop at song end (false) or loop
  rowsPerBeat: 4,
  quantize: true,
  keylock: true,        // "master tempo" (MOD decks only for now)
  pitchRange: 0.08,     // ±8 %
  faderInvert: false,   // false = CDJ style (up = slower)
  gain: 0.8,
  wakeLock: true,
};

export class Deck extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.kind = null;         // 'mod' | 'audio' | null
    this.song = null;         // parsed MOD
    this.timeline = null;
    this.audio = null;        // { channels, sampleRate, length, peaks }
    this.name = '';
    this.trackKey = '';
    this.state = null;
    this.stateAt = 0;         // performance.now() when state arrived
    this.cue = null;
    this.hotcues = [null, null, null, null];
    this.mutes = [];
    this.rate = 1;            // tempo fader
    this.bend = 1;
    this.cueing = false;      // CUE held while paused → preview
    this.bpmAudio = 0;
    this.gridOffset = 0;
    this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  }

  init() {
    // Several callers may race to init (first tap + load) — share one promise.
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  async doInit() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('js/deck-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'deck-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.node.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'state') {
        const wasPlaying = this.state && this.state.playing;
        this.state = e.data.state;
        this.stateAt = performance.now();
        if (wasPlaying && !this.state.playing && this.state.ended) this.emit('ended');
      }
    };
    this.pushSettings();
  }

  async resume() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  post(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); }
  emit(type) { this.dispatchEvent(new Event(type)); }

  // ------------------------------------------------------------------ loading

  /** Load a File/Blob. `libraryId` links it to its library entry (or null). */
  async loadFile(file, libraryId = null) {
    await this.resume();
    const buf = await file.arrayBuffer();
    const fmt = detect(buf, file.name);
    if (!fmt) throw new Error(`"${file.name}" isn't a format ModPod knows.`);
    if (fmt.kind === 'tracker') {
      throw new Error(`${fmt.format} playback isn't built yet — it's next on the list (libopenmpt engine). The file is safe in your library.`);
    }
    this.post({ type: 'pause' });
    this.libraryId = libraryId;
    this.name = file.name;
    this.trackKey = file.name + ':' + file.size;
    this.cueing = false;
    if (fmt.kind === 'mod') {
      this.loadMod(buf, file.name);
    } else {
      await this.loadAudio(buf);
    }
    this.restoreTrackData();
    this.emit('loaded');
  }

  loadMod(buf, filename) {
    this.song = parseMod(buf, filename);
    this.timeline = buildTimeline(this.song);
    this.kind = 'mod';
    this.audio = null;
    this.mutes = new Array(this.song.channels).fill(false);
    this.post({ type: 'loadMod', song: this.song });
    this.pushSettings();
    this.post({ type: 'seek', order: 0, row: 0, speed: 6, tempo: 125 });
  }

  async loadAudio(buf) {
    let ab;
    try {
      ab = await this.ctx.decodeAudioData(buf);
    } catch (err) {
      throw new Error("Couldn't read this file — it's not a MOD and the browser can't decode it as audio.");
    }
    const channels = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) channels.push(new Float32Array(ab.getChannelData(c)));
    this.audio = {
      sampleRate: ab.sampleRate,
      length: ab.length,
      duration: ab.duration,
      peaks: computePeaks(channels, 256),
      peakBin: 256,
    };
    this.kind = 'audio';
    this.song = null; this.timeline = null; this.mutes = [];
    // Copies are transferred (moved) to the audio thread.
    this.post({ type: 'loadAudio', channels, sampleRate: ab.sampleRate }, channels.map((c) => c.buffer));
    this.pushSettings();
  }

  // ------------------------------------------------------------------ settings

  setSetting(key, value) {
    this.settings[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    this.pushSettings();
  }

  pushSettings() {
    const s = this.settings;
    this.post({ type: 'settings', settings: {
      interpolation: s.interpolation, stereoSep: s.stereoSep, songLoop: s.songLoop, rowsPerBeat: s.rowsPerBeat,
    } });
    this.post({ type: 'keylock', on: s.keylock });
    this.post({ type: 'gain', value: s.gain });
  }

  // ------------------------------------------------------------------ transport

  get playing() { return !!(this.state && this.state.playing); }
  get loaded() { return !!this.kind; }

  play() { if (this.loaded) { this.cueing = false; this.resume(); this.post({ type: 'play' }); } }
  pause() { this.post({ type: 'pause' }); }
  togglePlay() {
    if (!this.loaded) return;
    if (this.cueing) { this.cueing = false; return; } // keep playing when CUE is released
    if (this.playing) this.pause(); else this.play();
  }

  /** CDJ CUE button, pressed. */
  cueDown() {
    if (!this.loaded) return;
    this.resume();
    if (this.playing && !this.cueing) {
      this.pause();
      this.seekTo(this.cue || this.startPos(), false);
      return;
    }
    // Paused: set the cue point here (snapped to a beat if quantize is on), then preview while held.
    const here = this.quantizePos(this.currentPos());
    if (!this.cue || !this.samePos(here, this.cue)) {
      this.cue = here;
      this.saveTrackData();
    }
    this.seekTo(this.cue, false);
    this.cueing = true;
    this.post({ type: 'play' });
  }

  /** CDJ CUE button, released. */
  cueUp() {
    if (!this.cueing) return;
    this.cueing = false;
    this.pause();
    this.seekTo(this.cue, false);
  }

  hotcue(i) {
    if (!this.loaded) return;
    if (!this.hotcues[i]) {
      this.hotcues[i] = this.quantizePos(this.currentPos());
      this.saveTrackData();
      return;
    }
    const quant = this.settings.quantize && this.playing;
    this.seekTo(this.hotcues[i], quant);
    if (!this.playing) this.play();
  }
  clearHotcue(i) { this.hotcues[i] = null; this.saveTrackData(); }

  setRate(r) { this.rate = r; this.post({ type: 'rate', value: r }); }
  setBend(b) { this.bend = b; this.post({ type: 'bend', value: b }); }

  setKeylock(on) { this.setSetting('keylock', on); }

  toggleMute(ch) {
    this.mutes[ch] = !this.mutes[ch];
    this.post({ type: 'mute', channel: ch, on: this.mutes[ch] });
  }
  solo(ch) {
    const soloed = this.mutes.every((m, i) => (i === ch ? !m : m));
    this.mutes = this.mutes.map((_, i) => (soloed ? false : i !== ch));
    this.mutes.forEach((m, i) => this.post({ type: 'mute', channel: i, on: m }));
  }

  loop(action, extra = {}) {
    this.post({ type: 'loop', action, quantize: this.settings.quantize, ...extra });
  }

  /** Tap-tempo / manual beat grid for audio tracks. */
  setGrid(bpm, offsetFrame) {
    this.bpmAudio = bpm;
    this.gridOffset = offsetFrame;
    this.post({ type: 'grid', bpm, offset: offsetFrame });
    this.saveTrackData();
    this.emit('grid');
  }

  // ------------------------------------------------------------------ positions
  // MOD positions are {order,row}; audio positions are {frame}.

  startPos() { return this.kind === 'mod' ? { order: 0, row: 0 } : { frame: 0 }; }

  currentPos() {
    const s = this.state;
    if (!s) return this.startPos();
    if (this.kind === 'mod') return { order: s.order, row: s.row };
    return { frame: Math.floor(this.extrapolatedFrame()) };
  }

  extrapolatedFrame() {
    const s = this.state;
    if (!s || this.kind !== 'audio') return 0;
    if (!s.playing) return s.frame;
    const dt = Math.min(0.1, (performance.now() - this.stateAt) / 1000);
    return Math.min(this.audio.length - 1, s.frame + dt * this.audio.sampleRate * this.rate * this.bend);
  }

  samePos(a, b) {
    if (!a || !b) return false;
    if (this.kind === 'mod') return a.order === b.order && a.row === b.row;
    return Math.abs(a.frame - b.frame) < 64;
  }

  quantizePos(p) {
    if (!this.settings.quantize) return p;
    if (this.kind === 'mod') {
      const rpb = this.settings.rowsPerBeat;
      return { order: p.order, row: p.row - (p.row % rpb) };
    }
    if (this.bpmAudio > 0) {
      const bf = (60 / this.bpmAudio) * this.audio.sampleRate;
      const f = this.gridOffset + Math.round((p.frame - this.gridOffset) / bf) * bf;
      return { frame: Math.max(0, f) };
    }
    return p;
  }

  seekTo(p, quantize) {
    if (!this.loaded || !p) return;
    if (this.kind === 'mod') {
      const t = timelineAt(this.timeline, p.order, p.row);
      this.post({ type: 'seek', order: p.order, row: p.row, speed: t.speed, tempo: t.tempo, quantize });
      if (this.state) { this.state.order = p.order; this.state.row = p.row; this.state.tick = 0; }
    } else {
      this.post({ type: 'seek', frame: p.frame, quantize });
      if (this.state && !quantize) { this.state.frame = p.frame; this.stateAt = performance.now(); }
    }
  }

  /** Jog while paused: move by `amount` rows (MOD) or seconds (audio). */
  search(amount) {
    if (!this.loaded) return;
    if (this.kind === 'mod') {
      let { order, row } = this.currentPos();
      row += amount;
      while (row < 0 && order > 0) { order--; row += 64; }
      while (row > 63 && order < this.song.songLength - 1) { order++; row -= 64; }
      row = Math.max(0, Math.min(63, row));
      this.seekTo({ order, row }, false);
    } else {
      const f = this.extrapolatedFrame() + amount * this.audio.sampleRate;
      this.seekTo({ frame: Math.max(0, Math.min(this.audio.length - 1, f)) }, false);
    }
  }

  // ------------------------------------------------------------------ display info

  /** Elapsed song time in seconds (at the track's own tempo). */
  elapsed() {
    if (!this.state) return 0;
    if (this.kind === 'mod') {
      const s = this.state;
      const t = timelineAt(this.timeline, s.order, s.row);
      return t.time + (s.tick * 2.5) / s.tempo;
    }
    return this.extrapolatedFrame() / this.audio.sampleRate;
  }

  duration() {
    if (this.kind === 'mod') return this.timeline.duration;
    if (this.kind === 'audio') return this.audio.duration;
    return 0;
  }

  /** Original BPM of the track (before the tempo fader), or 0 if unknown. */
  baseBpm() {
    if (this.kind === 'mod') {
      const s = this.state || { tempo: 125, speed: 6 };
      return (s.tempo * 24) / (s.speed * this.settings.rowsPerBeat);
    }
    return this.bpmAudio;
  }

  // ------------------------------------------------------------------ persistence (cues per track)

  saveTrackData() {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    all[this.trackKey] = {
      cue: this.cue, hotcues: this.hotcues,
      bpm: this.bpmAudio, gridOffset: this.gridOffset, saved: Date.now(),
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  }

  restoreTrackData() {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const d = all[this.trackKey] || {};
    this.cue = d.cue || this.startPos();
    this.hotcues = d.hotcues || [null, null, null, null];
    this.bpmAudio = this.kind === 'audio' ? d.bpm || 0 : 0;
    this.gridOffset = d.gridOffset || 0;
    if (this.kind === 'audio') this.post({ type: 'grid', bpm: this.bpmAudio, offset: this.gridOffset });
    this.seekTo(this.cue, false);
  }
}

/** Max-abs peaks per bin, used for the waveform displays. */
function computePeaks(channels, bin) {
  const n = channels[0].length;
  const out = new Float32Array(Math.ceil(n / bin));
  for (let b = 0; b < out.length; b++) {
    let m = 0;
    const end = Math.min(n, (b + 1) * bin);
    for (const ch of channels) {
      for (let i = b * bin; i < end; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > m) m = a; }
    }
    out[b] = m;
  }
  return out;
}
