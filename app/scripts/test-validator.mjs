// Checks the generated validator against the sample character and a set of bad characters.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import validate from "../src/character/validate.generated.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const good = read("src/character/default.character.json");
const sample = read("../samples/kola.character.json");

const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (c, label) => assert.equal(validate(c), true, `${label} should be valid: ${JSON.stringify(validate.errors)}`);
const bad = (c, label) => assert.equal(validate(c), false, `${label} should be invalid`);

ok(good, "default character");
ok(sample, "kola sample");

let c;
c = clone(good); c.id = "../evil"; bad(c, "path-like id");
c = clone(good); c.id = "A"; bad(c, "short uppercase id");
c = clone(good); c.roles = []; bad(c, "no roles");
c = clone(good); c.roles = ["wizard"]; bad(c, "unknown role");
c = clone(good); c.languages = ["fr"]; bad(c, "unknown language");
c = clone(good); c.extra = 1; bad(c, "unknown top-level field");
c = clone(good); c.voice.speed = 3; bad(c, "speed too high");
c = clone(good); c.name = ""; bad(c, "empty name");
c = clone(good); c.proactive = { checkIns: [{ time: "25:00", prompt: "x" }] }; bad(c, "bad check-in time");
c = clone(good); c.skills = { maxTier: 4 }; bad(c, "tier out of range");
c = clone(good); c.schemaVersion = 2; bad(c, "wrong schema version");
c = clone(good); delete c.voice; bad(c, "missing voice");
c = clone(good); c.avatar = { image: "gizi.png", consentConfirmed: true, mouth: { x: 0.5, y: 0.7, w: 0.2 } }; ok(c, "avatar with a mouth");
c = clone(good); c.avatar = { mouth: { x: 1.5, y: 0.7, w: 0.2 } }; bad(c, "mouth outside the photo");
c = clone(good); c.avatar = { mouth: { x: 0.5, y: 0.7, w: 0.9 } }; bad(c, "mouth far too wide");
c = clone(good); c.avatar = { mouth: { x: 0.5, y: 0.7 } }; bad(c, "mouth without a width");
c = clone(good); c.avatar = { style: "vrm", model: "gizi.vrm" }; ok(c, "3D character");
c = clone(good); c.avatar = { style: "cartoon", image: "gizi.png", cartoon: "gizi.cartoon.png", mouth: { x: 0.5, y: 0.7, w: 0.2 }, eyes: [{ x: 0.35, y: 0.4, w: 0.1 }, { x: 0.65, y: 0.4, w: 0.1 }] }; ok(c, "cartoon with eyes");
c = clone(good); c.avatar = { eyes: [{ x: 0.35, y: 0.4, w: 0.1 }] }; bad(c, "only one eye");
c = clone(good); c.avatar = { eyes: [{ x: 0.35, y: 0.4, w: 0.9 }, { x: 0.65, y: 0.4, w: 0.1 }] }; bad(c, "eye far too wide");
c = clone(good); c.avatar = { style: "hologram" }; bad(c, "unknown look");

console.log("validator tests passed");
