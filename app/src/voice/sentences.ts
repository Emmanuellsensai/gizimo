/**
 * Splits streamed text into whole sentences so speech can start before the reply is finished.
 * A sentence ends at . ! ? or an ellipsis (plus any closing quote or bracket) followed by a space, or at a new line.
 * Whatever is left over is kept until more text arrives.
 */
export function takeSentences(buffer: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let rest = buffer;
  const boundary = /^([\s\S]*?)(?:([.!?…]+["'”’)\]]*)\s+|\n+)/;
  for (;;) {
    const m = boundary.exec(rest);
    if (!m) break;
    const sentence = (m[1] + (m[2] ?? "")).trim();
    rest = rest.slice(m[0].length);
    if (sentence) done.push(sentence);
  }
  return { done, rest };
}

/** Removes things that sound wrong when read aloud: markdown marks, emoji, runs of spaces. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_`#>~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
