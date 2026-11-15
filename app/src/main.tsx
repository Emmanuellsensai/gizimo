import { render } from "preact";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import OverlayApp from "./avatar/OverlayApp";

// The same page serves two windows: the main one, and the small floating avatar (label "overlay").
function isOverlay(): boolean {
  try {
    return getCurrentWindow().label === "overlay";
  } catch {
    return false; // not running inside Gizimo, for example a plain browser
  }
}

render(isOverlay() ? <OverlayApp /> : <App />, document.getElementById("root")!);
