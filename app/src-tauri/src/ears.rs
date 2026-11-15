// Native speech recognition with the owner's own model (kola-asr-v2, converted to whisper.cpp's format).
//
// whisper.cpp's small server is started on this PC, listening on localhost only, and loads the model ONCE. Each recording
// is sent to it as a WAV and the text comes back. Nothing leaves the computer. The files live in the app data folder:
//   ears/whisper-server.exe (and its .dll files) and ears/model.bin
// Without them the app falls back to the built-in browser engine.
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
const SERVER_EXE: &str = "whisper-server.exe";
#[cfg(not(windows))]
const SERVER_EXE: &str = "whisper-server";

const MAX_SECONDS: usize = 30;
const SAMPLE_RATE: usize = 16_000;

#[derive(Default)]
pub struct EarsState {
    server: Mutex<Option<(Child, u16)>>,
}

impl EarsState {
    pub fn stop(&self) {
        if let Some((mut child, _)) = self.server.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for EarsState {
    fn drop(&mut self) {
        self.stop();
    }
}

fn ears_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ears"))
}

/// 16 kHz mono 32-bit float samples (little-endian bytes) to a 16-bit WAV file in memory.
pub fn pcm_to_wav(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() % 4 != 0 || bytes.is_empty() {
        return Err("The recording is not valid audio.".into());
    }
    let samples = bytes.len() / 4;
    if samples > MAX_SECONDS * SAMPLE_RATE {
        return Err(format!("Recordings can be at most {MAX_SECONDS} seconds."));
    }
    let data_len = (samples * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for c in bytes.chunks_exact(4) {
        let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
        wav.extend_from_slice(&s.to_le_bytes());
    }
    Ok(wav)
}

/// The whisper language codes we pass on. Igbo borrows the Lingala tag, as in the model's training.
pub fn language_code(lang: &str) -> &'static str {
    match lang {
        "yo" => "yo",
        "ha" => "ha",
        "ig" => "ln",
        _ => "en", // English and Pidgin (Pidgin is written as English)
    }
}

pub fn parse_text(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "The speech engine sent back something unreadable.".to_string())?;
    if let Some(e) = v["error"].as_str() {
        return Err(format!("The speech engine reported: {}", e.chars().take(160).collect::<String>()));
    }
    Ok(v["text"].as_str().unwrap_or("").trim().to_owned())
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    installed: bool,
    running: bool,
    model_mb: u64,
}

#[tauri::command]
pub fn ears_status(app: AppHandle, state: State<'_, EarsState>) -> Result<Status, String> {
    let dir = ears_dir(&app)?;
    let model = dir.join("model.bin");
    let installed = dir.join(SERVER_EXE).is_file() && model.is_file();
    Ok(Status {
        installed,
        running: state.server.lock().unwrap().is_some(),
        model_mb: fs::metadata(&model).map(|m| m.len() / 1_048_576).unwrap_or(0),
    })
}

#[tauri::command]
pub fn ears_stop(state: State<'_, EarsState>) {
    state.stop();
}

fn ensure_server(app: &AppHandle, state: &EarsState) -> Result<u16, String> {
    {
        let mut guard = state.server.lock().unwrap();
        if let Some((child, port)) = guard.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(*port);
            }
            *guard = None; // it died; start a new one
        }
    }
    let dir = ears_dir(app)?;
    let exe = dir.join(SERVER_EXE);
    let model = dir.join("model.bin");
    if !exe.is_file() || !model.is_file() {
        return Err("The Kola ears are not installed on this PC yet.".into());
    }
    let port = free_port()?;
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 8)).unwrap_or(4);
    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir)
        .args(["-m", "model.bin", "--host", "127.0.0.1", "--port", &port.to_string(), "-t", &threads.to_string(), "-nt", "-nf"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the speech engine: {e}"))?;
    *state.server.lock().unwrap() = Some((child, port));

    // Wait until it answers (loading a large model takes several seconds).
    let started = Instant::now();
    loop {
        if reqwest::blocking::Client::new().get(format!("http://127.0.0.1:{port}/")).timeout(Duration::from_secs(2)).send().is_ok() {
            return Ok(port);
        }
        if started.elapsed() > Duration::from_secs(120) {
            state.stop();
            return Err("The speech engine did not start in time.".into());
        }
        if let Some((child, _)) = state.server.lock().unwrap().as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *state.server.lock().unwrap() = None;
                return Err("The speech engine stopped right after starting. The model file may be damaged.".into());
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Turns a recording (16 kHz mono f32 samples as bytes) into text with the Kola ears.
#[tauri::command]
pub async fn ears_transcribe(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    // The samples are the request body (raw bytes, fast); the language travels in a header.
    let tauri::ipc::InvokeBody::Raw(pcm) = request.body() else {
        return Err("Expected the recording as raw bytes.".into());
    };
    let language = request.headers().get("language").and_then(|v| v.to_str().ok()).unwrap_or("en").to_owned();
    let wav = pcm_to_wav(pcm)?;
    // Starting the server and waiting for it are blocking calls, so they run off the async thread.
    let handle = app.clone();
    let port = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<EarsState>();
        ensure_server(&handle, &state)
    })
    .await
    .map_err(|e| e.to_string())??;

    let part = reqwest::multipart::Part::bytes(wav).file_name("speech.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json")
        .text("temperature", "0.0")
        .text("language", language_code(&language));
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/inference"))
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|_| "The speech engine did not answer.".to_string())?;
    let body = response.text().await.map_err(|e| e.to_string())?;
    parse_text(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn makes_a_valid_wav() {
        let wav = pcm_to_wav(&bytes(&[0.0, 0.5, -0.5, 1.5, -1.5])).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1); // mono
        assert_eq!(wav.len(), 44 + 5 * 2);
        let sample = |i: usize| i16::from_le_bytes(wav[44 + i * 2..46 + i * 2].try_into().unwrap());
        assert_eq!(sample(0), 0);
        assert_eq!(sample(1), 16383);
        assert_eq!(sample(3), 32767); // clipped, not wrapped
        assert_eq!(sample(4), -32767);
    }

    #[test]
    fn rejects_bad_recordings() {
        assert!(pcm_to_wav(&[]).is_err());
        assert!(pcm_to_wav(&[1, 2, 3]).is_err()); // not whole samples
        assert!(pcm_to_wav(&vec![0u8; (MAX_SECONDS * SAMPLE_RATE + 1) * 4]).is_err());
        assert!(pcm_to_wav(&vec![0u8; MAX_SECONDS * SAMPLE_RATE * 4]).is_ok());
    }

    #[test]
    fn maps_languages() {
        assert_eq!(language_code("en"), "en");
        assert_eq!(language_code("pcm"), "en");
        assert_eq!(language_code("yo"), "yo");
        assert_eq!(language_code("ha"), "ha");
        assert_eq!(language_code("ig"), "ln");
        assert_eq!(language_code("anything else"), "en");
    }

    #[test]
    fn reads_the_servers_answers() {
        assert_eq!(parse_text(r#"{"text": " Hello there.\n"}"#).unwrap(), "Hello there.");
        assert_eq!(parse_text(r#"{"text": ""}"#).unwrap(), "");
        assert!(parse_text(r#"{"error": "bad audio"}"#).unwrap_err().contains("bad audio"));
        assert!(parse_text("not json").is_err());
    }
}
