// The owner's own Kola voice: a small model that sits in the app's data folder (voice-kola/). Its weights are private,
// so nothing here downloads anything. The window asks for two files by name and gets their bytes.
use std::fs;

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Manager};

const FILES: [&str; 2] = ["model.onnx", "vocab.json"];
const MAX_BYTES: u64 = 400 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KolaStatus {
    installed: bool,
    model_mb: u64,
}

fn dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("voice-kola"))
}

#[tauri::command]
pub fn kola_voice_status(app: AppHandle) -> Result<KolaStatus, String> {
    let d = dir(&app)?;
    let model = fs::metadata(d.join("model.onnx")).map(|m| m.len()).unwrap_or(0);
    let vocab = d.join("vocab.json").is_file();
    Ok(KolaStatus { installed: model > 0 && vocab, model_mb: model / 1_048_576 })
}

/// One of the two voice files, as raw bytes. Any other name is refused.
#[tauri::command]
pub fn kola_voice_read(app: AppHandle, name: String) -> Result<Response, String> {
    if !FILES.contains(&name.as_str()) {
        return Err("Unknown voice file.".into());
    }
    let path = dir(&app)?.join(&name);
    let size = fs::metadata(&path).map_err(|_| "The Kola voice is not installed.".to_string())?.len();
    if size > MAX_BYTES {
        return Err("That voice file is too large.".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_files_are_readable() {
        assert!(FILES.contains(&"model.onnx"));
        assert!(!FILES.contains(&"../secret"));
        assert!(!FILES.contains(&"vocab.json/../x"));
    }
}
