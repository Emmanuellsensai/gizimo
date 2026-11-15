import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Character } from "../character/types";
import { buildSystemPrompt } from "./prompt";
import { clearApiKey, keyStatus, setApiKey, stopChat, streamChat, type ChatMessage } from "./api";
import { StreamSpeaker } from "../voice/speaker";
import { EARS_MB, Listener, micErrorMessage, saveEarsSize, type EarsSize } from "../voice/stt";
import { cancelAllSpeech, engineFor, isKnownPack, kokoroEngine, kolaEngine, usesKokoro, usesKola } from "../voice/engines";
import { KOKORO_DOWNLOAD_MB, type EngineStatus } from "../voice/kokoro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Avatar from "../avatar/Avatar";
import { startAvatarBus } from "../avatar/bus";
import { chime } from "../wake/WakeEngine";
import { useWake } from "../wake/useWake";
import WakePanel from "../wake/WakePanel";
import { speechLevel } from "../voice/engines";

const SEND_LAST = 40; // how many recent messages go to the model

function loadMuted(): boolean {
  try {
    return localStorage.getItem("gizimo.muted") === "1";
  } catch {
    return false;
  }
}

type Mic = "idle" | "listening" | "thinking";

export default function ChatPane({ character }: { character: Character }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(loadMuted);
  const [mic, setMic] = useState<Mic>("idle");
  const [modelPercent, setModelPercent] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);
  const listener = useRef<Listener | null>(null);

  // The speaker reads the latest character and mute setting without being rebuilt.
  const live = useRef({ character, muted });
  live.current = { character, muted };
  const speaker = useMemo(
    () =>
      new StreamSpeaker(
        () => engineFor(live.current.character.voice.pack),
        () => ({
          speed: live.current.character.voice.speed ?? 1,
          lang: live.current.character.languages[0] ?? "en",
          gender: live.current.character.voice.gender,
          pack: live.current.character.voice.pack,
        }),
        () => !live.current.muted,
        cancelAllSpeech,
      ),
    [],
  );

  const [voiceStatus, setVoiceStatus] = useState<EngineStatus>({ state: "idle" });
  const [kolaEars, setKolaEars] = useState(false);
  const [ears, setEars] = useState<EarsSize>(() => {
    listener.current ??= new Listener();
    return listener.current.size;
  });

  const [floating, setFloating] = useState(false);
  const [hotkeyNote, setHotkeyNote] = useState<string | null>(null);

  // Learn whether the floating avatar is already showing, and whether Windows refused any hotkey.
  useEffect(() => {
    invoke<{ visible: boolean; hotkeys: { keys: string; ok: boolean }[] }>("overlay_status")
      .then((s) => {
        setFloating(s.visible);
        const bad = s.hotkeys.filter((h) => !h.ok).map((h) => h.keys);
        setHotkeyNote(bad.length ? `These hotkeys are used by another program: ${bad.join(", ")}. The buttons still work.` : null);
      })
      .catch(() => undefined);
  }, []);

  // Keep the floating avatar window told about who is talking and how open the mouth is.
  useEffect(() => startAvatarBus(() => live.current.character.id), []);

  async function toggleFloating() {
    try {
      setFloating(await invoke<boolean>("overlay_toggle"));
    } catch (e) {
      setError(String(e));
    }
  }

  // If the Kola ears are installed on this PC, offer them, and use them unless another choice was saved.
  useEffect(() => {
    invoke<{ installed: boolean }>("ears_status")
      .then((s) => {
        setKolaEars(s.installed);
        let saved: string | null = null;
        try {
          saved = localStorage.getItem("gizimo.ears");
        } catch {
          /* no saved choice */
        }
        if (s.installed && !saved && listener.current) {
          listener.current.size = "kola";
          setEars("kola");
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (listener.current) listener.current.lang = character.languages[0] ?? "en";
  }, [character.languages]);

  // Get the on-device voice ready as soon as the chat opens, so the first reply is not delayed.
  useEffect(() => {
    kokoroEngine.onStatus = setVoiceStatus;
    if (usesKokoro(character.voice.pack)) {
      if (kokoroEngine.ready) setVoiceStatus({ state: "ready" });
      else kokoroEngine.warm();
      if (usesKola(character.voice.pack)) void kolaEngine.warm();
    }
    return () => {
      kokoroEngine.onStatus = null;
    };
  }, [character.voice.pack]);

  useEffect(() => {
    keyStatus()
      .then(setHasKey)
      .catch((e) => {
        setHasKey(false);
        setKeyError(String(e));
      });
    return () => {
      speaker.cancel();
      listener.current?.cancel();
    };
  }, [speaker]);

  // A new conversation for each character.
  useEffect(() => {
    setMessages([]);
    setError(null);
    speaker.cancel();
    void stopChat().catch(() => undefined);
  }, [character.id, speaker]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    live.current.muted = next;
    if (next) speaker.cancel();
    try {
      localStorage.setItem("gizimo.muted", next ? "1" : "0");
    } catch {
      /* the choice just will not be remembered */
    }
  }

  async function saveKey() {
    setKeyError(null);
    try {
      await setApiKey(keyInput);
      setKeyInput(""); // the key is not kept in the page once it is saved
      setHasKey(true);
    } catch (e) {
      setKeyError(String(e));
    }
  }

  async function removeKey() {
    if (!window.confirm("Remove your saved Anthropic API key from this PC?")) return;
    try {
      await clearApiKey();
      setHasKey(false);
      setMessages([]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function send(spoken?: string) {
    const content = (spoken ?? input).trim();
    if (!content || busy) return;
    setError(null);
    if (spoken === undefined) setInput("");
    setBusy(true);
    speaker.cancel();

    const history: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages([...history, { role: "assistant", content: "" }]);

    let toSend = history.slice(-SEND_LAST);
    while (toSend.length > 1 && toSend[0].role !== "user") toSend = toSend.slice(1);

    setNotes([]);
    await streamChat(buildSystemPrompt(character), toSend, character.id, {
      onSkill: (note) => setNotes((n) => [...n, note]),
      onDelta: (text) => {
        speaker.push(text);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + text };
          return copy;
        });
      },
      onDone: () => speaker.end(),
      onError: (message) => {
        speaker.end();
        setError(message);
      },
    });

    // Drop an empty assistant bubble left by a failed or stopped request.
    setMessages((m) => (m.length && m[m.length - 1].role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
    setBusy(false);
  }

  function stopAll() {
    speaker.cancel();
    void stopChat();
  }

  async function toggleMic() {
    if (mic === "listening") return void finishListening();
    if (mic !== "idle" || busy) return;
    speaker.cancel(); // talking over the voice cuts it off
    setError(null);
    try {
      listener.current ??= new Listener();
      listener.current.onProgress = setModelPercent;
      await listener.current.start(() => void finishListening());
      setMic("listening");
    } catch (e) {
      setError(micErrorMessage(e));
    }
  }

  async function finishListening() {
    const l = listener.current;
    if (!l || finishing.current) return;
    finishing.current = true;
    setMic("thinking");
    try {
      const text = await l.stop();
      if (!text) {
        if (!byWake.current) setError("I did not catch that. Try again a little closer to the microphone.");
      } else await send(text);
    } catch (e) {
      setError(`Listening failed: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      finishing.current = false;
      byWake.current = false;
      setModelPercent(null);
      setMic("idle");
    }
  }

  /** The wake phrase was heard: chime, then take one spoken command that ends by itself when you stop talking. */
  async function startCommand() {
    if (busy || mic !== "idle") return;
    chime();
    speaker.cancel();
    setError(null);
    byWake.current = true;
    try {
      listener.current ??= new Listener();
      listener.current.onProgress = setModelPercent;
      await listener.current.start(() => void finishListening(), { autoStop: true });
      setMic("listening");
    } catch (e) {
      byWake.current = false;
      setError(micErrorMessage(e));
    }
  }

  const [notes, setNotes] = useState<{ name: string; ok: boolean; summary: string }[]>([]);
  const [skillsOn, setSkillsOn] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [reminder, setReminder] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ id: string; summary: string } | null>(null);

  function answer(approved: boolean) {
    if (!approval) return;
    const id = approval.id;
    setApproval(null);
    void invoke("skills_approve", { id, approved }).catch(() => undefined);
  }

  // The kill switch state, and reminders Gizi set for you.
  useEffect(() => {
    void invoke<{ enabled: boolean }>("skills_status")
      .then((s) => setSkillsOn(s.enabled))
      .catch(() => undefined);
    const stops = [
      listen<{ enabled: boolean }>("gizimo:skills", (e) => setSkillsOn(e.payload.enabled)),
      listen<{ id: string; summary: string }>("gizimo:approval", (e) => {
        setApproval(e.payload);
        chime();
      }),
      listen<{ id: string }>("gizimo:approval-done", (e) => setApproval((a) => (a && a.id === e.payload.id ? null : a))),
      listen<{ text: string }>("gizimo:reminder", (e) => {
        setReminder(e.payload.text);
        chime();
        speaker.push(`Reminder: ${e.payload.text}. `);
        speaker.end();
      }),
    ];
    return () => {
      for (const s of stops) void s.then((stop) => stop());
    };
  }, [speaker]);

  async function toggleSkills() {
    const next = !skillsOn;
    setSkillsOn(next);
    await invoke("skills_set_enabled", { on: next }).catch(() => setSkillsOn(!next));
  }

  async function openLog() {
    const open = !showLog;
    setShowLog(open);
    if (open) setLogLines(await invoke<string[]>("skills_log", { limit: 30 }).catch(() => []));
  }

  const byWake = useRef(false);
  const [showWake, setShowWake] = useState(false);
  const wake = useWake({
    characterId: character.id,
    onHeard: () => void startCommand(),
    shouldPause: () => busy || mic !== "idle" || speechLevel().speaking,
  });

  if (hasKey === null) return <p class="muted pad">Checking for your key...</p>;

  if (!hasKey) {
    return (
      <div class="pad keybox">
        <h2>Add your Anthropic API key</h2>
        <p>
          Gizimo talks to Claude Haiku 5.5 with your own key, so you pay Anthropic directly and nothing goes through
          anyone else. Create a key in the Anthropic console (console.anthropic.com), then paste it here.
        </p>
        <p class="muted">
          The key is saved in the Windows Credential Manager. It is never shown again, never written to a file and never
          sent anywhere except to Anthropic.
        </p>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <input
            class="grow"
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="sk-ant-..."
            value={keyInput}
            onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)}
          />
          <button class="primary" type="submit" disabled={!keyInput.trim()}>
            Save key
          </button>
        </form>
        {keyError && <p class="banner error">{keyError}</p>}
      </div>
    );
  }

  const pack = character.voice.pack;
  const packNote = !isKnownPack(pack) ? `Voice pack "${pack}" is not installed, so the Windows voice is used.` : null;
  const voiceNote =
    !usesKokoro(pack) || muted
      ? null
      : voiceStatus.state === "loading"
        ? voiceStatus.message === "testing speed"
          ? "Testing how fast the on-device voice runs on this PC. Until then replies use the Windows voice."
          : `Getting the voice ready (one-time download, about ${KOKORO_DOWNLOAD_MB} MB): ${voiceStatus.mb ?? 0} MB so far. Until then replies use the Windows voice.`
        : voiceStatus.state === "slow"
          ? `The on-device voice makes speech at ${(voiceStatus.rtf ?? 0).toFixed(2)} times real time on this PC (it needs 1.0 or more to talk smoothly), so the Windows voice is used.`
          : voiceStatus.state === "failed"
          ? `The on-device voice could not start (${voiceStatus.message ?? "unknown error"}). Using the Windows voice.`
          : null;

  return (
    <>
      <header class="bar">
        <div class="row title">
          <Avatar character={character} getLevel={() => speechLevel().level} width={56} mode="bust" />
          <h2>Chat with {character.name}</h2>
        </div>
        <div class="row">
          <button class="small" onClick={() => void toggleSkills()} aria-pressed={skillsOn} title="The kill switch. Ctrl+Alt+Shift+K does the same from anywhere.">
            Skills: {skillsOn ? "on" : "OFF"}
          </button>
          <button class="small" onClick={() => void openLog()} aria-pressed={showLog} title="Everything Gizi was asked to do, allowed or refused">
            Activity
          </button>
          <button class="small" onClick={() => setShowWake((s) => !s)} aria-pressed={showWake} title="Wake Gizi hands-free by saying its name">
            {wake.listening ? `● Listening for "${wake.setup.phrase}"` : "Wake word"}
          </button>
          <button class="small" onClick={() => void toggleFloating()} aria-pressed={floating} title="Ctrl+Alt+Shift+G shows or hides it, Ctrl+Alt+Shift+M moves it to the next screen, Ctrl+Alt+Shift+T lets clicks pass through">
            Floating avatar: {floating ? "on" : "off"}
          </button>
          <label class="inline small-label">
            Ears
            <select
              value={ears}
              onChange={(e) => {
                const size = (e.target as HTMLSelectElement).value as EarsSize;
                saveEarsSize(size);
                if (listener.current) listener.current.size = size;
                setEars(size);
              }}
            >
              {kolaEars && <option value="kola">Kola ears (this PC)</option>}
              <option value="tiny">Fast ({EARS_MB.tiny} MB)</option>
              <option value="base">Balanced ({EARS_MB.base} MB)</option>
              <option value="small">Accurate ({EARS_MB.small} MB)</option>
            </select>
          </label>
          <button class="small" onClick={toggleMuted} aria-pressed={muted}>
            Voice: {muted ? "off" : "on"}
          </button>
          <button class="small" onClick={removeKey}>
            Remove API key
          </button>
        </div>
      </header>

      {showWake && <WakePanel character={character} wake={wake} />}
      {showLog && (
        <div class="wake-panel">
          <strong>Activity log</strong>
          {logLines.length === 0 && <p class="muted">Nothing yet.</p>}
          {logLines.map((l, i) => {
            let row: { time?: string; tool?: string; outcome?: string } = {};
            try {
              row = JSON.parse(l);
            } catch {
              /* show the raw line */
            }
            return (
              <p key={i} class="muted">
                {row.time ? `${row.time}  ${row.tool}: ${row.outcome}` : l}
              </p>
            );
          })}
        </div>
      )}
      {approval && (
        <div class="banner approval" role="alertdialog" aria-live="assertive" aria-label="Gizi needs your approval">
          <strong>Gizi wants your OK</strong>
          <pre class="approval-text">{approval.summary}</pre>
          <button onClick={() => answer(true)}>Approve</button>{" "}
          <button class="small" onClick={() => answer(false)}>
            Deny
          </button>
        </div>
      )}
      {reminder && (
        <div class="banner ok">
          Reminder: {reminder}{" "}
          <button class="small" onClick={() => setReminder(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div class="messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p class="muted">
            Say hello to {character.name}, or press Talk and speak. Nothing is saved after you close the app yet.
          </p>
        )}
        {packNote && <p class="muted">{packNote}</p>}
        {hotkeyNote && <p class="muted">{hotkeyNote}</p>}
        {voiceNote && <p class="muted">{voiceNote}</p>}
        {messages.map((m, i) => (
          <div key={i} class={`bubble ${m.role}`}>
            <span class="who">{m.role === "user" ? "You" : character.name}</span>
            <span class="body">{m.content || (busy && i === messages.length - 1 ? "..." : "")}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {notes.map((n, i) => (
        <p key={i} class={n.ok ? "muted pad-x" : "banner error"}>
          {n.ok ? "Did" : "Refused"}: {n.name}. {n.summary}
        </p>
      ))}
      {error && <div class="banner error">{error}</div>}
      {mic === "listening" && <div class="banner ok">Listening... press Stop when you finish speaking.</div>}
      {mic === "thinking" && (
        <div class="banner">
          {modelPercent !== null
            ? `Downloading the listening model once: ${modelPercent} MB of about ${EARS_MB[ears]} MB...`
            : "Working out what you said..."}
        </div>
      )}

      <footer class="bar composer">
        <textarea
          class="grow"
          rows={2}
          placeholder={`Message ${character.name} (Enter to send, Shift+Enter for a new line)`}
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button class={mic === "listening" ? "danger" : ""} onClick={() => void toggleMic()} disabled={busy || mic === "thinking"}>
          {mic === "listening" ? "Stop" : "Talk"}
        </button>
        {busy ? (
          <button onClick={stopAll}>Stop reply</button>
        ) : (
          <button class="primary" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
    </>
  );
}
