import { useState } from "preact/hooks";
import type { Character } from "../character/types";
import Avatar from "./Avatar";
import { AVATARS } from "./catalog";
import { deleteAvatarModel, saveAvatarModelBytes, saveAvatarModelFile } from "./avatarFiles";
import { installPack, readPackFile } from "../voice/packs";

type Path = (string | number)[];

interface Props {
  character: Character;
  /** An unsaved character has no stable id yet, so files cannot be stored for it. */
  isNew: boolean;
  set: (path: Path, value: unknown) => void;
}

/** Pick how the character looks: a ready-made 3D avatar, your own VRM file, or the built-in cartoon face. */
export default function AvatarEditor({ character, isNew, set }: Props) {
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const hasModel = !!character.avatar?.model;
  const isVrm = character.avatar?.style === "vrm" && hasModel;

  async function run(what: string, job: () => Promise<void>) {
    setBusy(what);
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(null);
    }
  }

  const useModel = () => {
    set(["avatar", "model"], `${character.id}.vrm`);
    set(["avatar", "style"], "vrm");
    setVersion((v) => v + 1);
  };

  const pick = (avatarId: string) =>
    void run("Getting the avatar (one-time download)...", async () => {
      const entry = AVATARS.find((a) => a.id === avatarId);
      if (!entry) return;
      await installPack(entry.pack, (percent) => setBusy(`Downloading ${entry.name}: ${percent}%`));
      const bytes = new Uint8Array(await readPackFile(entry.pack.id, entry.pack.version, entry.pack.files[0].name));
      await saveAvatarModelBytes(character.id, bytes);
      useModel();
    });

  const onOwnFile = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void run("Saving the 3D character...", async () => {
      await saveAvatarModelFile(character.id, file);
      useModel();
    });
  };

  const useBuiltIn = () => {
    set(["avatar", "style"], "stylized");
    setVersion((v) => v + 1);
  };

  const removeModel = () =>
    void run("Removing...", async () => {
      if (!window.confirm("Remove this character's 3D avatar?")) return;
      await deleteAvatarModel(character.id);
      set(["avatar", "model"], "");
      set(["avatar", "style"], "stylized");
      setVersion((v) => v + 1);
    });

  const demoLevel = () => (testing ? 0.5 + 0.5 * Math.sin(performance.now() / 140) : 0);
  const ready = !isNew && !busy;

  return (
    <>
      {isNew && <p class="muted">Save the character first, then choose an avatar.</p>}
      <div class="avatar-edit">
        <div>
          <Avatar character={character} getLevel={demoLevel} width={150} height={240} mode="full" version={version} />
          <p class="muted">Preview</p>
          <button type="button" class="small" onClick={() => setTesting((t) => !t)} aria-pressed={testing}>
            {testing ? "Stop test" : "Test the mouth"}
          </button>
        </div>

        <div class="avatar-col">
          <h4>Choose an avatar</h4>
          <div class="gallery">
            <button type="button" class={!isVrm ? "pick on" : "pick"} onClick={useBuiltIn} disabled={isNew}>
              Built-in face
            </button>
            {AVATARS.map((a) => (
              <button key={a.id} type="button" class="pick" onClick={() => pick(a.id)} disabled={!ready}>
                {a.name}
              </button>
            ))}
          </div>
          <p class="muted">The avatars are free to use (CC0). Each downloads once when you pick it.</p>

          <h4>Your own 3D character</h4>
          <div class="row">
            <label class="button">
              Add a .vrm file
              <input type="file" accept=".vrm,.glb" hidden disabled={!ready} onChange={onOwnFile} />
            </label>
            {hasModel && (
              <button type="button" class="small" onClick={removeModel} disabled={!ready}>
                Remove the 3D avatar
              </button>
            )}
          </div>
          <p class="muted">Make one free with VRoid Studio, or from a selfie with MetaPerson or Avaturn. Check the model's licence first.</p>
        </div>
      </div>
      {busy && <p class="muted">{busy}</p>}
      {error && <p class="banner error">{error}</p>}
    </>
  );
}
