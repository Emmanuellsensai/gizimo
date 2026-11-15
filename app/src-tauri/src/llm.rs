// Streaming chat with Claude Haiku 5.5. The API key is read from the secure store here and never leaves Rust.
// The web side sends a system prompt and the messages; the model, token limit and size limits are fixed here.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, State};

use crate::{
    keys,
    skills::{self, Policy, SkillState},
};

const MODEL: &str = "claude-haiku-5-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS: u32 = 700;
const MAX_MESSAGES: usize = 60;
const MAX_SYSTEM_CHARS: usize = 12_000;
const MAX_TOTAL_CHARS: usize = 60_000;
const MAX_ROUNDS: usize = 4; // a reply may use tools at most this many times in a row
const POLL: Duration = Duration::from_millis(200);
const IDLE_LIMIT: Duration = Duration::from_secs(60);

#[derive(Deserialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    /// A skill was asked for: what it was, whether it ran, and a short result.
    Skill { name: String, ok: bool, summary: String },
    Done,
    Error { message: String },
}

/// Only one chat runs at a time. Starting a new one stops the old one.
#[derive(Default)]
pub struct ChatState {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

// ---------------------------------------------------------------------------------------------------------------
// Request checks

pub fn validate_request(system: &str, messages: &[ChatMessage]) -> Result<(), String> {
    if system.chars().count() > MAX_SYSTEM_CHARS {
        return Err("The character description is too long.".into());
    }
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err(format!("A chat needs between 1 and {MAX_MESSAGES} messages."));
    }
    if messages.last().map(|m| m.role.as_str()) != Some("user") {
        return Err("The last message must be from the user.".into());
    }
    let mut total = system.chars().count();
    for m in messages {
        if m.role != "user" && m.role != "assistant" {
            return Err("Messages must be from the user or the assistant.".into());
        }
        if m.content.trim().is_empty() {
            return Err("Messages cannot be empty.".into());
        }
        total += m.content.chars().count();
    }
    if total > MAX_TOTAL_CHARS {
        return Err("This chat is too long. Start a new one.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Server-sent events from the Messages API

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Text(String),
    ToolStart { index: u64, id: String, name: String },
    ToolJson { index: u64, partial: String },
    BlockStop(u64),
    StopReason(String),
    Stop,
    Error(String),
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    /// Feed raw bytes as they arrive. Bytes are buffered until a whole event is there, so a multi-byte character
    /// split across two network chunks is never broken.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Parsed> {
        self.buf.extend(chunk.iter().filter(|b| **b != b'\r'));
        let mut out = Vec::new();
        while let Some(end) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buf.drain(..end + 2).collect();
            if let Some(parsed) = parse_block(&String::from_utf8_lossy(&block)) {
                out.push(parsed);
            }
        }
        out
    }
}

fn parse_block(block: &str) -> Option<Parsed> {
    let data = block
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(str::trim_start)
        .last()?;
    let v: Value = serde_json::from_str(data).ok()?;
    match v["type"].as_str()? {
        "content_block_delta" if v["delta"]["type"] == "text_delta" => {
            Some(Parsed::Text(v["delta"]["text"].as_str()?.to_owned()))
        }
        "content_block_start" if v["content_block"]["type"] == "tool_use" => Some(Parsed::ToolStart {
            index: v["index"].as_u64()?,
            id: v["content_block"]["id"].as_str()?.to_owned(),
            name: v["content_block"]["name"].as_str()?.to_owned(),
        }),
        "content_block_delta" if v["delta"]["type"] == "input_json_delta" => Some(Parsed::ToolJson {
            index: v["index"].as_u64()?,
            partial: v["delta"]["partial_json"].as_str().unwrap_or("").to_owned(),
        }),
        "content_block_stop" => Some(Parsed::BlockStop(v["index"].as_u64()?)),
        "message_delta" => v["delta"]["stop_reason"].as_str().map(|s| Parsed::StopReason(s.to_owned())),
        "message_stop" => Some(Parsed::Stop),
        "error" => {
            let kind = v["error"]["type"].as_str().unwrap_or("");
            let message = v["error"]["message"].as_str().unwrap_or("Unknown error");
            Some(Parsed::Error(friendly_stream_error(kind, message)))
        }
        _ => None,
    }
}

fn friendly_stream_error(kind: &str, message: &str) -> String {
    match kind {
        "overloaded_error" => "Anthropic is busy right now. Try again in a moment.".into(),
        "rate_limit_error" => "You are sending too fast, or your Anthropic limit is reached.".into(),
        _ => format!("Anthropic reported an error: {}", message.chars().take(200).collect::<String>()),
    }
}

