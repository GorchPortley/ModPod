# ModPod

A CDJ-style deck for tablets that plays **tracker MOD files** *and* regular audio tracks.
One tablet = one deck. Put two (or more) tablets into a DJ mixer and mix.

It's a web app (PWA), so it runs on iPad and Android tablets alike. Install it to the home
screen and it works offline.

## What it does today (v0.1)

| | MOD deck | Audio deck (mp3/wav/flac/ogg/m4a…) |
|---|---|---|
| Play / pause, CDJ-style **CUE** (pause → set & preview, playing → back to cue) | ✅ | ✅ |
| 4 **hot cues** (hold to clear), saved per track | ✅ | ✅ |
| **Tempo fader** ±6 / 8 / 16 / 50 %, nudge buttons, jog-wheel pitch bend | ✅ | ✅ |
| **Master tempo / key lock** | ✅ (free — see below) | ❌ later |
| Loop in/out, reloop, auto-loop ¼–32 beats, halve/double | ✅ | ✅ (needs BPM) |
| **Quantize** (jumps & loops snap to beats) | ✅ | ✅ (needs BPM) |
| BPM | read from the MOD | tap tempo (hold TAP to type it) |
| **Channel mutes / solo** (stems!) | ✅ | — |
| Display | scrolling pattern view | scrolling waveform + beat grid |
| Overview strip with needle search | orders (coloured by pattern) | waveform |

### Why MODs are great for DJing

A MOD's **tempo** is just how fast the player steps through rows. Its **pitch** is how fast
each sample is played back. The two are independent in the engine (`tempoMul` and `pitchMul`
in `js/mod/modplayer.js`). So key lock on a MOD costs nothing and sounds perfect,
with no time-stretch artefacts at all.

Each MOD channel is also effectively a stem: mute the drums, solo the bassline, and so on.

### DJ-friendly playback details
- Volume ramping + short fade-outs on retriggered notes, so it doesn't click on a big system.
- Adjustable stereo separation (Amiga hard-panning sounds odd on a club rig; default is 50 %).
- Interpolation: Off (crunchy Amiga), Linear, Cubic.
- `Fxx` tempo changes, `Bxx` jumps, pattern loops (`E6x`) and pattern delays are followed properly.
  The song length is computed up front, so **remaining time** is accurate.
- At song end: stop (default) or loop forever.

## Using it

1. Tap **LOAD** and pick a `.mod` or an audio file (or **Load demo MOD**).
2. **CUE / PLAY** work like a CDJ.
3. Tempo fader: drag it (it moves relative to your finger, for fine control). Double-tap to reset.
   It's CDJ-style by default (up = slower); you can flip that in ⚙ Settings.
4. **MT** = master tempo (key lock).
5. **Q** = quantize. With Q on, hot cues and the overview strip jump on the next beat.
   Loops also snap to beats.
6. Jog wheel: spin while playing to bend the pitch. Spin while paused to search (row by row on a MOD).
7. For audio tracks, **TAP** along to the beat 4+ times to set the BPM and grid. Hold TAP to type a BPM.
8. Tap the time display to switch between remaining and elapsed.

Keyboard (for testing on a computer): `Space` play, `C` cue, `1–4` hot cues, `L` loop, `←/→` nudge.

## Getting it onto your tablets

Browsers only allow the audio engine (AudioWorklet) on **HTTPS** pages, or on `localhost`.
A plain `http://192.168…` address from your PC won't work on a tablet. The easiest options:

- **GitHub Pages:** repo *Settings → Pages → Deploy from branch*. Pick the branch and the `/` folder.
  On a free account this needs the repo to be public.
- Or drag the folder onto any static host (Netlify Drop, Cloudflare Pages, …).

Then open the URL on each tablet and choose **Add to Home Screen**. It caches itself for offline use.

To develop locally: `npm run serve`, then open http://localhost:8080.

## Code tour

```
index.html, css/style.css   layout (landscape tablet first)
js/app.js                   UI wiring: buttons, fader, jog, per-frame display updates
js/deck.js                  Deck controller: loading, CDJ cue/hot-cue logic, per-track memory
js/views.js                 canvas drawing: pattern view, waveform, overview, jog
js/deck-processor.js        the AudioWorklet (real-time audio thread), owns one player
js/mod/modfile.js           MOD parser + timeline scan (song length, seeking info)
js/mod/modplayer.js         the MOD engine (ProTracker effects, mixing, DJ loops)
js/audio/bufferplayer.js    audio-track player (variable speed, loops, beat grid)
sw.js, manifest.webmanifest offline / installable app
tests/                      headless engine tests + the demo-MOD generator
```

The engine is written as plain classes over typed arrays. That maps closely onto C++,
if you ever want to port it or swap in a C++/WebAssembly core.

Run the tests: `npm test` (add `-- --wav` to also write `tests/out/demo.wav` to listen to).

## Roadmap / ideas for next steps

- [ ] **Library / crate**: keep tracks on the tablet (IndexedDB) instead of picking files every time.
- [ ] **More formats**: XM / S3M / IT. Either extend the engine, or compile *libopenmpt* (C++) to WebAssembly.
- [ ] **Key lock for audio tracks** (time-stretching, e.g. WSOLA or a phase vocoder).
- [ ] **Auto BPM detection** for audio tracks, plus beat-grid nudge.
- [ ] Per-channel oscilloscopes / VU in the MOD view; sample names; row-highlight per beat.
- [ ] Vinyl-mode scratching on the jog wheel; brake / spin-back effects.
- [ ] Per-channel FX on MODs (filter sweep on a single channel, echo on a single channel).
- [ ] MIDI controller support (Web MIDI — works in Chrome on Android, not on iPad).
- [ ] Headphone cue via a USB audio interface with 4 outputs (one tablet as two decks).
