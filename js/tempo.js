// tempo.js — turning tracker speed/tempo into DJ BPM.
//
// Trackers don't store "beats". A row lasts  speed × 2.5 / tempo  seconds, and
// how many rows make a beat is a composer's choice (4 is most common, but fast
// XM/IT tunes often use speed 3 with 8 rows per beat). We guess the rows per
// beat that lands the BPM in a danceable range; you can override it per track.

export function bpmFor(speed, tempo, rowsPerBeat) {
  return (tempo * 24) / (speed * rowsPerBeat);
}

export function guessRowsPerBeat(speed, tempo, hint = 0) {
  if (hint >= 1 && hint <= 32) {
    const b = bpmFor(speed, tempo, hint);
    if (b >= 60 && b <= 200) return hint;      // trust the file (IT stores a row highlight)
  }
  let best = 4, bestScore = Infinity;
  for (const rpb of [2, 3, 4, 6, 8, 12, 16]) {
    const b = bpmFor(speed, tempo, rpb);
    // Out-of-range distance, plus a small preference for 4, then other powers of two;
    // 3/6/12 (triplet feels) only win when nothing else fits.
    const pref = rpb === 4 ? 0 : (rpb & (rpb - 1)) === 0 ? Math.abs(Math.log2(rpb) - 2) * 0.01 : 5;
    const score = (b < 80 ? 80 - b : b > 180 ? b - 180 : 0) + pref;
    if (score < bestScore) { bestScore = score; best = rpb; }
  }
  return best;
}
