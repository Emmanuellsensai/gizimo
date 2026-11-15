import type { Character } from "../character/types";
import { MIN_SAMPLES } from "./store";
import type { useWake } from "./useWake";

type Wake = ReturnType<typeof useWake>;

/** Set up and switch on the hands-free "hey <name>" wake phrase. */
export default function WakePanel({ character, wake }: { character: Character; wake: Wake }) {
  const phrase = wake.setup.phrase;
  const count = wake.setup.templates.length;
  const meter = wake.score < 0 ? 0 : Math.max(0, Math.min(1, wake.score));

  return (
    <div class="wake-panel">
      <p>
        <strong>Say "{phrase}" to wake {character.name}.</strong> It listens on this PC only. Nothing is recorded or sent
        anywhere, and it stays quiet while {character.name} is talking.
      </p>
      <label>
        Wake phrase (a longer, unusual name is recognised better than a short common one)
        <input value={phrase} maxLength={40} disabled={wake.recording || wake.listening} onChange={(e) => wake.setPhrase((e.target as HTMLInputElement).value)} />
      </label>
      <div class="row">
        <button type="button" onClick={() => void wake.recordSample()} disabled={wake.recording}>
          {wake.recording ? `Say "${phrase}" now...` : `Record "${phrase}" (${count} of ${MIN_SAMPLES}+)`}
        </button>
        {count > 0 && (
          <button type="button" class="small" onClick={wake.clear} disabled={wake.recording}>
            Clear recordings
          </button>
        )}
        {wake.ready &&
          (wake.listening ? (
            <button type="button" class="danger" onClick={wake.stop}>
              Stop listening
            </button>
          ) : (
            <button type="button" class="primary" onClick={() => void wake.start()}>
              Start listening
            </button>
          ))}
      </div>
      {!wake.ready && <p class="muted">Record it at least {MIN_SAMPLES} times, in your normal voice, a bit differently each time.</p>}
      {wake.ready && (
        <label>
          Sensitivity: {wake.setup.threshold.toFixed(2)} (lower wakes more easily, higher needs a clearer match)
          <input type="range" min="0.3" max="0.95" step="0.01" value={wake.setup.threshold} onInput={(e) => wake.setThreshold(Number((e.target as HTMLInputElement).value))} />
        </label>
      )}
      {wake.listening && (
        <div class="meter" title="How closely the last moment of sound matches the phrase">
          <div class="meter-fill" style={{ width: `${Math.round(meter * 100)}%` }} />
          <div class="meter-mark" style={{ left: `${Math.round(wake.setup.threshold * 100)}%` }} />
        </div>
      )}
      {wake.status && <p class="muted">{wake.status}</p>}
      {wake.error && <p class="banner error">{wake.error}</p>}
    </div>
  );
}
