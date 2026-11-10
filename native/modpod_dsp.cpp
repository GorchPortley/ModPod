// modpod_dsp.cpp — the C++ side of ModPod, compiled to WebAssembly.
//
// Two jobs:
//   1. Tracker engine: wraps libopenmpt (XM, S3M, IT, MTM, 669, …) with the
//      controls a DJ deck needs — tempo/pitch factors, channel mutes,
//      order/row seeking, VU meters and pattern text for the display.
//   2. Master tempo: wraps Signalsmith Stretch as a pitch shifter. The deck
//      plays a track "vinyl style" (tempo and pitch together, so everything in
//      it stays in time with itself) and this shifts the pitch back.
//
// Everything is exposed as plain C functions (extern "C") because that's the
// simplest thing to call from JavaScript. Each "object" is an opaque pointer.
//
// Build: native/build.sh  →  js/wasm/modpod-dsp.js

#include <libopenmpt/libopenmpt.hpp>
#include <libopenmpt/libopenmpt_ext.hpp>
#include "signalsmith-stretch.h"

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>
#include <memory>

#define API extern "C" EMSCRIPTEN_KEEPALIVE

static std::string g_error;   // last error message (for the UI)
static std::string g_string;  // storage for strings returned to JS

static const char *ret(const std::string &s) { g_string = s; return g_string.c_str(); }

// ============================================================ tracker engine

struct Tracker {
  std::unique_ptr<openmpt::module_ext> mod;
  openmpt::ext::interactive *ia = nullptr;
  std::ostringstream log;           // libopenmpt's load log goes here instead of stderr
  int sampleRate = 48000;
  std::vector<float> left, right;   // render buffers, read by JS
};

API Tracker *mpt_create(const uint8_t *data, int size, int sampleRate) {
  auto *t = new Tracker();
  try {
    t->mod.reset(new openmpt::module_ext(data, (std::size_t)size, t->log));
    t->ia = static_cast<openmpt::ext::interactive *>(t->mod->get_interface(openmpt::ext::interactive_id));
    t->sampleRate = sampleRate;
    t->mod->set_repeat_count(0);
    return t;
  } catch (const std::exception &e) {
    g_error = e.what();
  } catch (...) {
    g_error = "libopenmpt could not load this file";
  }
  delete t;
  return nullptr;
}

API const char *mpt_error() { return g_error.c_str(); }
API void mpt_destroy(Tracker *t) { delete t; }

/** Render `frames` stereo frames into the internal buffers. Returns frames rendered (0 = song ended). */
API int mpt_render(Tracker *t, int frames) {
  if ((int)t->left.size() < frames) { t->left.resize(frames); t->right.resize(frames); }
  return (int)t->mod->read(t->sampleRate, (std::size_t)frames, t->left.data(), t->right.data());
}
API float *mpt_left(Tracker *t) { return t->left.data(); }
API float *mpt_right(Tracker *t) { return t->right.data(); }

/** tempo: how fast the song runs; pitch: how fast samples play. 1 = normal. */
API void mpt_set_factors(Tracker *t, double tempo, double pitch) {
  if (!t->ia) return;
  t->ia->set_tempo_factor(tempo);
  t->ia->set_pitch_factor(pitch);
}

API void mpt_set_mute(Tracker *t, int channel, int muted) {
  if (t->ia) t->ia->set_channel_mute_status(channel, muted != 0);
}

/** interpolation: 1 none, 2 linear, 4 cubic, 8 sinc. stereoSep: 0..200 %. repeat: 0 stop at end, -1 forever. */
API void mpt_set_render(Tracker *t, int interpolation, int stereoSep, int repeat) {
  t->mod->set_render_param(openmpt::module::RENDER_INTERPOLATIONFILTER_LENGTH, interpolation);
  t->mod->set_render_param(openmpt::module::RENDER_STEREOSEPARATION_PERCENT, stereoSep);
  t->mod->set_repeat_count(repeat);
}

/** Jump to a position. Seeking by time makes libopenmpt rebuild tempo/volume state correctly. */
API void mpt_seek_seconds(Tracker *t, double seconds) { t->mod->set_position_seconds(seconds); }
/** Jump without recomputing state (used for seamless DJ loops). */
API void mpt_seek_order_row(Tracker *t, int order, int row) { t->mod->set_position_order_row(order, row); }
API double mpt_time_at(Tracker *t, int order, int row) {
  double s = t->mod->get_time_at_position(order, row);
  return s;
}

