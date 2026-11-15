import { AutoEngine, KokoroEngine } from "./kokoro";
import { KolaVoiceEngine } from "./kolaVoice";
import { osEngine, type TtsEngine } from "./tts";

export const kokoroEngine = new KokoroEngine();
const autoEngine = new AutoEngine(kokoroEngine, osEngine);
/** The owner's own voice, once its files are installed. Until then (or if this PC is too slow) the auto voice speaks. */
export const kolaEngine = new KolaVoiceEngine(autoEngine);

/** True for the character voice pack "kola": the owner's own voice. */
export function usesKola(pack: string): boolean {
  return pack === "kola";
}

/** True when this pack id is one of the on-device Kokoro voices (the "auto" choice, and the "kola" fallback, included). */
export function usesKokoro(pack: string): boolean {
  return pack === "auto" || pack === "kokoro" || pack.startsWith("kokoro:") || usesKola(pack);
}

/** Packs we do not have installed fall back to the Windows voice. */
export function isKnownPack(pack: string): boolean {
  return pack === "os" || usesKokoro(pack);
}

export function engineFor(pack: string): TtsEngine {
  if (usesKola(pack)) return kolaEngine;
  return usesKokoro(pack) ? autoEngine : osEngine;
}

export function cancelAllSpeech(): void {
  kolaEngine.cancel(); // also stops the voice it falls back to
}

/** What the avatar's mouth should do right now, whichever voice is talking. */
export function speechLevel(): { level: number; speaking: boolean } {
  return {
    level: Math.max(kolaEngine.level(), autoEngine.level()),
    speaking: kolaEngine.speaking() || autoEngine.speaking(),
  };
}
