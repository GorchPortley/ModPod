// modfile.js — ProTracker-style MOD parser + song timeline scanner.
//
// No DOM dependencies: this module is imported both by the UI thread
// (to parse files and draw patterns) and by the AudioWorklet (for the
// period tables used by the playback engine).

export const PAL_CLOCK = 3546894.6; // Amiga Paula clock (PAL), Hz. freq = PAL_CLOCK / period

export const ROWS_PER_PATTERN = 64;

// Real ProTracker periods for finetune 0, octaves 1..3 (C-1 .. B-3).
const FT0 = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];

// We extend the table one octave down and one up (octaves 0..4) so that
// multichannel MODs which use extended octaves still map to notes.
// Note index 12 == C-1 (period 856) in ProTracker notation.
export const NUM_NOTES = 60;
export const NOTE_OFFSET = 12;

function buildPeriodTables() {
  const tables = [];
  for (let ft = 0; ft < 16; ft++) {
    const signed = ft < 8 ? ft : ft - 16;
    const row = new Float64Array(NUM_NOTES);
    for (let n = 0; n < NUM_NOTES; n++) {
      const std = n - NOTE_OFFSET; // index into the standard 3-octave range
      let p;
      if (signed === 0 && std >= 0 && std < 36) {
        p = FT0[std];
      } else {
        // Equal temperament from C-1 = 856, finetune = 1/8 semitone steps.
        p = Math.round(856 * Math.pow(2, -(std + signed / 8) / 12));
      }
      row[n] = p;
    }
    tables.push(row);
  }
  return tables;
}

export const PERIOD_TABLES = buildPeriodTables();