API double mpt_position_seconds(Tracker *t) { return t->mod->get_position_seconds(); }
API double mpt_duration(Tracker *t) { return t->mod->get_duration_seconds(); }
API int mpt_order(Tracker *t) { return t->mod->get_current_order(); }
API int mpt_row(Tracker *t) { return t->mod->get_current_row(); }
API int mpt_pattern(Tracker *t) { return t->mod->get_current_pattern(); }
API int mpt_speed(Tracker *t) { return t->mod->get_current_speed(); }
API double mpt_tempo(Tracker *t) { return t->mod->get_current_tempo2(); }
API int mpt_num_channels(Tracker *t) { return t->mod->get_num_channels(); }
API int mpt_num_orders(Tracker *t) { return t->mod->get_num_orders(); }
API int mpt_num_patterns(Tracker *t) { return t->mod->get_num_patterns(); }
API int mpt_order_pattern(Tracker *t, int order) { return t->mod->get_order_pattern(order); }
API int mpt_pattern_rows(Tracker *t, int pattern) { return t->mod->get_pattern_num_rows(pattern); }
API float mpt_channel_vu(Tracker *t, int ch) { return t->mod->get_current_channel_vu_mono(ch); }

API const char *mpt_meta(Tracker *t, const char *key) { return ret(t->mod->get_metadata(key)); }

/** One column of a pattern cell as text. cmd: 0 note, 1 instrument, 2 volume-effect, 3 effect, 4 volume, 5 parameter. */
API const char *mpt_cell(Tracker *t, int pattern, int row, int channel, int cmd) {
  return ret(t->mod->format_pattern_row_channel_command(pattern, row, channel, cmd));
}
/** Raw numeric value of a cell column (0 = empty note etc.). */
API int mpt_cell_value(Tracker *t, int pattern, int row, int channel, int cmd) {
  return t->mod->get_pattern_row_channel_command(pattern, row, channel, cmd);
}

// ============================================================ master tempo (pitch shifter)

struct Shifter {
  signalsmith::stretch::SignalsmithStretch<float> stretch;
  std::vector<std::vector<float>> in, out;
  std::vector<float *> inPtr, outPtr;
  int channels = 2;

  void ensure(int frames) {
    for (int c = 0; c < channels; c++) {
      if ((int)in[c].size() < frames) in[c].resize(frames);
      if ((int)out[c].size() < frames) out[c].resize(frames);
      inPtr[c] = in[c].data();
      outPtr[c] = out[c].data();
    }
  }
};

/** blockSec/intervalSec trade quality against latency (defaults in the JS side). */
API Shifter *st_create(int channels, double sampleRate, double blockSec, double intervalSec) {
  auto *s = new Shifter();
  s->channels = channels;
  s->in.resize(channels); s->out.resize(channels);
  s->inPtr.resize(channels); s->outPtr.resize(channels);
  // splitComputation spreads each FFT over several audio blocks — avoids CPU spikes on tablets.
  s->stretch.configure(channels, (int)(sampleRate * blockSec), (int)(sampleRate * intervalSec), true);
  s->ensure(4096);
  return s;
}
API void st_destroy(Shifter *s) { delete s; }

/** Pointers to the input/output buffers for channel c, valid for at least `frames` frames. */
API float *st_in(Shifter *s, int c, int frames) { s->ensure(frames); return s->in[c].data(); }
API float *st_out(Shifter *s, int c, int frames) { s->ensure(frames); return s->out[c].data(); }

API void st_set_transpose(Shifter *s, double factor) { s->stretch.setTransposeFactor((float)factor); }

/** Pitch-shift `frames` frames (same number in and out — no time stretching). */
API void st_process(Shifter *s, int frames) {
  s->ensure(frames);
  s->stretch.process(s->inPtr, frames, s->outPtr, frames);
}

API void st_reset(Shifter *s) { s->stretch.reset(); }

/** How many input frames st_output_seek wants, to start output with zero latency. */
API int st_seek_length(Shifter *s) { return s->stretch.outputSeekLength(1.0f); }

/** Prime the shifter with upcoming input so the next output starts exactly at that input. */
API void st_output_seek(Shifter *s, int frames) {
  s->ensure(frames);
  s->stretch.outputSeek(s->inPtr, frames);
}

API int st_latency(Shifter *s) { return s->stretch.inputLatency() + s->stretch.outputLatency(); }
