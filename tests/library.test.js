// library.test.js — format detection, metadata probing, ID3 and zip import.
import { strict as assert } from 'node:assert';
import { deflateRawSync, crc32 } from 'node:zlib';
import { detect, probe, readId3 } from '../js/library/formats.js';
import { unzip } from '../js/library/zip.js';
import { buildDemoMod } from './makemod.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const bytes = (n) => new Uint8Array(n);
const put = (b, off, str) => { for (let i = 0; i < str.length; i++) b[off + i] = str.charCodeAt(i); };

function fakeXM() {
  const b = bytes(400);
  put(b, 0, 'Extended Module: '); put(b, 17, 'Acid Jungle');
  b[68] = 8; b[76] = 6; b[78] = 140; // 8 channels, speed 6, BPM 140
  return b.buffer;
}
function fakeS3M() {
  const b = bytes(200);
  put(b, 0, 'Second Reality'); put(b, 44, 'SCRM');
  b[49] = 3; b[50] = 125;          // speed 3 → 250 "BPM" at 4 rows/beat
  for (let i = 0; i < 32; i++) b[64 + i] = i < 10 ? i : 255;
  return b.buffer;
}
function fakeIT() {
  const b = bytes(300);
  put(b, 0, 'IMPM'); put(b, 4, 'Deep Space');
  b[0x32] = 6; b[0x33] = 128;
  for (let i = 0; i < 64; i++) b[0x40 + i] = i < 12 ? 32 : 160;
  return b.buffer;
}
function fakeMp3() {
  // ID3v2.3 with TIT2, TPE1, TBPM, then an MPEG frame sync.
  const frame = (id, text) => {
    const body = [0, ...Buffer.from(text, 'latin1')];
    const len = body.length;
    return [...Buffer.from(id), (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, 0, 0, ...body];
  };
  const frames = [...frame('TIT2', 'Pump Up'), ...frame('TPE1', 'DJ Amiga'), ...frame('TBPM', '128')];
  const size = frames.length;
  const hdr = [0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
  return new Uint8Array([...hdr, ...frames, 0xff, 0xfb, 0x90, 0x00, ...new Array(100).fill(0)]).buffer;
}

function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data, store] of files) {
    const raw = Buffer.from(new Uint8Array(data));
    const comp = store ? raw : deflateRawSync(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const all = Buffer.concat([...locals, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

console.log('Formats');
await test('detects formats by content, not extension', () => {
  assert.equal(detect(buildDemoMod(), 'whatever.zip').format, 'MOD');
  assert.equal(detect(fakeXM(), 'a.bin').format, 'XM');
  assert.equal(detect(fakeS3M(), 'a').format, 'S3M');
  assert.equal(detect(fakeIT(), 'a').format, 'IT');
  assert.equal(detect(fakeMp3(), 'a').format, 'MP3');
  assert.equal(detect(bytes(100).buffer, 'notes.txt'), null);
  assert.equal(detect(bytes(100).buffer, 'tune.669').kind, 'tracker');
});
await test('probes MOD metadata (title, channels, length, BPM)', () => {
  const m = probe(buildDemoMod(), 'music/demo.mod');
  assert.equal(m.title, 'ModPod demo'); assert.equal(m.channels, 4);
  assert.equal(m.bpm, 125); assert.ok(Math.abs(m.duration - 53.76) < 0.01);
  assert.equal(m.name, 'demo.mod'); assert.equal(m.key, 'demo.mod:' + buildDemoMod().byteLength);
});
await test('probes XM / S3M / IT headers', () => {
  const x = probe(fakeXM(), 'x.xm'); assert.equal(x.title, 'Acid Jungle'); assert.equal(x.channels, 8); assert.equal(x.bpm, 140);
  const s = probe(fakeS3M(), 's.s3m'); assert.equal(s.title, 'Second Reality'); assert.equal(s.channels, 10); assert.equal(s.bpm, 250);
  const i = probe(fakeIT(), 'i.it'); assert.equal(i.title, 'Deep Space'); assert.equal(i.channels, 12); assert.equal(i.bpm, 128);
});
await test('reads ID3 title / artist / BPM', () => {
  const t = readId3(new Uint8Array(fakeMp3()));
  assert.deepEqual(t, { title: 'Pump Up', artist: 'DJ Amiga', bpm: 128 });
  const m = probe(fakeMp3(), 'track01.mp3');
  assert.equal(m.title, 'Pump Up'); assert.equal(m.kind, 'audio');
});
await test('falls back to the file name for a title', () => {
  assert.equal(probe(bytes(100).buffer, 'mod.cool_tune.669').title, 'cool_tune');
});

console.log('Zip');
await test('extracts stored + deflated entries, skips folders and __MACOSX', async () => {
  const zip = makeZip([
    ['pack/one.mod', buildDemoMod(), false],
    ['pack/two.xm', fakeXM(), true],
    ['__MACOSX/pack/._one.mod', bytes(10).buffer, true],
  ]);
  const got = [];
  for await (const e of unzip(zip)) got.push(e);
  assert.deepEqual(got.map((e) => e.name), ['pack/one.mod', 'pack/two.xm']);
  assert.equal(got[0].data.byteLength, buildDemoMod().byteLength);
  assert.equal(detect(got[0].data, got[0].name).format, 'MOD');
  assert.equal(probe(got[1].data, got[1].name).title, 'Acid Jungle');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
