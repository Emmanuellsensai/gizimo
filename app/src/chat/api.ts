import { Channel, invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type StreamEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "skill"; data: { name: string; ok: boolean; summary: string } }
  | { event: "done" }
  | { event: "error"; data: { message: string } };

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onSkill?: (note: { name: string; ok: boolean; summary: string }) => void;
  onError: (message: string) => void;
}

// The key can be saved or removed from here, but there is deliberately no way to read it back.
export const keyStatus = () => invoke<boolean>("key_status");
export const setApiKey = (key: string) => invoke<void>("set_api_key", { key });
export const clearApiKey = () => invoke<void>("clear_api_key");
export const stopChat = () => invoke<void>("stop_chat");

/** Streams a reply. Resolves when the stream has ended, one way or another. */
export async function streamChat(system: string, messages: ChatMessage[], characterId: string, handlers: StreamHandlers): Promise<void> {
  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };

  const channel = new Channel<StreamEvent>();
  channel.onmessage = (m) => {
    if (m.event === "delta") handlers.onDelta(m.data.text);
    else if (m.event === "skill") handlers.onSkill?.(m.data);
    else if (m.event === "done") finish(handlers.onDone);
    else finish(() => handlers.onError(m.data.message));
  };

  try {
    await invoke("chat_stream", { system, messages, characterId, onEvent: channel });
    finish(handlers.onDone);
  } catch (e) {
    finish(() => handlers.onError(String(e)));
  }
}
