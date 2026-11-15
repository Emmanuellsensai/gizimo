import { useEffect, useState } from "preact/hooks";
import "./App.css";
import { blankCharacter, LANGS, ROLES, type Character, type Lang, type Role } from "./character/types";
import { check, deleteCharacter, loadAll, normalize, saveCharacter, type Broken } from "./character/store";
import ChatPane from "./chat/ChatPane";
import AvatarEditor from "./avatar/AvatarEditor";

type Path = (string | number)[];

/** Immutable update of a nested value, creating missing objects on the way. */
function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [key, ...rest] = path;
  const base = (Array.isArray(obj) ? [...obj] : { ...(obj as object) }) as Record<string | number, unknown>;
  base[key] = setIn(base[key], rest, value);
  return base as T;
}

const text = (e: Event) => (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item));
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

interface Message {
  kind: "ok" | "error";
  lines: string[];
}

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [broken, setBroken] = useState<Broken[]>([]);
  const [draft, setDraft] = useState<Character | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [raw, setRaw] = useState<string | null>(null); // non-null while the raw JSON tab is open
  const [message, setMessage] = useState<Message | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "edit">("chat");
  const [chatId, setChatId] = useState<string | null>(null);

  async function reload(selectId?: string) {
    try {
      const loaded = await loadAll();
      setCharacters(loaded.good);
      setBroken(loaded.broken);
      const pick = loaded.good.find((c) => c.id === selectId) ?? loaded.good[0] ?? null;
      setDraft(pick ? JSON.parse(JSON.stringify(pick)) : null);
      setIsNew(false);
      setDirty(false);
      setRaw(null);
    } catch (e) {
      setFatal(`Could not read your characters. Run this inside the Gizimo window, not a plain browser. (${String(e)})`);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function leaveOk(): boolean {
    return !dirty || window.confirm("You have unsaved changes. Discard them?");
  }

  function select(c: Character) {
    if (!leaveOk()) return;
    setDraft(JSON.parse(JSON.stringify(c)));
    setIsNew(false);
    setDirty(false);
    setRaw(null);
    setMessage(null);
  }

  function startNew() {
    if (!leaveOk()) return;
    setDraft(blankCharacter());
    setIsNew(true);
    setDirty(true);
    setRaw(null);
    setMessage(null);
  }

  function duplicate() {
    if (!draft || !leaveOk()) return;
    const copy: Character = JSON.parse(JSON.stringify(draft));
    copy.id = slug(`${draft.id}-copy`);
    copy.name = `${draft.name} copy`.slice(0, 40);
    setDraft(copy);
    setIsNew(true);
    setDirty(true);
    setRaw(null);
    setMessage(null);
  }

  function set(path: Path, value: unknown) {
    setDraft((d) => (d ? setIn(d, path, value) : d));
    setDirty(true);
    setMessage(null);
  }

  function setName(name: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, name };
      if (isNew) next.id = slug(name) || "new-character";
      return next;
    });
    setDirty(true);
    setMessage(null);
  }

  function openRaw() {
    if (draft) setRaw(JSON.stringify(draft, null, 2));
  }

  function closeRaw() {
    if (raw === null) return;
    try {
      const value = JSON.parse(raw) as Character;
      setDraft(value);
      setRaw(null);
      setMessage(null);
    } catch (e) {
      setMessage({ kind: "error", lines: [`Not valid JSON: ${String(e)}`] });
    }
  }

  async function save() {
    if (!draft) return;
    let candidate: Character;
    if (raw !== null) {
      try {
        candidate = JSON.parse(raw) as Character;
      } catch (e) {
        setMessage({ kind: "error", lines: [`Not valid JSON: ${String(e)}`] });
        return;
      }
    } else {
      candidate = draft;
    }
    const cleaned = normalize(candidate);
    const problems = check(cleaned);
    if (problems.length) {
      setMessage({ kind: "error", lines: problems });
      return;
    }
    if (isNew && characters.some((c) => c.id === cleaned.id)) {
      setMessage({ kind: "error", lines: [`A character with the id "${cleaned.id}" already exists. Change the name or id.`] });
      return;
    }
    try {
      await saveCharacter(cleaned);
      await reload(cleaned.id);
      setMessage({ kind: "ok", lines: [`Saved ${cleaned.name}.`] });
    } catch (e) {
      setMessage({ kind: "error", lines: [String(e)] });
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`Delete "${id}" for good? This cannot be undone.`)) return;
    try {
      await deleteCharacter(id);
      await reload();
      setMessage({ kind: "ok", lines: [`Deleted ${id}.`] });
    } catch (e) {
      setMessage({ kind: "error", lines: [String(e)] });
    }
  }

  function exportJson() {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(normalize(draft), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.id}.character.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importJson(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !leaveOk()) return;
    try {
      if (file.size > 256 * 1024) throw new Error("File is larger than 256 KB");
      const value = JSON.parse(await file.text()) as Character;
      const problems = check(value);
      if (problems.length) {
        setMessage({ kind: "error", lines: ["That file is not a valid Gizimo character:", ...problems] });
        return;
      }
      const taken = characters.some((c) => c.id === value.id);
      setDraft(taken ? { ...value, id: slug(`${value.id}-imported`) } : value);
      setIsNew(true);
      setDirty(true);
      setRaw(null);
      setMessage({ kind: "ok", lines: ["Imported. Review it, then press Save."] });
    } catch (err) {
      setMessage({ kind: "error", lines: [String(err)] });
    }
  }

  if (fatal) {
    return (
      <main class="shell">
        <p class="banner error">{fatal}</p>
      </main>
    );
  }

  const d = draft;
  const chatCharacter = characters.find((c) => c.id === chatId) ?? characters[0] ?? null;

  return (
    <main class="shell">
      <aside class="sidebar">
        <h1>Gizimo</h1>
        <div class="row">
          <button class={view === "chat" ? "tab on" : "tab"} onClick={() => setView("chat")}>
            Chat
          </button>
          <button class={view === "edit" ? "tab on" : "tab"} onClick={() => setView("edit")}>
            Characters
          </button>
        </div>
        <p class="muted">{view === "chat" ? "Talk to" : "Edit"}</p>
        <ul class="list">
          {characters.map((c) => (
            <li key={c.id}>
              <button
                class={`item ${(view === "chat" ? chatCharacter?.id === c.id : d?.id === c.id && !isNew) ? "active" : ""}`}
                onClick={() => (view === "chat" ? setChatId(c.id) : select(c))}
              >
                <strong>{c.name}</strong>
                <span class="muted">{c.roles.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
        {broken.length > 0 && (
          <div class="banner error">
            <strong>{broken.length} file(s) could not be read</strong>
            {broken.map((b) => (
              <details key={b.id}>
                <summary>{b.id}</summary>
                <ul>
                  {b.errors.map((er) => (
                    <li key={er}>{er}</li>
                  ))}
                </ul>
                <button class="danger small" onClick={() => remove(b.id)}>
                  Delete this file
                </button>
              </details>
            ))}
          </div>
        )}
        <div class="row">
          <button
            onClick={() => {
              setView("edit");
              startNew();
            }}
          >
            New
          </button>
          <label class="button">
            Import
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                setView("edit");
                void importJson(e);
              }}
              hidden
            />
          </label>
        </div>
      </aside>

      {view === "chat" && (
        <section class="editor">
          {chatCharacter ? <ChatPane character={chatCharacter} /> : <p class="muted pad">Make a character first.</p>}
        </section>
      )}

      <section class="editor" hidden={view !== "edit"}>
        {!d && <p class="muted">No character selected. Press New to make one.</p>}
        {d && (
          <>
            <header class="bar">
              <h2>{isNew ? "New character" : d.name}</h2>
              <div class="row">
                <button class={raw === null ? "tab on" : "tab"} onClick={closeRaw}>
                  Form
                </button>
                <button class={raw !== null ? "tab on" : "tab"} onClick={openRaw}>
                  Raw JSON
                </button>
              </div>
            </header>

            {message && (
              <div class={`banner ${message.kind}`}>
                {message.lines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            )}

            {raw !== null ? (
              <textarea
                class="raw"
                spellcheck={false}
                value={raw}
                onInput={(e) => {
                  setRaw(text(e));
                  setDirty(true);
                }}
              />
            ) : (
              <form onSubmit={(e) => e.preventDefault()}>
                <fieldset>
                  <legend>Who</legend>
                  <label>
                    Name
                    <input value={d.name} maxLength={40} onInput={(e) => setName(text(e))} />
                  </label>
                  <label>
                    Id {isNew ? "(set from the name, editable)" : "(fixed after saving)"}
                    <input value={d.id} disabled={!isNew} onInput={(e) => set(["id"], text(e))} />
                  </label>
                  <div class="group">
                    <span>Roles</span>
                    {ROLES.map((r) => (
                      <label class="inline" key={r}>
                        <input type="checkbox" checked={d.roles.includes(r)} onChange={(e) => set(["roles"], toggle<Role>(d.roles, r, checked(e)))} />
                        {r}
                      </label>
                    ))}
                  </div>
                  <div class="group">
                    <span>Languages</span>
                    {LANGS.map((l) => (
                      <label class="inline" key={l.id}>
                        <input
                          type="checkbox"
                          checked={d.languages.includes(l.id)}
                          onChange={(e) => set(["languages"], toggle<Lang>(d.languages, l.id, checked(e)))}
                        />
                        {l.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend>Personality</legend>
                  <label>
                    Summary
                    <textarea rows={4} maxLength={800} value={d.personality.summary} onInput={(e) => set(["personality", "summary"], text(e))} />
                  </label>
                  <label>
                    Speech style
                    <textarea rows={2} maxLength={400} value={d.personality.speechStyle} onInput={(e) => set(["personality", "speechStyle"], text(e))} />
                  </label>
                  <label>
                    Boundaries (one per line)
                    <textarea rows={4} value={(d.personality.boundaries ?? []).join("\n")} onInput={(e) => set(["personality", "boundaries"], text(e).split("\n"))} />
                  </label>
                </fieldset>

                <fieldset>
                  <legend>Voice</legend>
                  <label>
                    Voice pack
                    <input list="packs" value={d.voice.pack} onInput={(e) => set(["voice", "pack"], text(e))} />
                    <datalist id="packs">
                      <option value="auto">On-device voice, Windows voice while it loads (recommended)</option>
                      <option value="kokoro:bf_emma">British female</option>
                      <option value="kokoro:bf_isabella">British female, softer</option>
                      <option value="kokoro:bm_george">British male</option>
                      <option value="kokoro:bm_lewis">British male, deeper</option>
                      <option value="os">Windows voice only</option>
                    </datalist>
                  </label>
                  <label>
                    Gender
                    <select value={d.voice.gender ?? ""} onChange={(e) => set(["voice", "gender"], text(e))}>
                      <option value="">Not set</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </select>
                  </label>
                  <label>
                    Speed {(d.voice.speed ?? 1).toFixed(2)}
                    <input type="range" min="0.6" max="1.5" step="0.05" value={d.voice.speed ?? 1} onInput={(e) => set(["voice", "speed"], Number(text(e)))} />
                  </label>
                  <label class="inline">
                    <input type="checkbox" checked={d.voice.premium ?? false} onChange={(e) => set(["voice", "premium"], checked(e))} />
                    Use the paid Kola voice API (needs its own key; off by default)
                  </label>
                </fieldset>

                <fieldset>
                  <legend>Avatar</legend>
                  <AvatarEditor character={d} isNew={isNew} set={set} />
                </fieldset>

                <fieldset>
                  <legend>Check-ins</legend>
                  {(d.proactive?.checkIns ?? []).map((ci, i) => (
                    <div class="row check" key={i}>
                      <input type="time" value={ci.time} onInput={(e) => set(["proactive", "checkIns", i, "time"], text(e))} />
                      <input
                        class="grow"
                        placeholder="What should it ask or say?"
                        maxLength={300}
                        value={ci.prompt}
                        onInput={(e) => set(["proactive", "checkIns", i, "prompt"], text(e))}
                      />
                      <button class="small" onClick={() => set(["proactive", "checkIns"], (d.proactive?.checkIns ?? []).filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    class="small"
                    disabled={(d.proactive?.checkIns ?? []).length >= 12}
                    onClick={() => set(["proactive", "checkIns"], [...(d.proactive?.checkIns ?? []), { time: "09:00", prompt: "" }])}
                  >
                    Add check-in
                  </button>
                  <div class="row">
                    <label>
                      Quiet from
                      <input type="time" value={d.proactive?.quietHours?.from ?? ""} onInput={(e) => set(["proactive", "quietHours", "from"], text(e))} />
                    </label>
                    <label>
                      Quiet until
                      <input type="time" value={d.proactive?.quietHours?.to ?? ""} onInput={(e) => set(["proactive", "quietHours", "to"], text(e))} />
                    </label>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>What it may do on this PC</legend>
                  <label>
                    Highest action tier
                    <select value={String(d.skills?.maxTier ?? 1)} onChange={(e) => set(["skills", "maxTier"], Number(text(e)))}>
                      <option value="0">0: chat and voice only</option>
                      <option value="1">1: read-only (time, battery, allowed folders)</option>
                      <option value="2">2: reversible (open app or link, reminders)</option>
                      <option value="3">3: side effects (not available yet: needs a confirmation step first)</option>
                    </select>
                  </label>
                  <p class="muted">Skills themselves arrive in a later milestone. These limits are stored now so they are in place first.</p>
                  <label>
                    Allowed apps (one per line)
                    <textarea rows={3} value={(d.skills?.allowApps ?? []).join("\n")} onInput={(e) => set(["skills", "allowApps"], text(e).split("\n"))} />
                  </label>
                  <label>
                    Allowed folders (one per line)
                    <textarea rows={3} value={(d.skills?.allowFolders ?? []).join("\n")} onInput={(e) => set(["skills", "allowFolders"], text(e).split("\n"))} />
                  </label>
                  <label>
                    Allowed web hosts (one per line)
                    <textarea rows={3} value={(d.skills?.allowUrlHosts ?? []).join("\n")} onInput={(e) => set(["skills", "allowUrlHosts"], text(e).split("\n"))} />
                  </label>
                </fieldset>

                <fieldset>
                  <legend>Memory</legend>
                  <label class="inline">
                    <input type="checkbox" checked={d.memory?.enabled ?? true} onChange={(e) => set(["memory", "enabled"], checked(e))} />
                    Remember things between chats (stored only on this PC)
                  </label>
                  <label>
                    Most items to keep
                    <input type="number" min={50} max={5000} value={d.memory?.maxItems ?? 500} onInput={(e) => set(["memory", "maxItems"], Number(text(e)))} />
                  </label>
                </fieldset>
              </form>
            )}

            <footer class="bar">
              <div class="row">
                <button class="primary" disabled={!dirty} onClick={save}>
                  Save
                </button>
                <button onClick={duplicate} disabled={isNew}>
                  Duplicate
                </button>
                <button onClick={exportJson}>Export</button>
              </div>
              {!isNew && (
                <button class="danger" onClick={() => remove(d.id)}>
                  Delete
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