pub fn http_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_default();
    match status {
        401 => "Your Anthropic API key was rejected. Remove it and add it again.".into(),
        403 => "Your Anthropic key is not allowed to use this model.".into(),
        429 => "Rate limit reached on your Anthropic account. Wait a little and try again.".into(),
        400 if message.to_lowercase().contains("credit") => {
            "Your Anthropic account has no credit left. Add credit in the Anthropic console.".into()
        }
        500..=599 => "Anthropic is having trouble right now. Try again in a moment.".into(),
        _ => format!("Anthropic error {status}: {}", message.chars().take(200).collect::<String>()),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub fn stop_chat(state: State<'_, ChatState>) {
    if let Some(flag) = state.active.lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn chat_stream(
    app: tauri::AppHandle,
    state: State<'_, ChatState>,
    skill_state: State<'_, SkillState>,
    system: String,
    messages: Vec<ChatMessage>,
    character_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    validate_request(&system, &messages)?;
    let key = keys::get()?.ok_or("Add your Anthropic API key first.")?;

    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.active.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::SeqCst);
    }

    // What this character may do is read from its saved file here in Rust, never from the web page.
    let policy = skills::policy_for(&app, &character_id);
    let result = run_chat(&app, &skill_state, &policy, &character_id, &key, &system, &messages, &on_event, &cancel).await;

    let mut active = state.active.lock().unwrap();
    if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, &cancel)) {
        *active = None;
    }
    drop(active);

    if let Err(message) = result {
        let _ = on_event.send(StreamEvent::Error { message });
    }
    Ok(())
}

struct ToolCall {
    id: String,
    name: String,
    input: Value,
}

struct Outcome {
    blocks: Vec<Value>,
    tools: Vec<ToolCall>,
    stop_reason: String,
    stopped: bool,
}

#[allow(clippy::too_many_arguments)]
async fn run_chat(
    app: &tauri::AppHandle,
    skill_state: &SkillState,
    policy: &Policy,
    character_id: &str,
    key: &str,
    system: &str,
    messages: &[ChatMessage],
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Could not start the network client: {e}"))?;

    let tools = if skill_state.is_enabled() { skills::tool_definitions(policy) } else { Vec::new() };
    let system_full = if tools.is_empty() { system.to_string() } else { format!("{system}\n\n{}", skills::prompt_note(policy)) };
    let mut convo: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();

    for round in 0..MAX_ROUNDS {
        let outcome = run_turn(&client, key, &system_full, &convo, &tools, on_event, cancel).await?;
        if outcome.stopped || outcome.stop_reason != "tool_use" || outcome.tools.is_empty() || round + 1 == MAX_ROUNDS {
            let _ = on_event.send(StreamEvent::Done);
            return Ok(());
        }
        convo.push(json!({"role": "assistant", "content": outcome.blocks}));
        let mut results = Vec::new();
        for call in &outcome.tools {
            let result = skills::run(app, skill_state, policy, character_id, &call.name, &call.input);
            let (content, is_error) = match &result {
                Ok(s) => (s.clone(), false),
                Err(e) => (e.clone(), true),
            };
            let _ = on_event.send(StreamEvent::Skill {
                name: call.name.clone(),
                ok: !is_error,
                summary: content.chars().take(160).collect(),
            });
            results.push(json!({"type": "tool_result", "tool_use_id": call.id, "content": content, "is_error": is_error}));
        }
        convo.push(json!({"role": "user", "content": results}));
    }
    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}

