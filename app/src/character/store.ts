import { invoke } from "@tauri-apps/api/core";
import validate from "./validate.generated.js";
import defaultCharacter from "./default.character.json";
import type { Character } from "./types";

interface Stored {
  id: string;
  json: string;
}

export interface Broken {
  id: string;
  errors: string[];
}

export interface Loaded {
  good: Character[];
  broken: Broken[];
}

export function describeErrors(): string[] {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(character)"} ${e.message ?? "is invalid"}`);
}

/** Returns a list of problems, empty when the value is a valid character. */
export function check(value: unknown): string[] {
  return validate(value) ? [] : describeErrors();
}

/** Cleans what the form produces so empty optional bits do not fail validation. */
export function normalize(c: Character): Character {
  const out: Character = JSON.parse(JSON.stringify(c));
  out.name = out.name.trim();
  const clean = (list?: string[]) => (list ?? []).map((s) => s.trim()).filter(Boolean);
  if (out.personality.boundaries) out.personality.boundaries = clean(out.personality.boundaries);
  if (out.voice.gender !== "female" && out.voice.gender !== "male") delete out.voice.gender;
  const q = out.proactive?.quietHours;
  if (out.proactive && q) {
    if (!q.from) delete q.from;
    if (!q.to) delete q.to;
    if (!q.from && !q.to) delete out.proactive.quietHours;
  }
  if (out.avatar) {
    if (!out.avatar.image) {
      delete out.avatar.image;
      delete out.avatar.mouth; // a mouth position means nothing without a photo
      delete out.avatar.eyes;
      delete out.avatar.cartoon; // the cartoon is made from the photo
    }
    if (!out.avatar.cartoon) delete out.avatar.cartoon;
    if (!out.avatar.model) delete out.avatar.model;
  }
  if (out.skills) {
    out.skills.allowApps = clean(out.skills.allowApps);
    out.skills.allowFolders = clean(out.skills.allowFolders);
    out.skills.allowUrlHosts = clean(out.skills.allowUrlHosts);
  }
  return out;
}

export async function loadAll(): Promise<Loaded> {
  let raw = await invoke<Stored[]>("list_characters");
  if (raw.length === 0) {
    // First run: give the user one working character to start from.
    const seed = defaultCharacter as Character;
    await invoke("save_character", { id: seed.id, json: JSON.stringify(seed, null, 2) });
    raw = await invoke<Stored[]>("list_characters");
  }
  const good: Character[] = [];
  const broken: Broken[] = [];
  for (const item of raw) {
    try {
      const value: unknown = JSON.parse(item.json);
      const problems = check(value);
      if (problems.length === 0 && (value as Character).id === item.id) good.push(value as Character);
      else broken.push({ id: item.id, errors: problems.length ? problems : ["id does not match the file name"] });
    } catch (e) {
      broken.push({ id: item.id, errors: [`Not valid JSON: ${String(e)}`] });
    }
  }
  return { good, broken };
}

export async function saveCharacter(c: Character): Promise<void> {
  await invoke("save_character", { id: c.id, json: JSON.stringify(c, null, 2) });
}

export async function deleteCharacter(id: string): Promise<void> {
  await invoke("delete_character", { id });
}
