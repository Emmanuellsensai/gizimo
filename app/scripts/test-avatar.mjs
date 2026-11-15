// Tests the avatar maths (mouth level, blinking). Node runs the TypeScript files directly.
import assert from "node:assert/strict";
import { rmsToLevel, follow, wordMouth, makeBlinker, hueFor } from "../src/avatar/level.ts";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

// Levels.
assert.equal(rmsToLevel(0), 0);
assert.equal(rmsToLevel(1), 1);
assert.ok(rmsToLevel(0.05) > 0.2 && rmsToLevel(0.05) < 0.5);
let v = 0;
for (let i = 0; i < 10; i++) v = follow(v, 1, 16);
assert.ok(v > 0.5 && v <= 1, "opens quickly");
let w = 1;
let o3 = 0;
for (let i = 0; i < 3; i++) {
  w = follow(w, 0, 16);
  o3 = follow(o3, 1, 16);
}
assert.ok(w > 0.6, "closes slowly");
assert.ok(1 - w < o3, "closes more slowly than it opens");
assert.ok(wordMouth(1000, 1000) > wordMouth(1000, 100), "a fresh word opens the mouth wider");
for (let t = 0; t < 2000; t += 7) {
  const m = wordMouth(t, 500);
  assert.ok(m >= 0 && m <= 1);
}

// Blinking: eyes mostly open, shut briefly, and the value stays in range.
const blink = makeBlinker(() => 0.5);
let shut = 0;
let samples = 0;
for (let t = 0; t < 30000; t += 16) {
  const b = blink(t);
  assert.ok(b >= 0 && b <= 1);
  samples++;
  if (b > 0.5) shut++;
}
assert.ok(shut > 0, "it blinks");
assert.ok(shut / samples < 0.1, "but is open most of the time");

assert.equal(hueFor("Gizi"), hueFor("Gizi"));
assert.notEqual(hueFor("Gizi"), hueFor("Ada"));

console.log("avatar tests passed");
