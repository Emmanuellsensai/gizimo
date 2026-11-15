// Voice packs: model files that are downloaded once into the app data folder.
//
// Safety rules, all enforced here in Rust:
// - the download address must be https on an allowed host;
// - the app must know the file's SHA-256 in advance, and a file that does not match is deleted, so even a hijacked
//   download link cannot put anything on the disk that we did not expect;
// - pack, version and file names are plain names, so nothing can be written outside the packs folder;
// - a size cap stops runaway downloads.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    ipc::{Channel, Response},
    Manager,
};

const MAX_FILE_BYTES: u64 = 400 * 1024 * 1024;
const ALLOWED_HOSTS: &[&str] = &["huggingface.co", "arweave.net", "github.com"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
pub struct FileInfo {
    name: String,
    size: u64,
}

#[derive(Serialize)]
pub struct Installed {
    id: String,
    version: String,
    files: Vec<FileInfo>,
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

pub fn safe_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

pub fn check_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "The download address is not valid.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Downloads must use https.".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The download address must not contain a login.".into());
    }
    match parsed.host_str() {
        Some(host) if ALLOWED_HOSTS.contains(&host) => Ok(()),
        _ => Err("Voice packs can only be downloaded from Hugging Face.".into()),
    }
}

pub fn check_sha(sha: &str) -> Result<(), String> {
    if sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err("The expected SHA-256 must be 64 lowercase hex characters.".into())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Moves a finished download into place only if its hash is the one we expected.
pub fn verify_and_install(part: &Path, dest: &Path, expected: &str, actual: &str) -> Result<(), String> {
    if actual != expected {
        let _ = fs::remove_file(part);
        return Err("The downloaded file failed its integrity check and was deleted.".into());
    }
    fs::rename(part, dest).map_err(|e| e.to_string())
}

fn packs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("packs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn file_path(app: &tauri::AppHandle, id: &str, version: &str, name: &str) -> Result<PathBuf, String> {
    if !(safe_part(id) && safe_part(version) && safe_part(name)) {
        return Err("Invalid pack, version or file name.".into());
    }
    Ok(packs_dir(app)?.join(id).join(version).join(name))
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn download_pack_file(
    app: tauri::AppHandle,
    id: String,
    version: String,
    name: String,
    url: String,
    sha256: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let dest = file_path(&app, &id, &version, &name)?;
    check_url(&url)?;
    check_sha(&sha256)?;

    if dest.exists() && file_sha256(&dest)? == sha256 {
        return Ok(()); // already installed and intact
    }
    fs::create_dir_all(dest.parent().ok_or("Bad path")?).map_err(|e| e.to_string())?;
    let part = dest.with_extension("part");

    let response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|_| "Could not reach the download server. Check your internet connection.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("The download server answered {}.", response.status().as_u16()));
    }
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_FILE_BYTES) {
        return Err("The file is larger than the allowed size.".into());
    }

    let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            let _ = fs::remove_file(&part);
            "The download was interrupted.".to_string()
        })?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_FILE_BYTES {
            let _ = fs::remove_file(&part);
            return Err("The file is larger than the allowed size.".into());
        }
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        let _ = on_progress.send(Progress { downloaded, total });
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    verify_and_install(&part, &dest, &sha256, &hex(&hasher.finalize()))
}

#[tauri::command]
pub fn list_packs(app: tauri::AppHandle) -> Result<Vec<Installed>, String> {
    let mut out = Vec::new();
    for pack in fs::read_dir(packs_dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let Some(id) = pack.file_name().to_str().map(str::to_owned).filter(|s| safe_part(s)) else {
            continue;
        };
        let Ok(versions) = fs::read_dir(pack.path()) else { continue };
        for version in versions.flatten() {
            let Some(v) = version.file_name().to_str().map(str::to_owned).filter(|s| safe_part(s)) else {
                continue;
            };
            let files = fs::read_dir(version.path())
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|f| {
                            let name = f.file_name().to_str()?.to_owned();
                            (safe_part(&name) && !name.ends_with(".part")).then(|| FileInfo {
                                size: f.metadata().map(|m| m.len()).unwrap_or(0),
                                name,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(Installed { id: id.clone(), version: v, files });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_pack(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !safe_part(&id) {
        return Err("Invalid pack name.".into());
    }
    let dir = packs_dir(&app)?.join(id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the raw bytes of a pack file (no JSON, so big models stay fast).
#[tauri::command]
pub fn read_pack_file(app: tauri::AppHandle, id: String, version: String, name: String) -> Result<Response, String> {
    let path = file_path(&app, &id, &version, &name)?;
    fs::read(path).map(Response::new).map_err(|_| "That pack file is not installed.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gizimo-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_are_plain() {
        assert!(safe_part("kola-en-f"));
        assert!(safe_part("model.onnx"));
        assert!(safe_part("1.0.2"));
        assert!(!safe_part(""));
        assert!(!safe_part(".."));
        assert!(!safe_part(".hidden"));
        assert!(!safe_part("a/b"));
        assert!(!safe_part("a\\b"));
        assert!(!safe_part("C:evil"));
        assert!(!safe_part(&"x".repeat(65)));
    }

    #[test]
    fn only_https_and_the_listed_hosts_are_allowed() {
        assert!(check_url("https://huggingface.co/user/repo/resolve/main/model.onnx").is_ok());
        assert!(check_url("https://arweave.net/Ea1KXujzJatQgCFSMzGOzp_UtHqB1pyia--U3AtkMAY").is_ok());
        assert!(check_url("https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx").is_ok());
        assert!(check_url("https://raw.githubusercontent.com/someone/repo/main/file").is_err());
        assert!(check_url("https://arweave.net.evil.example/x").is_err());
        assert!(check_url("http://huggingface.co/x").is_err());
        assert!(check_url("https://evil.example/model.onnx").is_err());
        assert!(check_url("https://huggingface.co.evil.example/x").is_err());
        assert!(check_url("https://user:pw@huggingface.co/x").is_err());
        assert!(check_url("file:///C:/secret").is_err());
        assert!(check_url("not a url").is_err());
    }

    #[test]
    fn sha_must_be_lowercase_hex_of_the_right_length() {
        assert!(check_sha(&"a".repeat(64)).is_ok());
        assert!(check_sha(&"A".repeat(64)).is_err());
        assert!(check_sha(&"a".repeat(63)).is_err());
        assert!(check_sha(&"g".repeat(64)).is_err());
    }

    #[test]
    fn hashes_a_file() {
        let dir = temp("hash");
        let f = dir.join("abc.bin");
        fs::write(&f, b"abc").unwrap();
        assert_eq!(
            file_sha256(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wrong_hash_deletes_the_download() {
        let dir = temp("verify");
        let part = dir.join("m.part");
        let dest = dir.join("m.onnx");
        fs::write(&part, b"data").unwrap();
        assert!(verify_and_install(&part, &dest, &"a".repeat(64), &"b".repeat(64)).is_err());
        assert!(!part.exists());
        assert!(!dest.exists());

        fs::write(&part, b"data").unwrap();
        assert!(verify_and_install(&part, &dest, &"a".repeat(64), &"a".repeat(64)).is_ok());
        assert!(dest.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
