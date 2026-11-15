import { useEffect, useRef, useState } from "preact/hooks";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Avatar from "./Avatar";
import { EV_CHARACTER, EV_HELLO, EV_LEVEL } from "./events";
import { loadAll } from "../character/store";
import type { Character } from "../character/types";

const BASE_WIDTH = 240; // how the avatar is drawn at scale 1
const BASE_HEIGHT = 380;
const MIN = 0.4;
const MAX = 1.5;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

function savedScale(): number {
  try {
    const v = Number(localStorage.getItem("gizimo.overlay.scale"));
    return Number.isFinite(v) && v > 0 ? clamp(v) : 1;
  } catch {
    return 1;
  }
}

/** The floating avatar window: just the avatar, which follows what the main window is saying. Drag it to move it,
 *  drag the corner grip or turn the mouse wheel to make it smaller or bigger. */
export default function OverlayApp() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [scale, setScale] = useState(savedScale);
  const level = useRef({ value: 0, at: 0 });
  const drag = useRef<{ x: number; start: number } | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    void loadAll()
      .then((l) => setCharacters(l.good))
      .catch(() => undefined);

    const stops: Promise<() => void>[] = [
      listen<{ id: string }>(EV_CHARACTER, (e) => {
        setId(e.payload.id);
        void loadAll()
          .then((l) => setCharacters(l.good))
          .catch(() => undefined); // pick up edits made in the main window
      }),
      listen<{ level: number }>(EV_LEVEL, (e) => {
        level.current = { value: e.payload.level, at: performance.now() };
      }),
    ];
    // Ask the main window who is active (it may have been talking before this window opened).
    void Promise.all(stops).then(() => emit(EV_HELLO));
    return () => {
      for (const s of stops) void s.then((stop) => stop());
    };
  }, []);

  // Make the window match the chosen size, and remember it for next time.
  useEffect(() => {
    void invoke("overlay_set_scale", { scale }).catch(() => undefined);
    try {
      localStorage.setItem("gizimo.overlay.scale", String(scale));
    } catch {
      /* it just will not be remembered */
    }
  }, [scale]);

  const character = characters.find((c) => c.id === id) ?? characters[0] ?? null;
  const getLevel = () => (performance.now() - level.current.at > 300 ? 0 : level.current.value); // no news means quiet

  const gripDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, start: scale };
  };
  const gripMove = (e: PointerEvent) => {
    if (drag.current) setScale(clamp(drag.current.start + (e.screenX - drag.current.x) / 300));
  };
  const gripUp = () => {
    drag.current = null;
  };

  if (!character) return <div class="overlay-root" data-tauri-drag-region />;

  return (
    <div class="overlay-root" data-tauri-drag-region onWheel={(e) => setScale((s) => clamp(s - e.deltaY * 0.001))}>
      <Avatar character={character} getLevel={getLevel} width={BASE_WIDTH} height={BASE_HEIGHT} mode="full" scale={scale} dragRegion />
      <div class="overlay-bar">
        <button title="Smaller" onClick={() => setScale((s) => clamp(s - 0.1))}>
          -
        </button>
        <button title="Bigger" onClick={() => setScale((s) => clamp(s + 0.1))}>
          +
        </button>
        <button title="Move to the next screen (Ctrl+Alt+Shift+M)" onClick={() => void invoke("overlay_next_monitor")}>
          Screen
        </button>
        <button title="Clicks go through the avatar. Ctrl+Alt+Shift+T turns this off again." onClick={() => void invoke("overlay_set_click_through", { on: true })}>
          Pass-through
        </button>
        <button title="Hide (Ctrl+Alt+Shift+G brings it back)" onClick={() => void invoke("overlay_hide")}>
          Hide
        </button>
      </div>
      <div
        class="overlay-grip"
        title="Drag to make it smaller or bigger"
        onPointerDown={gripDown}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        onPointerCancel={gripUp}
      />
    </div>
  );
}
