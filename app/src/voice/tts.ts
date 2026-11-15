import { wordMouth } from "../avatar/level.ts"; // with the extension so the Node tests can load this file too

export interface SpeakOptions {
  speed: number;
  lang: string; // character language id: en, pcm, yo, ig, ha
  gender?: "female" | "male";
  pack: string; // the character's voice pack: auto, os, kokoro or kokoro:<voice>
}

/** Anything that can turn text into speech. The small Kola voice pack becomes a second engine later. */
export interface TtsEngine {
  readonly id: string;
  speak(text: string, options: SpeakOptions): Promise<void>;
  cancel(): void;
  /** How open the mouth should be right now, 0 to 1 (for the avatar). */
  level(): number;
  /** True while a sentence is being spoken or is waiting to be. */
  speaking(): boolean;
}

const LANG_PREFERENCE: Record<string, string[]> = {
  en: ["en-NG", "en-GB", "en-US", "en"],
  pcm: ["en-NG", "en-GB", "en-US", "en"],
  yo: ["yo", "en-NG", "en"],
  ig: ["ig", "en-NG", "en"],
  ha: ["ha", "en-NG", "en"],
};

const FEMALE = /zira|hazel|susan|aria|jenny|libby|sonia|natasha|catherine|heera|eva|michelle|emily|ana|sara|ezinne|female/i;
const MALE = /david|mark|guy|ryan|james|george|richard|ravi|eric|christopher|brian|abeo|male/i;

export function guessGender(name: string): "female" | "male" | undefined {
  if (FEMALE.test(name) && !/^\s*male/i.test(name)) return "female";
  if (MALE.test(name)) return "male";
  return undefined;
}

export function pickVoice(
  voices: Pick<SpeechSynthesisVoice, "name" | "lang">[],
  lang: string,
  gender?: "female" | "male",
): (typeof voices)[number] | null {
  for (const prefix of LANG_PREFERENCE[lang] ?? ["en"]) {
    const p = prefix.toLowerCase();
    const pool = voices
      .filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(p))
      // Neural voices sound much better than the old built-in ones.
      .sort((a, b) => Number(/natural|online/i.test(b.name)) - Number(/natural|online/i.test(a.name)));
    if (pool.length === 0) continue;
    return (gender && pool.find((v) => guessGender(v.name) === gender)) || pool[0];
  }
  return voices[0] ?? null;
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500); // some systems never fire the event
  });
}

/** The voices that come with Windows. Works everywhere with no download. */
export class OsEngine implements TtsEngine {
  readonly id = "os";

  async speak(text: string, o: SpeakOptions): Promise<void> {
    if (typeof speechSynthesis === "undefined") return;
    const voice = pickVoice(await loadVoices(), o.lang, o.gender);
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice as SpeechSynthesisVoice;
        u.lang = voice.lang;
      }
      u.rate = Math.min(1.5, Math.max(0.6, o.speed));
      let started = false;
      u.onstart = () => {
        started = true;
        this.active++;
      };
      u.onboundary = () => {
        this.lastWord = performance.now();
      };
      const done = () => {
        if (started) {
          started = false;
          this.active = Math.max(0, this.active - 1);
        }
        resolve(); // a cancelled or failed sentence must not block the next one
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  cancel(): void {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.active = 0;
  }

  private active = 0;
  private lastWord = 0;

  speaking(): boolean {
    return this.active > 0;
  }

  level(): number {
    return this.active > 0 ? wordMouth(performance.now(), this.lastWord) : 0;
  }
}

export const osEngine = new OsEngine();
