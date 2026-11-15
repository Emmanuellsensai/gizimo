import { invoke } from "@tauri-apps/api/core";

// A character's 3D model is stored in the app data folder. The Rust side checks that it really is a VRM or GLB file.
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

export const readAvatarModel = (id: string) => invoke<ArrayBuffer>("read_avatar_file", { id, kindName: "model" });
export const deleteAvatarModel = (id: string) => invoke<void>("delete_avatar_file", { id, kindName: "model" });

export async function saveAvatarModelBytes(id: string, bytes: Uint8Array): Promise<void> {
  if (bytes.length > MAX_MODEL_BYTES) throw new Error("That 3D file is larger than 64 MB. Choose a lighter avatar.");
  if (bytes.length < 20 || String.fromCharCode(...bytes.slice(0, 4)) !== "glTF") {
    throw new Error("That is not a VRM or GLB 3D file.");
  }
  await invoke<void>("save_avatar_file", bytes, { headers: { id, kind: "model" } });
}

/** Saves a 3D character picked from the user's own disk. */
export async function saveAvatarModelFile(id: string, file: File): Promise<void> {
  await saveAvatarModelBytes(id, new Uint8Array(await file.arrayBuffer()));
}
