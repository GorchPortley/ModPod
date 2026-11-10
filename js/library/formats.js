// formats.js — work out what a file is and pull out library metadata.
// Pure functions over ArrayBuffers (no DOM), so they're easy to test in Node.

import { looksLikeMod, parseMod, buildTimeline } from '../mod/modfile.js';
import { bpmFor, guessRowsPerBeat } from '../tempo.js';

const AUDIO_EXT = /\.(mp3|wav|wave|flac|ogg|oga|opus|m4a|mp4|aac|webm|aif|aiff|caf)$/i;
// Tracker formats other than MOD. Played by the libopenmpt engine (WebAssembly).
const TRACKER_EXT = /\.(xm|s3m|it|mptm|mtm|669|med|okt|far|ult|stm|amf|dbm|dmf|dsm|ams|mdl|psm|ptm|imf|j2b|gdm|umx|mo3)$/i;

function ascii(b, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) {
    const c = b[off + i];
    if (c === 0) break;
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
  }
  return s.trim();
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const tag = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

export function isZip(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
}

/** Engine-level kind: 'mod' (built-in JS engine), 'tracker' (libopenmpt), 'audio', or null. */
export function detect(buf, name = '') {
  const b = new Uint8Array(buf);
  if (b.length >= 60 && tag(b, 0, 17) === 'Extended Module: ') return { kind: 'tracker', format: 'XM' };
  if (b.length >= 48 && tag(b, 44, 4) === 'SCRM') return { kind: 'tracker', format: 'S3M' };
  if (b.length >= 64 && tag(b, 0, 4) === 'IMPM') return { kind: 'tracker', format: 'IT' };
  if (b.length >= 4 && tag(b, 0, 3) === 'MTM') return { kind: 'tracker', format: 'MTM' };
  if (looksLikeMod(buf, name)) return { kind: 'mod', format: 'MOD' };
  if (TRACKER_EXT.test(name)) return { kind: 'tracker', format: name.split('.').pop().toUpperCase() };
  // Audio: check magic numbers first, then the extension.
  if (b.length >= 12) {
    if (tag(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', format: 'MP3' };
    if (tag(b, 0, 4) === 'RIFF' && tag(b, 8, 4) === 'WAVE') return { kind: 'audio', format: 'WAV' };
    if (tag(b, 0, 4) === 'fLaC') return { kind: 'audio', format: 'FLAC' };
    if (tag(b, 0, 4) === 'OggS') return { kind: 'audio', format: 'OGG' };
    if (tag(b, 4, 4) === 'ftyp') return { kind: 'audio', format: 'M4A' };
    if (tag(b, 0, 4) === 'FORM') return { kind: 'audio', format: 'AIFF' };
  }
  if (AUDIO_EXT.test(name)) return { kind: 'audio', format: name.split('.').pop().toUpperCase() };
  return null;
}

/** BPM with the same rows-per-beat guess the deck uses, rounded to 0.1. */
function bpm(speed, tempo, hint = 0) {
  return Math.round(bpmFor(speed, tempo, guessRowsPerBeat(speed, tempo, hint)) * 10) / 10;
}

/** Library metadata for a file. Cheap: never decodes audio. */
export function probe(buf, name) {
  const d = detect(buf, name);
  if (!d) return null;
  const b = new Uint8Array(buf);
  const base = name.replace(/^.*[\\/]/, '');
  const meta = {
    name: base,
    key: base + ':' + buf.byteLength, // same key the deck uses to remember cue points
    size: buf.byteLength,
    kind: d.kind,
    format: d.format,
    title: '',
    artist: '',
    channels: 0,
    duration: 0,
    bpm: 0,
    added: Date.now(),
    plays: 0,
    lastPlayed: 0,
    crates: [],
  };

  try {
    if (d.format === 'MOD') {
      const song = parseMod(buf, base);
      const tl = buildTimeline(song);
      meta.title = song.title;
      meta.channels = song.channels;
      meta.duration = tl.duration;
      // Use the speed/tempo after row 0's effects (most MODs set tempo on row 0).
      const t = tl.entries.get(1) || tl.entries.get(0) || { speed: 6, tempo: 125 };
      meta.bpm = bpm(t.speed, t.tempo);
    } else if (d.format === 'XM') {
      meta.title = ascii(b, 17, 20);
      meta.channels = u16(b, 68);
      meta.bpm = bpm(u16(b, 76) || 6, u16(b, 78) || 125);
    } else if (d.format === 'S3M') {
      meta.title = ascii(b, 0, 28);
      let ch = 0;
      for (let i = 0; i < 32; i++) if (b[64 + i] < 16) ch++;
      meta.channels = ch;
      meta.bpm = bpm(b[49] || 6, b[50] || 125);
    } else if (d.format === 'IT') {
      meta.title = ascii(b, 4, 26);
      let ch = 0;
      for (let i = 0; i < 64; i++) if (b[0x40 + i] < 128) ch = i + 1; // highest enabled channel
      meta.channels = ch;
      meta.bpm = bpm(b[0x32] || 6, b[0x33] || 125, b[0x1e]); // 0x1E = rows-per-beat highlight
    } else if (d.format === 'MP3') {
      Object.assign(meta, readId3(b));
    }
  } catch { /* metadata is best-effort */ }

  if (!meta.title) meta.title = base.replace(/\.[^.]+$/, '').replace(/^mod\./i, '');
  return meta;
}

/** Minimal ID3v2 reader: title (TIT2), artist (TPE1), BPM (TBPM). */
export function readId3(b) {
  const out = {};
  if (b.length < 10 || tag(b, 0, 3) !== 'ID3') return out;
  const ver = b[3];
  const size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
  let p = 10;
  if (b[5] & 0x40) { // extended header
    const ext = ver === 4
      ? ((b[10] & 127) << 21) | ((b[11] & 127) << 14) | ((b[12] & 127) << 7) | (b[13] & 127)
      : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4;
    p += ext;
  }
  const end = Math.min(b.length, 10 + size);
  while (p + 10 <= end) {
    const id = tag(b, p, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4
      ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127)
      : (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
    const data = b.subarray(p + 10, p + 10 + len);
    if (id === 'TIT2') out.title = id3Text(data);
    else if (id === 'TPE1') out.artist = id3Text(data);
    else if (id === 'TBPM') { const v = parseFloat(id3Text(data)); if (v > 30 && v < 300) out.bpm = v; }
    p += 10 + len;
  }
  return out;
}

function id3Text(d) {
  if (!d.length) return '';
  const enc = d[0];
  const body = d.subarray(1);
  let s;
  if (enc === 1 || enc === 2) s = new TextDecoder(enc === 1 ? 'utf-16' : 'utf-16be').decode(body);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(body);
  else s = new TextDecoder('latin1').decode(body);
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}