/** Nearest note index (0..NUM_NOTES-1) for a raw finetune-0 period, or -1. */
export function noteFromPeriod(period) {
  if (period <= 0) return -1;
  const t = PERIOD_TABLES[0];
  let best = -1, bestErr = Infinity;
  for (let n = 0; n < NUM_NOTES; n++) {
    const err = Math.abs(t[n] - period);
    if (err < bestErr) { bestErr = err; best = n; }
  }
  // Reject wildly off values (corrupt data).
  return bestErr <= t[best] * 0.03 + 1 ? best : -1;
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export function noteName(n) {
  if (n < 0) return '...';
  return NOTE_NAMES[n % 12] + Math.floor(n / 12);
}

function readString(b, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[off + i];
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.trimEnd();
}

/** Returns the channel count implied by the 4-byte tag at offset 1080, or 0. */
function channelsFromTag(tag) {
  switch (tag) {
    case 'M.K.': case 'M!K!': case 'M&K!': case 'N.T.': case 'FLT4': case '4CHN':
      return 4;
    case '6CHN': return 6;
    case '8CHN': case 'OCTA': case 'CD81': case 'FLT8': case 'OKTA':
      return 8;
  }
  // "xCHN" (FastTracker 2..9) and "xxCH" / "xxCN" (10..32)
  if (/^[1-9]CHN$/.test(tag)) return parseInt(tag[0], 10);
  if (/^[1-3][0-9]C[HN]$/.test(tag)) return parseInt(tag.slice(0, 2), 10);
  if (tag === 'TDZ1' || tag === 'TDZ2' || tag === 'TDZ3') return parseInt(tag[3], 10);
  return 0;
}

/** Quick check whether a buffer looks like a MOD (used to decide MOD vs. audio). */
export function looksLikeMod(arrayBuffer, filename = '') {
  const b = new Uint8Array(arrayBuffer);
  if (b.length >= 1084) {
    const tag = String.fromCharCode(b[1080], b[1081], b[1082], b[1083]);
    if (channelsFromTag(tag)) return true;
  }
  // 15-sample Soundtracker MODs have no tag; trust the extension + sanity checks.
  if (/\.(mod|stk|nst)$/i.test(filename) || /^mod\./i.test(filename)) {
    try { parseMod(arrayBuffer, filename); return true; } catch { return false; }
  }
  return false;
}

/**
 * Parse a MOD file.
 * Returns a plain object (structured-clone friendly) describing the song.
 *
 * Pattern cells are stored in flat typed arrays, indexed by
 *   ((pattern * 64) + row) * channels + channel
 */
export function parseMod(arrayBuffer, filename = '') {
  const b = new Uint8Array(arrayBuffer);
  if (b.length < 600) throw new Error('File too small to be a MOD');

  let numSamples = 31;
  let channels = 0;
  let tag = '';
  if (b.length >= 1084) {
    tag = String.fromCharCode(b[1080], b[1081], b[1082], b[1083]);
    channels = channelsFromTag(tag);
  }
  if (!channels) {
    // Ultimate Soundtracker / 15-sample format.
    numSamples = 15;
    channels = 4;
    tag = '';
  }

  const title = readString(b, 0, 20);
  const samples = [];
  let off = 20;
  for (let i = 0; i < numSamples; i++, off += 30) {
    const name = readString(b, off, 22);
    const length = ((b[off + 22] << 8) | b[off + 23]) * 2;
    const ftNibble = b[off + 24] & 0x0f;
    const volume = Math.min(b[off + 25], 64);
    let loopStart = ((b[off + 26] << 8) | b[off + 27]) * 2;
    let loopLength = ((b[off + 28] << 8) | b[off + 29]) * 2;
    if (numSamples === 15) loopStart >>= 1; // Soundtracker stored loop start in bytes
    samples.push({
      name, length, finetune: ftNibble, volume, loopStart, loopLength,
      data: null,
    });
  }

  const songLength = b[off];
  const restart = b[off + 1];
  off += 2;
  if (songLength < 1 || songLength > 128) throw new Error('Not a valid MOD (bad song length)');

  const orders = new Uint8Array(128);
  let maxPatAll = 0, maxPatUsed = 0;
  for (let i = 0; i < 128; i++) {
    orders[i] = b[off + i];
    if (orders[i] > maxPatAll) maxPatAll = orders[i];
    if (i < songLength && orders[i] > maxPatUsed) maxPatUsed = orders[i];
  }
  off += 128;
  if (numSamples === 31) off += 4; // skip tag

  if (numSamples === 15) {
    // Sanity checks so random files don't get accepted as MODs.
    for (const s of samples) {
      if (s.volume > 64 || s.length > 65535 * 2) throw new Error('Not a valid MOD');
    }
    if (maxPatUsed > 63) throw new Error('Not a valid MOD');
  }

  const patternBytes = 64 * channels * 4;
  let numPatterns = maxPatAll + 1;
  // Some files have junk in unused order slots — fall back to used orders if the
  // larger count would not fit in the file.
  const sampleBytes = samples.reduce((a, s) => a + s.length, 0);
  if (off + numPatterns * patternBytes + sampleBytes > b.length + 1024 && maxPatUsed < maxPatAll) {
    numPatterns = maxPatUsed + 1;
  }

  const cellCount = numPatterns * 64 * channels;
  const cells = {
    period: new Uint16Array(cellCount),
    note: new Int8Array(cellCount),
    sample: new Uint8Array(cellCount),
    effect: new Uint8Array(cellCount),
    param: new Uint8Array(cellCount),
  };
  for (let i = 0; i < cellCount; i++) {
    const p = off + i * 4;
    if (p + 3 >= b.length) { cells.note[i] = -1; continue; }
    const b0 = b[p], b1 = b[p + 1], b2 = b[p + 2], b3 = b[p + 3];
    const period = ((b0 & 0x0f) << 8) | b1;
    cells.period[i] = period;
    cells.note[i] = noteFromPeriod(period);
    cells.sample[i] = (b0 & 0xf0) | (b2 >> 4);
    cells.effect[i] = b2 & 0x0f;
    cells.param[i] = b3;
  }
  off += numPatterns * patternBytes;

  // Sample data: signed 8-bit → float.
  for (const s of samples) {
    const avail = Math.max(0, Math.min(s.length, b.length - off));
    const data = new Float32Array(avail);
    for (let i = 0; i < avail; i++) {
      const v = b[off + i];
      data[i] = (v < 128 ? v : v - 256) / 128;
    }
    off += s.length;
    s.length = avail;
    s.data = data;
    // Normalise loop info.
    if (s.loopLength > 2 && s.loopStart < s.length) {
      if (s.loopStart + s.loopLength > s.length) s.loopLength = s.length - s.loopStart;
      s.looped = s.loopLength > 2;
    } else {
      s.looped = false;
    }
    if (!s.looped) { s.loopStart = 0; s.loopLength = 0; }
  }

  return {
    format: 'mod',
    filename,
    title: title || filename.replace(/\.[^.]+$/, ''),
    tag: tag || 'ST15',
    channels,
    numSamples,
    samples,
    songLength,
    restart: restart < songLength ? restart : 0,
    orders,
    numPatterns,
    cells,
  };
}

/**
 * Walk the song the way the player would (without rendering audio) to find:
 *  - the time at which each (order,row) is first reached
 *  - speed/tempo in effect at the start of that row (needed for seeking)
 *  - total duration and where the song loops back to.
 */
export function buildTimeline(song) {
  const ch = song.channels;
  const { effect, param } = song.cells;
  const entries = new Map(); // key = order*64+row → { time, speed, tempo }
  const visited = new Set();
  const loopRow = new Int16Array(ch);
  const loopCount = new Int16Array(ch);
  const orderTime = new Float64Array(song.songLength).fill(-1);

  let order = 0, row = 0, speed = 6, tempo = 125, time = 0;
  let endKey = 0, loopTo = { order: song.restart, row: 0 };

  for (let guard = 0; guard < 200000; guard++) {
    const key = order * 64 + row;
    if (visited.has(key)) { loopTo = { order, row }; break; }
    visited.add(key);
    if (!entries.has(key)) entries.set(key, { time, speed, tempo });
    if (orderTime[order] < 0) orderTime[order] = time;
    endKey = key;

    const pat = Math.min(song.orders[order], song.numPatterns - 1);
    let jumpOrder = -1, breakRow = -1, patDelay = 0, loopJump = -1;
    for (let c = 0; c < ch; c++) {
      const i = (pat * 64 + row) * ch + c;
      const e = effect[i], p = param[i];
      if (e === 0x0f && p) { if (p < 32) speed = p; else tempo = p; }
      else if (e === 0x0b) { jumpOrder = p; if (breakRow < 0) breakRow = 0; }
      else if (e === 0x0d) { breakRow = Math.min((p >> 4) * 10 + (p & 15), 63); }
      else if (e === 0x0e) {
        const x = p >> 4, y = p & 15;
        if (x === 0x6) {
          if (y === 0) loopRow[c] = row;
          else if (loopCount[c] === 0) { loopCount[c] = y; loopJump = loopRow[c]; }
          else if (--loopCount[c] > 0) loopJump = loopRow[c];
        } else if (x === 0xe && !patDelay) patDelay = y;
      }
    }
    time += (speed * (1 + patDelay) * 2.5) / tempo;

    if (loopJump >= 0) {
      // Pattern loop: allow those rows to be visited again.
      for (let r = loopJump; r <= row; r++) visited.delete(order * 64 + r);
      row = loopJump;
      continue;
    }
    if (jumpOrder >= 0 || breakRow >= 0) {
      order = jumpOrder >= 0 ? jumpOrder : order + 1;
      row = breakRow >= 0 ? breakRow : 0;
      loopRow.fill(0);
    } else if (++row >= 64) {
      row = 0; order++;
      loopRow.fill(0);
    }
    if (order >= song.songLength) order = song.restart;
  }

  return { entries, duration: time, endKey, loopTo, orderTime };
}

/** Find the nearest known speed/tempo/time for a position (handles unreached orders). */
export function timelineAt(timeline, order, row) {
  for (let o = order; o >= 0; o--) {
    for (let r = o === order ? row : 63; r >= 0; r--) {
      const e = timeline.entries.get(o * 64 + r);
      if (e) return e;
    }
  }
  return { time: 0, speed: 6, tempo: 125 };
}
