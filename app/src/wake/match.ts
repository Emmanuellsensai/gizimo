// Matching a spoken phrase against recordings of it. Each moment of speech is turned into a list of 96 numbers (an
// "embedding"); a phrase is a short sequence of them. Pure functions, so they can be tested without a microphone.

export type Embedding = Float32Array;

export function mean(frames: Embedding[]): Float32Array {
  const out = new Float32Array(frames[0]?.length ?? 0);
  for (const f of frames) for (let i = 0; i < out.length; i++) out[i] += f[i] / frames.length;
  return out;
}

export function cosine(a: Embedding, b: Embedding): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export function subtract(frames: Embedding[], offset: Float32Array): Embedding[] {
  return frames.map((f) => f.map((v, i) => v - offset[i]));
}

/**
 * How well the most recent frames match a template, from -1 to 1. The template is slid back a few frames to allow for
 * saying the phrase a little faster or slower than when it was recorded.
 */
export function scoreAgainst(recent: Embedding[], template: Embedding[], maxShift = 3): number {
  const n = template.length;
  if (n === 0 || recent.length < n) return -1;
  let best = -1;
  for (let shift = 0; shift <= maxShift; shift++) {
    const start = recent.length - shift - n;
    if (start < 0) break;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += cosine(recent[start + i], template[i]);
    best = Math.max(best, sum / n);
  }
  return best;
}

/** The best score over several recordings of the phrase. Everything is compared after removing `offset` (the average). */
export function bestScore(recent: Embedding[], templates: Embedding[][], offset: Float32Array): number {
  const centred = subtract(recent, offset);
  let best = -1;
  for (const t of templates) best = Math.max(best, scoreAgainst(centred, subtract(t, offset)));
  return best;
}

/** Keeps only the frames where something was being said: from the first loud frame to the last. */
export function trimByEnergy(frames: Embedding[], energy: number[], keep = 0.35): Embedding[] {
  const peak = Math.max(0, ...energy);
  if (peak === 0) return [];
  const loud = energy.map((e) => e >= peak * keep);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  return frames.slice(first, last + 1);
}

/**
 * A starting threshold from the recordings themselves: how well each one matches the others, minus a safety margin.
 * With fewer than two recordings there is nothing to compare, so a fixed value is returned.
 */
export function suggestThreshold(templates: Embedding[][], offset: Float32Array): number {
  if (templates.length < 2) return 0.7;
  const scores: number[] = [];
  templates.forEach((t, i) => {
    const others = templates.filter((_, j) => j !== i);
    scores.push(bestScore(subtract(t, new Float32Array(offset.length)), others, offset));
  });
  const typical = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.max(0.55, Math.min(0.9, typical - 0.12));
}
