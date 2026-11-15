// How open the mouth should be, from a loudness reading or from word timing. All values run from 0 to 1.

/** Speech is quiet in raw samples, so scale a root-mean-square reading up to a useful mouth range. */
export function rmsToLevel(rms: number): number {
  return Math.min(1, Math.max(0, rms * 7));
}

/** Moves quickly to open and slowly to close, like a real jaw, so the mouth does not flicker. */
export function follow(previous: number, target: number, dtMs: number): number {
  const rate = target > previous ? 35 : 120; // milliseconds to cover most of the gap
  const k = 1 - Math.exp(-Math.max(0, dtMs) / rate);
  return previous + (target - previous) * k;
}

/**
 * The Windows voice gives no sound to measure, only a signal at each word. So the mouth pulses open at every word
 * and rocks gently in between, which reads as talking. `lastWord` is when the latest word signal arrived.
 */
export function wordMouth(now: number, lastWord: number): number {
  const since = now - lastWord;
  const pulse = since >= 0 && since < 160 ? 1 - since / 160 : 0;
  const rock = 0.5 + 0.5 * Math.sin(now / 65);
  return Math.min(1, 0.12 + 0.5 * pulse + 0.3 * rock);
}

/** Returns a function that says how closed the eyes are (0 open, 1 shut) at any moment, blinking now and then. */
export function makeBlinker(random: () => number = Math.random): (now: number) => number {
  let next = -1;
  const length = 150;
  return (now) => {
    if (next < 0) next = now + 1500 + random() * 3000;
    if (now >= next + length) next = now + 2000 + random() * 3500;
    if (now < next) return 0;
    const t = (now - next) / length;
    return t < 0.5 ? t * 2 : (1 - t) * 2; // down and back up
  };
}

/** A steady colour for a name, so each character keeps the same look. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
