import { useEffect, useRef, useState } from "preact/hooks";
import { WakeEngine } from "./WakeEngine";
import { loadWake, MIN_SAMPLES, saveWake, type WakeSetup } from "./store";

const engine = new WakeEngine(); // one microphone listener for the whole app

interface Options {
  characterId: string;
  /** Called when the wake phrase is heard. */
  onHeard: () => void;
  /** True while Gizi is talking or a command is being taken: the wake word then stays quiet. */
  shouldPause: () => boolean;
}

/** Everything the chat needs to run the "hey Gizi" wake phrase. */
export function useWake({ characterId, onHeard, shouldPause }: Options) {
  const [setup, setSetup] = useState<WakeSetup>(() => loadWake(characterId));
  const [listening, setListening] = useState(engine.running);
  const [status, setStatus] = useState("");
  const [score, setScore] = useState(-1);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef({ onHeard, shouldPause, setup });
  live.current = { onHeard, shouldPause, setup };

  useEffect(() => setSetup(loadWake(characterId)), [characterId]);

  useEffect(() => {
    engine.onWake = () => live.current.onHeard();
    engine.onScore = (s) => setScore(s);
    engine.onStatus = setStatus;
    const timer = window.setInterval(() => engine.setPaused(live.current.shouldPause()), 150);
    return () => {
      window.clearInterval(timer);
      engine.onWake = null;
      engine.onScore = null;
      engine.onStatus = null;
    };
  }, []);

  const ready = setup.templates.length >= MIN_SAMPLES;

  function update(next: WakeSetup) {
    setSetup(next);
    saveWake(characterId, next);
    if (engine.running) engine.configure(next);
  }

  async function start() {
    setError(null);
    try {
      await engine.start(ready ? setup : null);
      setListening(true);
    } catch (e) {
      setError(micMessage(e));
    }
  }

  function stop() {
    engine.stop();
    setListening(false);
    setScore(-1);
  }

  async function recordSample() {
    setError(null);
    try {
      if (!engine.running) await start();
      setRecording(true);
      const frames = await engine.record();
      setRecording(false);
      if (frames.length < 6) {
        setError("I did not hear the phrase. Say it clearly when you press Record, close to the microphone.");
        return;
      }
      const templates = [...setup.templates, frames.map((f) => Array.from(f))];
      const threshold = templates.length >= 2 ? WakeEngine.suggest(templates) : setup.threshold;
      update({ ...setup, templates, threshold });
    } catch (e) {
      setRecording(false);
      setError(micMessage(e));
    }
  }

  function clear() {
    update({ ...setup, templates: [], threshold: 0.7 });
  }

  /** A new phrase needs new recordings, so the old ones are dropped. */
  function setPhrase(phrase: string) {
    update({ templates: [], threshold: 0.7, phrase: phrase.trim().slice(0, 40) || setup.phrase });
  }

  return {
    setup,
    ready,
    listening,
    recording,
    status,
    score,
    error,
    start,
    stop,
    recordSample,
    clear,
    setPhrase,
    setThreshold: (threshold: number) => update({ ...setup, threshold }),
  };
}

function micMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow it in Windows Settings > Privacy & security > Microphone, then try again.";
  }
  if (name === "NotFoundError") return "No microphone was found.";
  return String(e instanceof Error ? e.message : e);
}
