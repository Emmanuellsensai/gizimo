// The floating avatar: a small transparent window that stays on top of everything and can be moved to any screen.
// Hidden, not destroyed, when you dismiss it, so it comes back instantly. Hotkeys (set up in lib.rs) call the same
// functions as the buttons.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "overlay";
const WIDTH: f64 = 270.0;
const HEIGHT: f64 = 450.0;
const MARGIN: i32 = 24;
const TASKBAR: i32 = 48; // keeps the avatar clear of the taskbar when a monitor's work area is not known

#[derive(Default)]
pub struct OverlayState {
    click_through: Mutex<bool>,
    hotkeys: Mutex<Vec<Hotkey>>,
}

/// One global hotkey and whether Windows let us have it (another program may already own the combination).
#[derive(Serialize, Clone)]
pub struct Hotkey {
    pub action: String,
    pub keys: String,
    pub ok: bool,
}

impl OverlayState {
    pub fn record_hotkey(&self, action: &str, keys: &str, ok: bool) {
        self.hotkeys.lock().unwrap().push(Hotkey { action: action.into(), keys: keys.into(), ok });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    visible: bool,
    click_through: bool,
    monitors: usize,
    hotkeys: Vec<Hotkey>,
}

/// Bottom-right corner of a screen, leaving a margin. All values are physical pixels.
pub fn corner(mon_x: i32, mon_y: i32, mon_w: u32, mon_h: u32, win_w: u32, win_h: u32) -> (i32, i32) {
    (
        mon_x + mon_w as i32 - win_w as i32 - MARGIN,
        mon_y + mon_h as i32 - win_h as i32 - MARGIN - TASKBAR,
    )
}

/// Builds the (hidden) floating window. Call this once at start-up: building a window from a plain command freezes the
/// whole app on Windows, so everything after start-up only shows, hides and moves the window that already exists.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Gizimo avatar")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    place(&window, 0)?;
    Ok(window)
}

/// Puts the window in the bottom-right corner of the screen with this index (0 is the first one).
fn place(window: &WebviewWindow, index: usize) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let Some(m) = monitors.get(index).or_else(|| monitors.first()) else {
        return Ok(());
    };
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = corner(m.position().x, m.position().y, m.size().width, m.size().height, size.width, size.height);
    window.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    let w = create(app)?;
    w.show().map_err(|e| e.to_string())?;
    // If the page failed to load (a network hiccup while it started), reload it once instead of showing a blank box.
    let _ = w.eval("setTimeout(function () { if (!document.querySelector('#root > *')) location.reload(); }, 3000);");
    Ok(())
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    let visible = app
        .get_webview_window(LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        hide(app)?;
        Ok(false)
    } else {
        show(app)?;
        Ok(true)
    }
}

/// Moves the avatar to the next screen, wrapping round to the first.
pub fn next_monitor(app: &AppHandle) -> Result<(), String> {
    let w = create(app)?;
    let monitors = w.available_monitors().map_err(|e| e.to_string())?;
    if monitors.len() < 2 {
        return Ok(());
    }
    let here = w.current_monitor().map_err(|e| e.to_string())?;
    let current = monitors
        .iter()
        .position(|m| here.as_ref().is_some_and(|h| h.position() == m.position()))
        .unwrap_or(0);
    place(&w, (current + 1) % monitors.len())
}

pub const MIN_SCALE: f64 = 0.4;
pub const MAX_SCALE: f64 = 1.5;

/// The window size for a scale between 0.4 (small) and 1.5 (large); 1.0 is the normal size.
pub fn scaled_size(scale: f64) -> (f64, f64) {
    let s = if scale.is_finite() { scale.clamp(MIN_SCALE, MAX_SCALE) } else { 1.0 };
    (WIDTH * s, HEIGHT * s)
}

pub fn set_scale(app: &AppHandle, scale: f64) -> Result<(), String> {
    let w = create(app)?;
    let (width, height) = scaled_size(scale);
    w.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

pub fn set_click_through(app: &AppHandle, state: &OverlayState, on: bool) -> Result<(), String> {
    let w = create(app)?;
    w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    *state.click_through.lock().unwrap() = on;
    Ok(())
}

pub fn toggle_click_through(app: &AppHandle, state: &OverlayState) -> Result<bool, String> {
    let next = !*state.click_through.lock().unwrap();
    set_click_through(app, state, next)?;
    Ok(next)
}

// These are async on purpose: async commands run off the main thread, which window calls need on Windows.
#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<(), String> {
    hide(&app)
}

#[tauri::command]
pub async fn overlay_toggle(app: AppHandle) -> Result<bool, String> {
    toggle(&app)
}

#[tauri::command]
pub async fn overlay_next_monitor(app: AppHandle) -> Result<(), String> {
    next_monitor(&app)
}

#[tauri::command]
pub async fn overlay_set_scale(app: AppHandle, scale: f64) -> Result<(), String> {
    set_scale(&app, scale)
}

#[tauri::command]
pub async fn overlay_set_click_through(app: AppHandle, state: State<'_, OverlayState>, on: bool) -> Result<(), String> {
    set_click_through(&app, &state, on)
}

#[tauri::command]
pub async fn overlay_status(app: AppHandle, state: State<'_, OverlayState>) -> Result<Status, String> {
    let window = app.get_webview_window(LABEL);
    Ok(Status {
        visible: window.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false),
        click_through: *state.click_through.lock().unwrap(),
        monitors: app.available_monitors().map(|m| m.len()).unwrap_or(1),
        hotkeys: state.hotkeys.lock().unwrap().clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_sits_inside_the_screen_with_a_margin() {
        // A 1920x1080 screen at the origin.
        let (x, y) = corner(0, 0, 1920, 1080, 260, 320);
        assert_eq!(x, 1920 - 260 - MARGIN);
        assert_eq!(y, 1080 - 320 - MARGIN - TASKBAR);
        assert!(x > 0 && y > 0);
    }

    #[test]
    fn scale_is_limited_and_keeps_the_shape() {
        let (w, h) = scaled_size(1.0);
        assert_eq!((w, h), (WIDTH, HEIGHT));
        let (small_w, small_h) = scaled_size(0.01);
        assert!((small_w / small_h - WIDTH / HEIGHT).abs() < 1e-9);
        assert!(small_w >= WIDTH * MIN_SCALE - 1e-9);
        assert!(scaled_size(50.0).0 <= WIDTH * MAX_SCALE + 1e-9);
        assert_eq!(scaled_size(f64::NAN), (WIDTH, HEIGHT));
    }

    #[test]
    fn corner_follows_a_second_screen_to_the_left_or_right() {
        let (x, _) = corner(1920, 0, 1920, 1080, 260, 320);
        assert!(x > 1920 && x < 3840);
        let (x, _) = corner(-1920, 0, 1920, 1080, 260, 320);
        assert!(x < 0 && x > -1920);
    }
}
