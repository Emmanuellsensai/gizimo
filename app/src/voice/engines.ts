import { AutoEngine, KokoroEngine } from "./kokoro";
import { osEngine, type TtsEngine } from "./tts";

export const kokoroEngine = new KokoroEngine();
const autoEngine = new AutoEngine(kokoroEngine, osEngine);

/** True when this pack id is one of the on-device Kokoro voices (the "auto" choice included). */
export function usesKokoro(pack: string): boolean {
  return pack === "auto" || pack === "kokoro" || pack.startsWith("kokoro:");
}

/** Packs we do not have installed fall back to the Windows voice. */
export function isKnownPack(pack: string): boolean {
  return pack === "os" || usesKokoro(pack);
}

export function engineFor(pack: string): TtsEngine {
  return usesKokoro(pack) ? autoEngine : osEngine;
}

export function cancelAllSpeech(): void {
  autoEngine.cancel();
}

/** What the avatar's mouth should do right now, whichever voice is talking. */
export function speechLevel(): { level: number; speaking: boolean } {
  return { level: autoEngine.level(), speaking: autoEngine.speaking() };
}
