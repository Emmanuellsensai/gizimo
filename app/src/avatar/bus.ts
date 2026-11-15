import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { speechLevel } from "../voice/engines";
import { EV_CHARACTER, EV_HELLO, EV_LEVEL } from "./events";

/**
 * Runs in the main window: tells the floating avatar which character is active and how open the mouth is.
 * Messages are only sent while there is something to show, so an idle app sends almost nothing.
 */
export function startAvatarBus(getCharacterId: () => string | null): () => void {
  let stopped = false;
  let wasSpeaking = false;
  let lastId: string | null = null;
  const quietly = (p: Promise<unknown>) => p.catch(() => undefined);

  const sendCharacter = () => {
    const id = getCharacterId();
    if (id) void quietly(emit(EV_CHARACTER, { id }));
  };

  const timer = window.setInterval(() => {
    const { level, speaking } = speechLevel();
    if (speaking || wasSpeaking) void quietly(emit(EV_LEVEL, { level, speaking }));
    wasSpeaking = speaking;
    const id = getCharacterId();
    if (id !== lastId) {
      lastId = id;
      sendCharacter();
    }
  }, 40);

  let unlisten: UnlistenFn | null = null;
  void listen(EV_HELLO, sendCharacter)
    .then((u) => (stopped ? u() : (unlisten = u)))
    .catch(() => undefined);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    unlisten?.();
  };
}
