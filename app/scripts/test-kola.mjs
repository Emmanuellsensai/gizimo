// Tests how text becomes ids for the Kola voice (Node runs the TypeScript file directly).
import assert from "node:assert/strict";
import { kolaIds, normalizeForVoice, spellNumber } from "../src/voice/kolaText.ts";

assert.equal(spellNumber(0), "zero");
assert.equal(spellNumber(7), "seven");
assert.equal(spellNumber(21), "twenty one");
assert.equal(spellNumber(100), "one hundred");
assert.equal(spellNumber(342), "three hundred and forty two");
assert.equal(spellNumber(2026), "two thousand and twenty six");
assert.equal(spellNumber(15000), "fifteen thousand");
assert.equal(spellNumber(1000000), "one zero zero zero zero zero zero"); // too big: digit by digit

assert.equal(normalizeForVoice("Pay 50% of 1,200 & go"), "Pay fifty percent of one thousand two hundred and go");
assert.equal(normalizeForVoice("It’s “fine”"), "It's fine");

// A tiny vocabulary: id 0 is the blank, then a b space and the apostrophe.
const vocab = { vocab: ["_", "a", "b", " ", "'"], blankId: 0, addBlank: true, textForm: "NFC", sampleRate: 22050, scales: [0.5, 1, 0.3] };
assert.deepEqual(kolaIds("ab a", vocab), [0, 1, 0, 2, 0, 3, 0, 1, 0]);
assert.deepEqual(kolaIds("A!b", vocab), [0, 1, 0, 2, 0]); // upper-case folded, "!" never seen so dropped
assert.deepEqual(kolaIds("ab", { ...vocab, addBlank: false }), [1, 2]);
assert.deepEqual(kolaIds("", vocab), [0]);

console.log("kola voice text tests passed");
