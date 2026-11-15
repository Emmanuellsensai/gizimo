// Avatar files in the app data folder, one set per character:
//   photo   <id>.png          the character's photo (the web side shrinks it and re-encodes it to PNG)
//   cartoon <id>.cartoon.png  the cartoon version of that photo
//   model   <id>.vrm          a 3D character (VRM files are glTF binaries)
// Each kind is checked by its file signature and size before it is written, and names can only ever be built from a
// valid character id, so nothing can be written outside the avatars folder.
use std::{fs, path::PathBuf};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager,
};

use crate::valid_id;

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const KINDS: [&str; 3] = ["photo", "cartoon", "model"];

pub fn is_png(data: &[u8]) -> bool {
    data.len() > PNG_MAGIC.len() && data[..PNG_MAGIC.len()] == PNG_MAGIC
}

/// A glTF binary (.glb) starts with the letters "glTF" and version 2. VRM 0.x and 1.0 files are .glb files.
pub fn is_glb(data: &[u8]) -> bool {
    data.len() > 20 && &data[..4] == b"glTF" && u32::from_le_bytes([data[4], data[5], data[6], data[7]]) == 2
}

struct Kind {
    suffix: &'static str,
    max_bytes: usize,
    valid: fn(&[u8]) -> bool,
    label: &'static str,
}

fn kind(name: &str) -> Result<Kind, String> {
    match name {
        "photo" => Ok(Kind { suffix: "png", max_bytes: 4 << 20, valid: is_png, label: "PNG picture" }),
        "cartoon" => Ok(Kind { suffix: "cartoon.png", max_bytes: 4 << 20, valid: is_png, label: "PNG picture" }),
        "model" => Ok(Kind { suffix: "vrm", max_bytes: 64 << 20, valid: is_glb, label: "VRM or GLB 3D model" }),
        _ => Err("Unknown avatar file kind".into()),
    }
}

fn avatars_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("avatars");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn file_for(app: &AppHandle, id: &str, k: &Kind) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid character id".into());
    }
    Ok(avatars_dir(app)?.join(format!("{id}.{}", k.suffix)))
}

/// The bytes are the request body; the character id and the kind travel in the `id` and `kind` headers.
#[tauri::command]
pub fn save_avatar_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected the file as raw bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let id = header("id").ok_or("Missing character id")?;
    let k = kind(&header("kind").ok_or("Missing file kind")?)?;
    if data.len() > k.max_bytes {
        return Err("That file is too large".into());
    }
    if !(k.valid)(data) {
        return Err(format!("That file is not a {}", k.label));
    }
    let path = file_for(&app, &id, &k)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_avatar_file(app: AppHandle, id: String, kind_name: String) -> Result<Response, String> {
    let path = file_for(&app, &id, &kind(&kind_name)?)?;
    fs::read(path).map(Response::new).map_err(|_| "Nothing saved for this character".to_string())
}

#[tauri::command]
pub fn delete_avatar_file(app: AppHandle, id: String, kind_name: String) -> Result<(), String> {
    let path = file_for(&app, &id, &kind(&kind_name)?)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Removes every avatar file of a character (used when the character is deleted).
pub fn delete_all(app: &AppHandle, id: &str) {
    for name in KINDS {
        if let Ok(k) = kind(name) {
            if let Ok(path) = file_for(app, id, &k) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_real_pngs() {
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(b"rest of the file");
        assert!(is_png(&png));
        assert!(!is_png(b"\xFF\xD8\xFF\xE0 jpeg data here"));
        assert!(!is_png(b"GIF89a....."));
        assert!(!is_png(&PNG_MAGIC)); // header only, no content
        assert!(!is_png(b""));
    }

    #[test]
    fn accepts_only_glb_files() {
        let mut glb = b"glTF".to_vec();
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&[0u8; 32]);
        assert!(is_glb(&glb));
        let mut old = b"glTF".to_vec();
        old.extend_from_slice(&1u32.to_le_bytes());
        old.extend_from_slice(&[0u8; 32]);
        assert!(!is_glb(&old)); // glTF 1 is not what VRM uses
        assert!(!is_glb(b"glTF"));
        assert!(!is_glb(b"PK\x03\x04 a zip file pretending to be a model......"));
        assert!(!is_glb(b""));
    }

    #[test]
    fn kinds_have_their_own_names_and_limits() {
        assert_eq!(kind("photo").unwrap().suffix, "png");
        assert_eq!(kind("cartoon").unwrap().suffix, "cartoon.png");
        assert_eq!(kind("model").unwrap().suffix, "vrm");
        assert!(kind("model").unwrap().max_bytes > kind("photo").unwrap().max_bytes);
        assert!(kind("../etc").is_err());
        assert!(kind("").is_err());
    }
}
