// songview.js — one read-only interface over a song's structure, for the
// displays (pattern view, overview strip) and for row arithmetic.
//
//   ModSongView     — wraps a song parsed by our JS MOD parser
//   TrackerSongView — wraps a libopenmpt module on the UI thread (XM/S3M/IT…)
//
// cell(pattern,row,channel) returns 4 text columns: [note, instrument, volume, effect].

import { noteName } from './mod/modfile.js';
import { copyIn } from './wasm/dsp.js';

const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const EFF = '0123456789ABCDEF';

class SongViewBase {
  /** Precompute cumulative rows so we can measure distances across orders. */
  buildRowIndex() {
    this.rowStart = new Int32Array(this.songLength + 1);
    for (let o = 0; o < this.songLength; o++) this.rowStart[o + 1] = this.rowStart[o] + this.orderRows(o);
  }
  orderRows(o) {
    const p = this.orderPattern(o);
    return this.isSeparator(o) ? 0 : this.patternRows(p);
  }
  /** Absolute row number counting through the order list (for loop regions etc.). */
  absRow(order, row) { return this.rowStart[Math.max(0, Math.min(order, this.songLength))] + row; }

  /** Step k rows from (order,row) following the order list. Returns null past either end. */
  step(order, row, k) {
    row += k;
    while (row < 0) {
      do { order--; } while (order >= 0 && this.orderRows(order) === 0);
      if (order < 0) return null;
      row += this.orderRows(order);
    }
    while (row >= this.orderRows(order)) {
      row -= this.orderRows(order);
      do { order++; } while (order < this.songLength && this.orderRows(order) === 0);
      if (order >= this.songLength) return null;
    }
    return { order, row };
  }
}

export class ModSongView extends SongViewBase {
  constructor(song) {
    super();
    this.song = song;
    this.channels = song.channels;
    this.songLength = song.songLength;
    this.hasVolumeColumn = false;
    this.buildRowIndex();
  }
  orderPattern(o) { return this.song.orders[o]; }
  isSeparator() { return false; }
  patternRows() { return 64; }
  cell(p, r, c) {
    const s = this.song;
    const i = (Math.min(p, s.numPatterns - 1) * 64 + r) * s.channels + c;
    const per = s.cells.period[i], note = s.cells.note[i], smp = s.cells.sample[i];
    const e = s.cells.effect[i], prm = s.cells.param[i];
    return [
      per ? (note >= 0 ? noteName(note) : '???') : '...',
      smp ? hex2(smp) : '..',
      '',
      e || prm ? EFF[e] + hex2(prm) : '...',
    ];
  }
}

export class TrackerSongView extends SongViewBase {
  constructor(M, bytes, filename) {
    super();
    this.M = M;
    const p = copyIn(M, bytes);
    this.h = M._mpt_create(p, bytes.length, 48000);
    M._free(p);
    if (!this.h) throw new Error(`Couldn't open "${filename}": ${M.UTF8ToString(M._mpt_error())}`);
    const h = this.h;
    this.channels = M._mpt_num_channels(h);
    this.songLength = M._mpt_num_orders(h);
    this.numPatterns = M._mpt_num_patterns(h);
    this.orders = Int32Array.from({ length: this.songLength }, (_, o) => M._mpt_order_pattern(h, o));
    this.rows = Int32Array.from({ length: this.numPatterns }, (_, pt) => M._mpt_pattern_rows(h, pt));
    this.title = this.meta('title').trim() || filename.replace(/\.[^.]+$/, '');
    this.format = (this.meta('type') || '').toUpperCase();
    this.formatLong = this.meta('type_long');
    this.artist = this.meta('artist');
    this.duration = M._mpt_duration(h);
    this.initialSpeed = M._mpt_speed(h) || 6;
    this.initialTempo = M._mpt_tempo(h) || 125;
    this.hasVolumeColumn = true;
    this.cache = new Map(); // pattern → array of cells
    this.buildRowIndex();
    // When each order is first reached (−1 = never played: jumped over).
    this.orderTime = Float64Array.from({ length: this.songLength }, (_, o) => (this.isSeparator(o) ? -1 : this.timeAt(o, 0)));
  }

  destroy() { if (this.h) { this.M._mpt_destroy(this.h); this.h = 0; } }
  meta(key) {
    const M = this.M;
    const k = copyIn(M, new TextEncoder().encode(key + '\0'));
    const v = M.UTF8ToString(M._mpt_meta(this.h, k));
    M._free(k);
    return v;
  }
  orderPattern(o) { return this.orders[o]; }
  isSeparator(o) { const p = this.orders[o]; return p < 0 || p >= this.numPatterns || this.rows[p] === 0; }
  patternRows(p) { return p >= 0 && p < this.numPatterns ? this.rows[p] : 0; }
  timeAt(order, row) { return this.M._mpt_time_at(this.h, order, row); }

  cell(p, r, c) {
    let pat = this.cache.get(p);
    if (!pat) {
      pat = new Array(this.patternRows(p) * this.channels);
      this.cache.set(p, pat);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value); // keep memory bounded
    }
    const i = r * this.channels + c;
    let v = pat[i];
    if (!v) {
      const M = this.M, h = this.h;
      const t = (cmd) => M.UTF8ToString(M._mpt_cell(h, p, r, c, cmd));
      // libopenmpt commands: 0 note, 1 instrument, 2 volume effect, 3 effect, 4 volume, 5 parameter
      v = pat[i] = [t(0), t(1), (t(2) + t(4)).replace(/^ /, '.'), t(3) + t(5)];
    }
    return v;
  }
}
