// deck.js — the deck controller (UI thread side).
//
// Owns the AudioContext + worklet node, loads files, keeps the latest
// playback state, and implements the CDJ behaviours (cue, hot cues, loops).
// No DOM code in here — app.js wires it to the screen.

import { parseMod, buildTimeline, timelineAt } from './mod/modfile.js';
import { detect } from './library/formats.js';
import { ModSongView, TrackerSongView } from './songview.js';
import { getDsp } from './wasm/dsp.js';
import { bpmFor, guessRowsPerBeat } from './tempo.js';

const STORE_KEY = 'modpod.tracks.v1';
const SETTINGS_KEY = 'modpod.settings.v2';

export const DEFAULT_SETTINGS = {
  interpolation: 1,     // 0 none / 1 linear / 2 cubic
  stereoSep: 0.5,       // 0 mono … 1 hard Amiga panning
  songLoop: false,      // stop at song end (false) or loop
  quantize: true,
  keylock: false,       // "master tempo" — off by default, like a CDJ
  mtMode: 'stretch',    // trackers: 'stretch' (whole mix, samples stay in time) or 'native' (tick rate only)
  mtQuality: 'tight',   // 'tight' (~70 ms latency) or 'smooth' (~140 ms, cleaner)
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
    this.kind = null;         // 'mod' | 'tracker' | 'audio' | null
    this.song = null;         // parsed MOD (our JS engine)
    this.timeline = null;     // MOD timeline (song length, seek info)
    this.view = null;         // ModSongView / TrackerSongView — what the displays read
    this.rowsPerBeat = 4;     // per track
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
    this.dspReady = new Promise((resolve) => { this.resolveDsp = resolve; });
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'dspReady') this.resolveDsp();
      else if (e.data.type === 'error') { this.lastError = e.data.message; this.emit('error'); }
      else if (e.data.type === 'state') {
        const wasPlaying = this.state && this.state.playing;
        this.state = e.data.state;
        this.stateAt = performance.now();
        if (wasPlaying && !this.state.playing && this.state.ended) this.emit('ended');
      }
    };
    this.pushSettings();
  }

  /** Row-based track (MOD or tracker module)? */
  get rowBased() { return this.kind === 'mod' || this.kind === 'tracker'; }

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
    this.post({ type: 'pause' });
    this.libraryId = libraryId;
    this.name = file.name;
    this.trackKey = file.name + ':' + file.size;
    this.cueing = false;
    const oldView = this.view;
    if (fmt.kind === 'mod') this.loadMod(buf, file.name);
    else if (fmt.kind === 'tracker') await this.loadTracker(buf, file.name);
    else await this.loadAudio(buf);
    if (oldView && oldView !== this.view && oldView.destroy) oldView.destroy();
    this.restoreTrackData();
    this.emit('loaded');
  }

  loadMod(buf, filename) {
    this.song = parseMod(buf, filename);
    this.timeline = buildTimeline(this.song);
    this.view = new ModSongView(this.song);
    this.kind = 'mod';
    this.audio = null;
    this.mutes = new Array(this.song.channels).fill(false);
    // Speed/tempo after row 0 (most MODs set their tempo on the first row).
    const t = this.timeline.entries.get(1) || this.timeline.entries.get(0) || { speed: 6, tempo: 125 };
    this.rowsPerBeat = guessRowsPerBeat(t.speed, t.tempo);
    this.post({ type: 'loadMod', song: this.song });
    this.pushSettings();
    this.post({ type: 'seek', order: 0, row: 0, speed: 6, tempo: 125 });
  }

  async loadTracker(buf, filename) {
    await this.dspReady;
    const M = await getDsp();
    const bytes = new Uint8Array(buf);
    this.view = new TrackerSongView(M, bytes, filename); // UI-thread copy, for the displays
    this.kind = 'tracker';
    this.song = null; this.timeline = null; this.audio = null;
    this.mutes = new Array(this.view.channels).fill(false);
    // IT files store a "rows per beat" highlight in their header.
    const hint = this.view.format === 'IT' && bytes.length > 0x1f ? bytes[0x1e] : 0;
    this.rowsPerBeat = guessRowsPerBeat(this.view.initialSpeed, this.view.initialTempo, hint);
    this.post({ type: 'loadTracker', bytes: bytes.slice() });
    this.pushSettings();
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
    this.song = null; this.timeline = null; this.view = null; this.mutes = [];
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
      interpolation: s.interpolation, stereoSep: s.stereoSep, songLoop: s.songLoop, rowsPerBeat: this.rowsPerBeat,
      mtMode: s.mtMode, mtQuality: s.mtQuality,
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

  /** Rows per beat for the loaded track (saved with its cue points). */
  setRowsPerBeat(n) {
    this.rowsPerBeat = n;
    this.pushSettings();
    this.saveTrackData();
    this.emit('bpm');
  }

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
  // MOD/tracker positions are {order,row}; audio positions are {frame}.

  startPos() { return this.rowBased ? { order: 0, row: 0 } : { frame: 0 }; }

  currentPos() {
    const s = this.state;
    if (!s) return this.startPos();
    if (this.rowBased) return { order: s.order, row: s.row };
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
    if (this.rowBased) return a.order === b.order && a.row === b.row;
    return Math.abs(a.frame - b.frame) < 64;
  }

  quantizePos(p) {
    if (!this.settings.quantize) return p;
    if (this.rowBased) {
      const rpb = this.rowsPerBeat;
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
      if (this.state && !quantize) { this.state.order = p.order; this.state.row = p.row; this.state.tick = 0; }
    } else if (this.kind === 'tracker') {
      let seconds = this.view.timeAt(p.order, p.row);
      if (seconds < 0) seconds = Math.max(0, this.view.orderTime[p.order] ?? 0); // a part the song never plays
      this.post({ type: 'seek', order: p.order, row: p.row, seconds, quantize });
      if (this.state && !quantize) {
        Object.assign(this.state, { order: p.order, row: p.row, tick: 0, seconds });
        this.stateAt = performance.now();
      }
    } else {
      this.post({ type: 'seek', frame: p.frame, quantize });
      if (this.state && !quantize) { this.state.frame = p.frame; this.stateAt = performance.now(); }
    }
  }

  /** Jog while paused: move by `amount` rows (MOD) or seconds (audio). */
  search(amount) {
    if (!this.loaded) return;
    if (this.rowBased) {
      const { order, row } = this.currentPos();
      const p = this.view.step(order, row, amount);
      if (p) this.seekTo(p, false);
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
    if (this.kind === 'tracker') {
      const s = this.state;
      if (!s.playing || s.seconds == null) return s.seconds || 0;
      const dt = Math.min(0.1, (performance.now() - this.stateAt) / 1000);
      return s.seconds + dt * this.rate * this.bend;
    }
    return this.extrapolatedFrame() / this.audio.sampleRate;
  }

  duration() {
    if (this.kind === 'mod') return this.timeline.duration;
    if (this.kind === 'tracker') return this.view.duration;
    if (this.kind === 'audio') return this.audio.duration;
    return 0;
  }

  /** Original BPM of the track (before the tempo fader), or 0 if unknown. */
  baseBpm() {
    if (this.rowBased) {
      const s = this.state || { tempo: 125, speed: 6 };
      return bpmFor(s.speed, s.tempo, this.rowsPerBeat);
    }
    return this.bpmAudio;
  }

  // ------------------------------------------------------------------ persistence (cues per track)

  saveTrackData() {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    all[this.trackKey] = {
      cue: this.cue, hotcues: this.hotcues,
      bpm: this.bpmAudio, gridOffset: this.gridOffset, rpb: this.rowsPerBeat, saved: Date.now(),
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
    if (this.rowBased && d.rpb) { this.rowsPerBeat = d.rpb; this.pushSettings(); }
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
