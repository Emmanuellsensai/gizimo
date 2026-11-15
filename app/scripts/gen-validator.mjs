// Compiles src/character/character.schema.json into a plain JS validator (no eval at runtime), so the app can
// keep a strict Content Security Policy later. Runs before dev and build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "src/character/character.schema.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true, esm: true } });
const validate = ajv.compile(schema);
let code = standaloneCode(ajv, validate);

// Ajv's standalone output pulls one helper in with require(), which ES modules do not have. Inline it instead.
const needle = 'require("ajv/dist/runtime/ucs2length").default';
const helper =
  "function ucs2length(str){const len=str.length;let length=0,pos=0,value;while(pos<len){length++;" +
  "value=str.charCodeAt(pos++);if(value>=0xd800&&value<=0xdbff&&pos<len){value=str.charCodeAt(pos);" +
  "if((value&0xfc00)===0xdc00)pos++}}return length}";
code = code.replaceAll(needle, "ucs2length");
if (code.includes("require(")) throw new Error("Generated validator still contains require(): update gen-validator.mjs");
code = code.replace('"use strict";', `"use strict";${helper}`);

writeFileSync(join(root, "src/character/validate.generated.js"), code);
console.log("validator generated");
