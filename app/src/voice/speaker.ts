import { cleanForSpeech, takeSentences } from "./sentences";
import type { SpeakOptions, TtsEngine } from "./tts";

/**
 * Feeds a streaming reply to a voice one sentence at a time and can be cut off at any moment.
 * Each engine keeps its own queue, so a sentence starts being made while the one before it is still playing.
 */
export class StreamSpeaker {
  private pending = "";

  constructor(
    private engine: () => TtsEngine,
    private options: () => SpeakOptions,
    private enabled: () => boolean,
    private cancelAll: () => void,
  ) {}

  push(delta: string): void {
    if (!this.enabled()) return;
    this.pending += delta;
    const { done, rest } = takeSentences(this.pending);
    this.pending = rest;
    for (const sentence of done) this.say(sentence);
  }

  /** The reply is complete: speak whatever is left. */
  end(): void {
    const rest = this.pending.trim();
    this.pending = "";
    if (rest && this.enabled()) this.say(rest);
  }

  /** Stop talking now and forget everything queued. */
  cancel(): void {
    this.pending = "";
    this.cancelAll();
  }

  private say(raw: string): void {
    const text = cleanForSpeech(raw);
    if (!text) return;
    void this.engine()
      .speak(text, this.options())
      .catch(() => undefined);
  }
}
