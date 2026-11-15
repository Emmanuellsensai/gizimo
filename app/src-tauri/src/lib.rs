// Gizimo core. M1: character storage in the app data folder.
//
// The web side validates the full schema. The Rust side is the gatekeeper for the file system: it only accepts
// ids that match the schema pattern, so a character can never read or write outside its own folder.
mod avatars;
mod ears;
mod keys;
mod llm;
mod overlay;
mod packs;
mod skills;

use std::{fs, path::PathBuf};

use serde::Serialize;
use tauri::Manager;

const MAX_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
struct Stored {
    id: String,
    json: String,
}

pub(crate) fn valid_id(id: &str) -> bool {
    (2..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn characters_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("characters");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn file_for(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid character id".into());
    }
    Ok(characters_dir(app)?.join(format!("{id}.json")))
}

#[tauri::command]
fn list_characters(app: tauri::AppHandle) -> Result<Vec<Stored>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(characters_dir(&app)?).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        if !valid_id(&id) {
            continue;
        }
        let Ok(json) = fs::read_to_string(&path) else {
            continue;
        };
        if json.len() > MAX_BYTES {
            continue;
        }
        out.push(Stored { id, json });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
fn save_character(app: tauri::AppHandle, id: String, json: String) -> Result<(), String> {
    let path = file_for(&app, &id)?;
    if json.len() > MAX_BYTES {
        return Err("Character file is too large".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Not valid JSON: {e}"))?;
    if value.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
        return Err("The id inside the file does not match its name".into());
    }
    // Write to a temp file first so a crash never leaves a half-written character.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_character(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = file_for(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    avatars::delete_all(&app, &id); // its photo, cartoon and 3D model go with it
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn ids_follow_the_schema_pattern() {
        assert!(valid_id("kola"));
        assert!(valid_id("my-friend-2"));
        assert!(!valid_id("a"));
        assert!(!valid_id("Upper"));
        assert!(!valid_id("../evil"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("with space"));
        assert!(!valid_id(&"x".repeat(41)));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager as _;
    use tauri_plugin_global_shortcut::{Builder as Shortcuts, Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    // Ctrl+Alt+Shift+G shows or hides the floating avatar, +M moves it to the next screen, +T lets mouse clicks pass
    // through it (press again to get them back). Shift is part of it because plain Ctrl+Alt+G was already taken by
    // another program on the first test PC. If Windows refuses a key, it is skipped, recorded, and the app tells you.
    let mods = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT;
    let keys = [
        (Code::KeyG, "show or hide", "Ctrl+Alt+Shift+G"),
        (Code::KeyM, "next screen", "Ctrl+Alt+Shift+M"),
        (Code::KeyT, "click-through", "Ctrl+Alt+Shift+T"),
        (Code::KeyK, "skills kill switch", "Ctrl+Alt+Shift+K"),
    ];

    tauri::Builder::default()
        .plugin(
            Shortcuts::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let which = if shortcut.matches(mods, Code::KeyG) {
                        1
                    } else if shortcut.matches(mods, Code::KeyM) {
                        2
                    } else if shortcut.matches(mods, Code::KeyT) {
                        3
                    } else if shortcut.matches(mods, Code::KeyK) {
                        4
                    } else {
                        return;
                    };
                    // Window calls must not run on the thread that delivers the hotkey, or the app can freeze.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let result = match which {
                            1 => overlay::toggle(&app).map(|_| ()),
                            2 => overlay::next_monitor(&app),
                            4 => {
                                // The kill switch: stops every skill at once, and tells the window.
                                let on = app.state::<skills::SkillState>().toggle();
                                tauri::Emitter::emit(&app, "gizimo:skills", serde_json::json!({ "enabled": on })).map_err(|e| e.to_string())
                            }
                            _ => overlay::toggle_click_through(&app, &app.state::<overlay::OverlayState>()).map(|_| ()),
                        };
                        if let Err(e) = result {
                            eprintln!("Gizimo hotkey failed: {e}");
                        }
                    });
                })
                .build(),
        )
        .setup(move |app| {
            let state = app.state::<overlay::OverlayState>();
            for (code, action, label) in keys {
                let result = app.global_shortcut().register(Shortcut::new(Some(mods), code));
                if let Err(e) = &result {
                    eprintln!("Gizimo could not take {label}: {e}");
                }
                state.record_hotkey(action, label, result.is_ok());
            }
            // The floating window is built the first time it is wanted, not here: building a second webview while
            // the main window is still loading left the main window blank on the first test PC.
            Ok(())
        })
        .on_window_event(|window, event| {
            // The floating avatar must never keep the app alive after the main window is closed.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().state::<ears::EarsState>().stop(); // do not leave the speech engine running
                    window.app_handle().exit(0);
                }
            }
        })
        .manage(llm::ChatState::default())
        .manage(overlay::OverlayState::default())
        .manage(skills::SkillState::default())
        .manage(ears::EarsState::default())
        .invoke_handler(tauri::generate_handler![
            ears::ears_status,
            ears::ears_stop,
            ears::ears_transcribe,
            skills::skills_status,
            skills::skills_set_enabled,
            skills::skills_log,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_toggle,
            overlay::overlay_next_monitor,
            overlay::overlay_set_scale,
            overlay::overlay_set_click_through,
            overlay::overlay_status,
            avatars::save_avatar_file,
            avatars::read_avatar_file,
            avatars::delete_avatar_file,
            list_characters,
            save_character,
            delete_character,
            keys::key_status,
            keys::set_api_key,
            keys::clear_api_key,
            llm::chat_stream,
            llm::stop_chat,
            packs::download_pack_file,
            packs::list_packs,
            packs::delete_pack,
            packs::read_pack_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gizimo");
}