/// One request to the model: streams its words to the window and collects any skills it asked for.
async fn run_turn(
    client: &reqwest::Client,
    key: &str,
    system: &str,
    convo: &[Value],
    tools: &[Value],
    on_event: &Channel<StreamEvent>,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    let mut body = json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "stream": true,
        "messages": convo,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let response = client
        .post(API_URL)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach Anthropic. Check your internet connection.".to_string()
            } else {
                "The request to Anthropic failed.".to_string()
            }
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(http_error(status, &text));
    }

    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut idle = Duration::ZERO;
    let mut out = Outcome { blocks: Vec::new(), tools: Vec::new(), stop_reason: String::new(), stopped: false };
    let mut text = String::new();
    let mut open: HashMap<u64, (String, String, String)> = HashMap::new(); // index -> (id, name, json so far)

    'read: loop {
        if cancel.load(Ordering::SeqCst) {
            out.stopped = true;
            break;
        }
        match tokio::time::timeout(POLL, stream.next()).await {
            Err(_) => {
                idle += POLL;
                if idle >= IDLE_LIMIT {
                    return Err("Anthropic stopped answering. Try again.".into());
                }
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => return Err("The connection to Anthropic dropped.".into()),
            Ok(Some(Ok(chunk))) => {
                idle = Duration::ZERO;
                for parsed in parser.push(&chunk) {
                    match parsed {
                        Parsed::Text(t) => {
                            text.push_str(&t);
                            if on_event.send(StreamEvent::Delta { text: t }).is_err() {
                                out.stopped = true;
                                break 'read; // the window went away
                            }
                        }
                        Parsed::ToolStart { index, id, name } => {
                            if !text.trim().is_empty() {
                                out.blocks.push(json!({"type": "text", "text": std::mem::take(&mut text)}));
                            }
                            open.insert(index, (id, name, String::new()));
                        }
                        Parsed::ToolJson { index, partial } => {
                            if let Some(entry) = open.get_mut(&index) {
                                if entry.2.len() < 20_000 {
                                    entry.2.push_str(&partial);
                                }
                            }
                        }
                        Parsed::BlockStop(index) => {
                            if let Some((id, name, raw)) = open.remove(&index) {
                                let input = if raw.trim().is_empty() { json!({}) } else { serde_json::from_str(&raw).unwrap_or_else(|_| json!({})) };
                                out.blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
                                out.tools.push(ToolCall { id, name, input });
                            }
                        }
                        Parsed::StopReason(r) => out.stop_reason = r,
                        Parsed::Stop => break 'read,
                        Parsed::Error(message) => return Err(message),
                    }
                }
            }
        }
    }
    if !text.trim().is_empty() {
        out.blocks.push(json!({"type": "text", "text": text}));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into() }
    }

    fn event(json: &str) -> Vec<u8> {
        format!("event: x\ndata: {json}\n\n").into_bytes()
    }

    #[test]
    fn reads_text_deltas_and_stop() {
        let mut p = SseParser::default();
        let mut bytes = event(r#"{"type":"message_start","message":{}}"#);
        bytes.extend(event(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#));
        bytes.extend(event(r#"{"type":"ping"}"#));
        bytes.extend(event(r#"{"type":"message_stop"}"#));
        assert_eq!(p.push(&bytes), vec![Parsed::Text("Hello".into()), Parsed::Stop]);
    }

    #[test]
    fn survives_events_split_across_chunks_and_multibyte_text() {
        let full = event(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Ọ̀rẹ́ mi"}}"#);
        for cut in 1..full.len() {
            let mut p = SseParser::default();
            let mut got = p.push(&full[..cut]);
            got.extend(p.push(&full[cut..]));
            assert_eq!(got, vec![Parsed::Text("Ọ̀rẹ́ mi".into())], "cut at {cut}");
        }
    }

    #[test]
    fn handles_windows_line_endings() {
        let mut p = SseParser::default();
        let bytes = b"event: x\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n";
        assert_eq!(p.push(bytes), vec![Parsed::Stop]);
    }

    #[test]
    fn turns_error_events_into_friendly_text() {
        let mut p = SseParser::default();
        let got = p.push(&event(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#));
        assert_eq!(got, vec![Parsed::Error("Anthropic is busy right now. Try again in a moment.".into())]);
    }

    #[test]
    fn reads_a_tool_request_split_into_pieces() {
        let mut p = SseParser::default();
        let mut bytes = event(r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"open_url","input":{}}}"#);
        bytes.extend(event(r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"url\": \"https://exa"}}"#));
        bytes.extend(event(r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"mple.com\"}"}}"#));
        bytes.extend(event(r#"{"type":"content_block_stop","index":1}"#));
        bytes.extend(event(r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#));
        bytes.extend(event(r#"{"type":"message_stop"}"#));
        let got = p.push(&bytes);
        assert_eq!(
            got,
            vec![
                Parsed::ToolStart { index: 1, id: "toolu_1".into(), name: "open_url".into() },
                Parsed::ToolJson { index: 1, partial: "{\"url\": \"https://exa".into() },
                Parsed::ToolJson { index: 1, partial: "mple.com\"}".into() },
                Parsed::BlockStop(1),
                Parsed::StopReason("tool_use".into()),
                Parsed::Stop,
            ]
        );
    }

    #[test]
    fn ignores_junk() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: not json\n\n: comment\n\n").is_empty());
    }

    #[test]
    fn maps_http_errors_without_leaking_bodies() {
        assert!(http_error(401, "{}").contains("rejected"));
        assert!(http_error(429, "{}").contains("Rate limit"));
        assert!(http_error(503, "").contains("trouble"));
        let credit = r#"{"error":{"message":"Your credit balance is too low"}}"#;
        assert!(http_error(400, credit).contains("no credit"));
        assert!(http_error(418, r#"{"error":{"message":"teapot"}}"#).contains("teapot"));
    }

    #[test]
    fn checks_requests() {
        let ok = vec![msg("user", "hi"), msg("assistant", "hello"), msg("user", "more")];
        assert!(validate_request("be kind", &ok).is_ok());
        assert!(validate_request("x", &[]).is_err());
        assert!(validate_request("x", &[msg("assistant", "hi")]).is_err());
        assert!(validate_request("x", &[msg("system", "hi"), msg("user", "a")]).is_err());
        assert!(validate_request("x", &[msg("user", "   ")]).is_err());
        assert!(validate_request(&"a".repeat(12_001), &[msg("user", "a")]).is_err());
        let many: Vec<_> = (0..61).map(|_| msg("user", "a")).collect();
        assert!(validate_request("x", &many).is_err());
    }
}
