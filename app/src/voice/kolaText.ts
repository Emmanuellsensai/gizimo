// Text to the numbers the Kola voice model reads. Pure functions, so Node can test them (no browser needed).
//
// The model is a character VITS voice: it was trained on lower-case letters with no phonemizer, with a blank between
// every two characters (Coqui's "add_blank"). vocab.json, written when the voice was exported, lists the characters
// in id order and says which id is the blank. Anything the model never saw is dropped rather than guessed.

export interface KolaVocab {
  /** Characters in id order. */
  vocab: string[];
  /** Id of the blank put between characters (and used as padding). */
  blankId: number;
  addBlank: boolean;
  /** Unicode form the training text was in. */
  textForm: "NFC" | "NFD";
  sampleRate: number;
  /** noise, length, duration noise */
  scales: [number, number, number];
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 to 999,999 in words. Larger or odd numbers are read digit by digit. */
export function spellNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n).split("").map((d) => ONES[Number(d)] ?? d).join(" ");
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " and " + spellNumber(n % 100) : "");
  const thousands = spellNumber(Math.floor(n / 1000)) + " thousand";
  const rest = n % 1000;
  return rest ? thousands + (rest < 100 ? " and " : " ") + spellNumber(rest) : thousands;
}

/** What the voice should say: digits and a few symbols become words, quotes are straightened. */
export function normalizeForVoice(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "")
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/&/g, " and ")
    .replace(/\d[\d,]*/g, (m) => " " + spellNumber(Number(m.replace(/,/g, ""))) + " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The id sequence for one sentence, ready for the model. Characters it never saw are left out. */
export function kolaIds(text: string, v: KolaVocab): number[] {
  const index = new Map<string, number>();
  v.vocab.forEach((ch, i) => index.set(ch, i));
  const clean = normalizeForVoice(text).toLowerCase().normalize(v.textForm);
  const ids: number[] = [];
  for (const ch of clean) {
    const id = index.get(ch);
    if (id !== undefined && id !== v.blankId) ids.push(id);
  }
  if (!v.addBlank) return ids;
  const out: number[] = [v.blankId];
  for (const id of ids) out.push(id, v.blankId);
  return out;
}
