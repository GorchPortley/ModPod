# ModPod

A CDJ-style deck for tablets that plays **tracker modules** (MOD, XM, S3M, IT and ~20 more) *and* regular audio tracks.
One tablet = one deck. Put two (or more) tablets into a DJ mixer and mix.

It's a web app (PWA), so it runs on iPad and Android tablets alike. Install it to the home
screen and it works offline.

## What it does today (v0.3)

| | MOD | XM / S3M / IT / … | Audio (mp3/wav/flac/ogg/m4a…) |
|---|---|---|---|
| Engine | our own JS ProTracker engine | libopenmpt (C++ → WebAssembly) | browser decoder |
| Play / pause, CDJ-style **CUE**, 4 **hot cues** (saved per track) | ✅ | ✅ | ✅ |
| **Tempo fader** ±6 / 8 / 16 / 50 %, nudge, jog-wheel bend | ✅ | ✅ | ✅ |
| **Master tempo / key lock** (MT) | ✅ | ✅ | ✅ |
| Loop in/out, reloop, auto-loop ¼–32 beats, halve/double, **quantize** | ✅ | ✅ | ✅ (needs BPM) |
| BPM | read from the file | read from the file | tap tempo / ID3 |
| **Channel mutes / solo** (stems!) | ✅ | ✅ (up to 64 ch) | — |
| Display | pattern view | pattern view (+ volume column) | waveform + beat grid |

### Master tempo: why samples now stay in time

A tracker's **tempo** is how fast it steps through rows. Its **pitch** is how fast each sample plays.
If you only speed up the rows (that was v0.1's key lock), short drum hits are fine. But a long
sample that's meant to last exactly one bar, like a breakbeat, a vocal or a pad, keeps its old
length and drifts against the pattern.

So now the deck works like a real CDJ's master tempo:

1. The track always plays **vinyl-style**: rows *and* samples speed up together, so everything
   in the module stays in time with itself.
2. With **MT** on, a high-quality pitch shifter (Signalsmith Stretch) moves the key back to
   where it was.

Playback still starts instantly on PLAY, CUE or a hot cue: the shifter is pre-filled, so you never
hear its latency at the start. The same shifter gives **audio tracks key lock** too.

In ⚙ Settings you can choose:
- **MT on tracker files**: *Whole mix* (default, samples stay in time) or *Tracker-native*
  (the old way: zero artefacts, fine for chip-tunes made of short samples).
- **MT quality**: *Tight* (~70 ms latency) or *Smooth* (~140 ms, cleaner on sustained sounds).
  The latency only shows up as a slight delay on things like mutes and nudges.

### Rows per beat
Trackers don't store beats. Most tunes use 4 rows per beat, but fast XM/IT tunes often run at
speed 3 with 8 rows per beat. ModPod guesses (IT files even store it), and you can fix a BPM that
reads double or half in ⚙ Settings → *Rows per beat*. That's saved per track.

### DJ-friendly playback details
- Volume ramping + short fade-outs, so nothing clicks on a big system.
- Adjustable stereo separation (Amiga hard-panning sounds odd on a club rig; default is 50 %).
- Interpolation: Off (crunchy Amiga), Linear, Smoothest.
- Song length is computed up front, following jumps and pattern loops, so **remaining time** is accurate.
- At song end: stop (default) or loop forever.
- Songs with many channels: the pattern view shrinks to fit. If they still don't fit,
  **swipe sideways** on the pattern view to scroll through channels.

## Library

Tap **LIBRARY**, then **+ ADD FILES**. You can pick many files at once, including whole **.zip**
collections, which get unpacked. Files are copied into the tablet's browser storage, so they're
there next time and work offline.

- **Search** matches title, artist and file name. **Type a number** (e.g. `125`) to list every
  track you can reach from that BPM within ±8 % on the tempo fader.
- Filter by MOD / XM-S3M-IT / audio, and sort by title, BPM, length, format, or recently added/played.
- **Crates** let you prep sets. Use ⋯ on a track to add it to a crate; long-press a crate to rename or delete it.
- **Played this session** shows your set history. Played tracks are dimmed with a ✓.
- Titles, BPM and length come from the files themselves (MOD/XM/S3M/IT headers, mp3 ID3 tags).
  Audio length is filled in once you've loaded the track, and tapped BPMs are saved.
- Each tablet has its own library (browser storage is per device).

## Using it

1. Tap **LIBRARY**, add some files (or the demo MOD), and tap a track to load it.
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
js/tracker/trackerplayer.js XM/S3M/IT player: libopenmpt + row-accurate DJ loops/jumps
js/songview.js              one interface over song structure for the displays
js/tempo.js                 speed/tempo → BPM, rows-per-beat guess
js/wasm/                    the compiled C++ (modpod-dsp.js) + loader
native/modpod_dsp.cpp       the C++ glue: libopenmpt + Signalsmith Stretch, as plain C functions
native/build.sh             rebuilds js/wasm/modpod-dsp.js (needs the Emscripten SDK)
js/library/                 library: IndexedDB storage, format detection + metadata, zip import, browser UI
sw.js, manifest.webmanifest offline / installable app
tests/                      headless engine tests + the demo-MOD generator
```

The JS MOD engine is plain classes over typed arrays, which map closely onto C++.
The tracker engine and the pitch shifter already *are* C++. `native/modpod_dsp.cpp` is a short,
commented file that's a good place to start tinkering. To rebuild after changing it:

```sh
source /path/to/emsdk/emsdk_env.sh   # https://emscripten.org/docs/getting_started/downloads.html
native/build.sh                       # downloads libopenmpt + Signalsmith, writes js/wasm/modpod-dsp.js
```

Third-party licences: see [THIRD_PARTY.md](THIRD_PARTY.md).

Run the tests: `npm test`. To also write `tests/out/demo.wav` to listen to: `node tests/engine.test.js --wav`.

## Roadmap / ideas for next steps

- [x] **Library / crates** stored on the tablet (IndexedDB), with zip import.
- [x] **More formats**: XM / S3M / IT and more, via libopenmpt compiled to WebAssembly.
- [x] **Master tempo for everything**, with samples kept in time (Signalsmith Stretch).
- [ ] **Auto BPM detection** for audio tracks, plus beat-grid nudge.
- [ ] Per-channel oscilloscopes / VU in the MOD view; sample names; row-highlight per beat.
- [ ] Vinyl-mode scratching on the jog wheel; brake / spin-back effects.
- [ ] Per-channel FX on MODs (filter sweep on a single channel, echo on a single channel).
- [ ] MIDI controller support (Web MIDI — works in Chrome on Android, not on iPad).
- [ ] Headphone cue via a USB audio interface with 4 outputs (one tablet as two decks).
