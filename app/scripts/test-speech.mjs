// Tests the sentence splitter and speech cleaner (Node runs the TypeScript files directly).
import assert from "node:assert/strict";
import { takeSentences, cleanForSpeech } from "../src/voice/sentences.ts";
import { pickVoice, guessGender } from "../src/voice/tts.ts";

let r = takeSentences("Hello there. How are you? I am");
assert.deepEqual(r.done, ["Hello there.", "How are you?"]);
assert.equal(r.rest, "I am");

r = takeSentences("Wait... what?! Really");
assert.deepEqual(r.done, ["Wait...", "what?!"]);
assert.equal(r.rest, "Really");

r = takeSentences('She said "go." Then left. ');
assert.deepEqual(r.done, ['She said "go."', "Then left."]);

r = takeSentences("No end yet");
assert.deepEqual(r.done, []);
assert.equal(r.rest, "No end yet");

// A full stop at the very end is not a boundary until a space or more text follows.
r = takeSentences("Cost is 3.");
assert.deepEqual(r.done, []);

r = takeSentences("First line\nSecond line");
assert.deepEqual(r.done, ["First line"]);
assert.equal(r.rest, "Second line");

// Streaming in small pieces gives the same sentences as one block.
const text = "Good morning, Ada. What is the one thing today? Let us start.";
let buf = "";
const got = [];
for (const ch of text) {
  buf += ch;
  const t = takeSentences(buf);
  got.push(...t.done);
  buf = t.rest;
}
if (buf.trim()) got.push(buf.trim());
assert.deepEqual(got, ["Good morning, Ada.", "What is the one thing today?", "Let us start."]);

assert.equal(cleanForSpeech("**Hi** _there_ `x` \u{1F600}  friend"), "Hi there x friend");
assert.equal(cleanForSpeech("- one\n- two"), "one two");

const voices = [
  { name: "Microsoft David - English (United States)", lang: "en-US" },
  { name: "Microsoft Zira - English (United States)", lang: "en-US" },
  { name: "Microsoft Ezinne Online (Natural) - English (Nigeria)", lang: "en-NG" },
  { name: "Microsoft Abeo Online (Natural) - English (Nigeria)", lang: "en-NG" },
];
assert.equal(pickVoice(voices, "en", "female").name.includes("Ezinne"), true);
assert.equal(pickVoice(voices, "pcm", "male").name.includes("Abeo"), true);
assert.equal(pickVoice(voices.slice(0, 2), "en", "male").name.includes("David"), true);
assert.equal(pickVoice(voices.slice(0, 2), "yo", "female").name.includes("Zira"), true); // falls back to English
assert.equal(pickVoice([], "en"), null);
assert.equal(guessGender("Microsoft Mark"), "male");

console.log("speech tests passed");
