// What the wake word remembers for each character: the recordings of the phrase and how sensitive it is.
// They stay in this app's own storage on this PC. The recordings are lists of numbers, not audio.
export interface WakeSetup {
  templates: number[][][];
  threshold: number;
  /** The words you say, for example "hey Gizimo". The recordings belong to this phrase. */
  phrase: string;
}

export const DEFAULT_PHRASE = "hey Gizimo";

const key = (id: string) => `gizimo.wake.${id}`;
export const MIN_SAMPLES = 3;

export function loadWake(id: string): WakeSetup {
  try {
    const raw = localStorage.getItem(key(id));
    if (raw) {
      const v = JSON.parse(raw) as WakeSetup;
      if (Array.isArray(v.templates) && typeof v.threshold === "number") return { ...v, phrase: v.phrase || DEFAULT_PHRASE };
    }
  } catch {
    /* start fresh */
  }
  return { templates: [], threshold: 0.7, phrase: DEFAULT_PHRASE };
}

export function saveWake(id: string, setup: WakeSetup): void {
  try {
    localStorage.setItem(key(id), JSON.stringify(setup));
  } catch {
    /* it just will not be remembered */
  }
}
