import { Channel, invoke } from "@tauri-apps/api/core";

/** What the app knows about a voice pack before downloading it. The hash is how a download is trusted. */
export interface PackFile {
  name: string;
  url: string; // https on huggingface.co only (enforced in Rust)
  sha256: string; // 64 lowercase hex characters
  size: number;
}

export interface PackManifest {
  id: string;
  version: string;
  lang: string;
  gender?: "female" | "male";
  license: string;
  credit: string;
  files: PackFile[];
}

export interface InstalledPack {
  id: string;
  version: string;
  files: { name: string; size: number }[];
}

export interface Progress {
  downloaded: number;
  total: number | null;
}

export const listPacks = () => invoke<InstalledPack[]>("list_packs");
export const deletePack = (id: string) => invoke<void>("delete_pack", { id });

export async function isInstalled(manifest: PackManifest): Promise<boolean> {
  const installed = (await listPacks()).find((p) => p.id === manifest.id && p.version === manifest.version);
  return !!installed && manifest.files.every((f) => installed.files.some((i) => i.name === f.name));
}

/** Downloads every file of a pack (skipping ones already there and intact). */
export async function installPack(manifest: PackManifest, onProgress?: (percent: number) => void): Promise<void> {
  const totalBytes = manifest.files.reduce((sum, f) => sum + f.size, 0) || 1;
  let finished = 0;
  for (const file of manifest.files) {
    const channel = new Channel<Progress>();
    channel.onmessage = (p) => onProgress?.(Math.min(99, Math.round(((finished + p.downloaded) / totalBytes) * 100)));
    await invoke("download_pack_file", {
      id: manifest.id,
      version: manifest.version,
      name: file.name,
      url: file.url,
      sha256: file.sha256,
      onProgress: channel,
    });
    finished += file.size;
  }
  onProgress?.(100);
}

export async function readPackFile(id: string, version: string, name: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_pack_file", { id, version, name });
}
