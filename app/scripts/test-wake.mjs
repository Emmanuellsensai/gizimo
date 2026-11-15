// Tests the phrase-matching maths with made-up vectors (no microphone, no models).
import assert from "node:assert/strict";
import { cosine, mean, scoreAgainst, bestScore, trimByEnergy, suggestThreshold, subtract } from "../src/wake/match.ts";

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const vec = (n = 96) => Float32Array.from({ length: n }, rnd);
const noisy = (v, amount) => v.map((x) => x + rnd() * amount);
const phrase = (frames = 12) => Array.from({ length: frames }, () => vec());

assert.ok(Math.abs(cosine(vec(), vec())) < 0.5, "random vectors are not alike");
const a = vec();
assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
assert.equal(cosine(new Float32Array(96), a), 0);

const template = phrase();
const offset = mean(template);

// The same phrase, slightly different, scores high; another phrase scores low.
const again = template.map((f) => noisy(f, 0.25));
const other = phrase();
const bgBefore = phrase(10);
const stream = [...bgBefore, ...again];
const hit = bestScore(stream, [template], offset);
const miss = bestScore([...bgBefore, ...other], [template], offset);
assert.ok(hit > 0.7, `hit ${hit}`);
assert.ok(miss < 0.3, `miss ${miss}`);
assert.ok(hit - miss > 0.4, "clear gap between hit and miss");

// Said a little late or early still matches thanks to the shift.
const late = [...template.map((f) => noisy(f, 0.2)), vec(), vec()];
assert.ok(bestScore([...bgBefore, ...late], [template], offset) > 0.6, "tolerates a small shift");

// Not enough frames yet: no score.
assert.equal(scoreAgainst(phrase(3), template), -1);

// Energy trimming keeps the spoken part only.
const frames = phrase(10);
const energy = [0, 0.01, 0.4, 0.9, 1, 0.8, 0.5, 0.02, 0, 0];
const trimmed = trimByEnergy(frames, energy);
assert.equal(trimmed.length, 5);
assert.equal(trimmed[0], frames[2]);
assert.deepEqual(trimByEnergy(frames, new Array(10).fill(0)), []);

// A suggested threshold sits between "same phrase" and "something else".
const takes = [template, template.map((f) => noisy(f, 0.2)), template.map((f) => noisy(f, 0.2)), template.map((f) => noisy(f, 0.3))];
const off2 = mean(takes.flat());
const th = suggestThreshold(takes, off2);
assert.ok(th > 0.3 && th <= 0.9, `threshold ${th}`);
assert.equal(suggestThreshold([template], offset), 0.7);
assert.equal(subtract([vec()], offset)[0].length, 96);

console.log("wake tests passed");
