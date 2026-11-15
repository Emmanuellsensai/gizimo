// Chrome control: Gizi drives its OWN Chrome window (a separate profile, so it never touches your everyday
// browser, tabs or saved passwords). You sign in to your sites once inside that window; Gizimo never sees a password.
//
// It talks to Chrome over the DevTools protocol on 127.0.0.1 only. The checks that decide WHETHER an action may happen
// (allowed sites, approvals, kill switch) live in skills.rs. This file only knows HOW.
use std::{path::PathBuf, process::Command, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const PORT: u16 = 9333;
const READ_LIMIT: usize = 4000;

fn base() -> String {
    format!("http://127.0.0.1:{PORT}")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())
}

fn browser_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut list: Vec<PathBuf> = Vec::new();
        for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(var) {
                list.push(PathBuf::from(&root).join("Google").join("Chrome").join("Application").join("chrome.exe"));
            }
        }
        if let Ok(root) = std::env::var("PROGRAMFILES(X86)") {
            list.push(PathBuf::from(root).join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
        }
        list.into_iter().find(|p| p.is_file())
    }
    #[cfg(not(windows))]
    {
        let paths = std::env::var_os("PATH")?;
        for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
            if let Some(p) = std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file()) {
                return Some(p);
            }
        }
        None
    }
}

async fn is_up() -> bool {
    match client() {
        Ok(c) => c.get(format!("{}/json/version", base())).send().await.map(|r| r.status().is_success()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Starts Gizi's own Chrome window if it is not already running.
async fn ensure_running(app: &AppHandle) -> Result<(), String> {
    if is_up().await {
        return Ok(());
    }
    let exe = browser_exe().ok_or("Chrome was not found on this PC.")?;
    let profile = app.path().app_data_dir().map_err(|e| e.to_string())?.join("chrome-profile");
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    Command::new(exe)
        .arg(format!("--remote-debugging-port={PORT}"))
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("about:blank")
        .spawn()
        .map_err(|e| format!("Could not start Chrome: {e}"))?;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if is_up().await {
            return Ok(());
        }
    }
    Err("Chrome did not start in time.".into())
}

async fn page_socket() -> Result<String, String> {
    let c = client()?;
    let pick = |list: &Value| -> Option<String> {
        list.as_array()?.iter().find(|t| t["type"] == "page").and_then(|t| t["webSocketDebuggerUrl"].as_str().map(str::to_owned))
    };
    let list: Value = c.get(format!("{}/json/list", base())).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    if let Some(u) = pick(&list) {
        return Ok(u);
    }
    let made: Value = c.put(format!("{}/json/new?about:blank", base())).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    made["webSocketDebuggerUrl"].as_str().map(str::to_owned).ok_or_else(|| "Chrome has no page to control.".to_string())
}

/// One DevTools command: connect, send, wait for the answer, close.
async fn cdp(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(5), connect_async(url))
        .await
        .map_err(|_| "Chrome did not answer.".to_string())?
        .map_err(|e| format!("Could not reach Chrome: {e}"))?;
    let msg = json!({"id": 1, "method": method, "params": params}).to_string();
    ws.send(Message::Text(msg.into())).await.map_err(|e| e.to_string())?;
    let reply = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(frame) = ws.next().await {
            if let Ok(Message::Text(t)) = frame {
                if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                    if v["id"] == 1 {
                        return Some(v);
                    }
                }
            }
        }
        None
    })
    .await
    .map_err(|_| "Chrome took too long.".to_string())?
    .ok_or("Chrome closed the connection.")?;
    let _ = ws.close(None).await;
    if let Some(e) = reply.get("error") {
        return Err(format!("Chrome said: {}", e["message"].as_str().unwrap_or("error")));
    }
    Ok(reply["result"].clone())
}

async fn eval(url: &str, expression: &str) -> Result<Value, String> {
    let r = cdp(url, "Runtime.evaluate", json!({"expression": expression, "returnByValue": true, "awaitPromise": true})).await?;
    if r.get("exceptionDetails").is_some() {
        return Err("The page refused that.".into());
    }
    Ok(r["result"]["value"].clone())
}

/// The address of the page Gizi is looking at right now.
pub async fn current_url(app: &AppHandle) -> Result<String, String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    eval(&ws, "location.href").await?.as_str().map(str::to_owned).ok_or_else(|| "No page is open.".to_string())
}

pub async fn open(app: &AppHandle, url: &str) -> Result<(), String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    cdp(&ws, "Page.navigate", json!({"url": url})).await?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if eval(&ws, "document.readyState").await.ok().and_then(|v| v.as_str().map(|s| s == "complete")).unwrap_or(false) {
            break;
        }
    }
    Ok(())
}

/// Page address, title and the first part of its visible text. The text is information, never instructions.
pub async fn read(app: &AppHandle) -> Result<String, String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    let js = format!("location.href + '\\n' + document.title + '\\n' + (document.body ? document.body.innerText : '').slice(0, {READ_LIMIT})");
    eval(&ws, &js).await?.as_str().map(str::to_owned).ok_or_else(|| "Could not read the page.".to_string())
}

fn find_click_js(target: &str, click: bool) -> String {
    let t = serde_json::to_string(target).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
  const t = {t}.trim().toLowerCase();
  const vis = e => {{ const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }};
  const label = e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
  const all = [...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button],[data-testid]')].filter(vis);
  let m = all.filter(e => label(e).toLowerCase() === t || (e.getAttribute('aria-label') || '').toLowerCase() === t);
  if (!m.length) m = all.filter(e => label(e).toLowerCase().includes(t));
  if (m.length !== 1) return {{error: m.length ? 'More than one match (' + m.length + '). Name it more exactly.' : 'No visible button or link matches that.'}};
  const el = m[0];
  const info = {{label: label(el).slice(0, 80), tag: el.tagName, href: el.href || null}};
  if ({click}) el.click();
  return info;
}})()"#
    )
}

pub struct ClickTarget {
    pub label: String,
    pub href: Option<String>,
}

/// Finds the one button or link that matches, without clicking it, so the user can be asked first.
pub async fn resolve_click(app: &AppHandle, target: &str) -> Result<ClickTarget, String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    let v = eval(&ws, &find_click_js(target, false)).await?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_owned());
    }
    Ok(ClickTarget { label: v["label"].as_str().unwrap_or("").to_owned(), href: v["href"].as_str().filter(|s| !s.is_empty()).map(str::to_owned) })
}

pub async fn click(app: &AppHandle, target: &str) -> Result<String, String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    let v = eval(&ws, &find_click_js(target, true)).await?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_owned());
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    Ok(v["label"].as_str().unwrap_or("").to_owned())
}

/// Types into the chosen field (or the first text box on the page). Refuses password fields.
pub async fn type_text(app: &AppHandle, selector: &str, text: &str, replace: bool) -> Result<(), String> {
    ensure_running(app).await?;
    let ws = page_socket().await?;
    let sel = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        r#"(() => {{
  const vis = e => {{ const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }};
  const s = {sel};
  let el = s ? document.querySelector(s) : null;
  if (!el) {{
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) el = a;
  }}
  if (!el) el = [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox],input[type=text],input[type=search],input:not([type])')].find(vis);
  if (!el) return 'none';
  if (el.type === 'password') return 'password';
  el.focus();
  if ({replace}) {{ if (el.select) el.select(); else document.execCommand('selectAll'); }}
  return 'ok';
}})()"#
    );
    match eval(&ws, &js).await?.as_str() {
        Some("ok") => {}
        Some("password") => return Err("That is a password field. Gizi never types passwords.".into()),
        _ => return Err("No text box found on the page.".into()),
    }
    cdp(&ws, "Input.insertText", json!({"text": text})).await?;
    Ok(())
}

/// Host of an address, lower-case, for showing in approval messages.
pub fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_else(|| "an unknown site".into())
}

/// Debug builds only: runs every Chrome step against a local test page so it can be checked without a model.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn chrome_selftest(app: AppHandle) -> Result<String, String> {
    let page = "data:text/html,<title>Gizimo test</title><body><h1>Hello page</h1><textarea id=t></textarea><input type=password id=p><button onclick=\"document.title='clicked'\">Post</button><button>Post later</button>";
    open(&app, page).await?;
    let read_back = read(&app).await?;
    type_text(&app, "", "hello from gizi", false).await?;
    let pw = type_text(&app, "#p", "secret", false).await.err().unwrap_or_default();
    let dup = resolve_click(&app, "post").await.err().unwrap_or_default();
    let found = resolve_click(&app, "Post").await.map(|t| t.label)?;
    let clicked = click(&app, "Post").await?;
    let ws = page_socket().await?;
    let title = eval(&ws, "document.title").await?;
    let typed = eval(&ws, "document.getElementById('t').value").await?;
    Ok(format!("read={read_back:?} | typed={typed} | password_refused={pw} | duplicate={dup} | found={found} | clicked={clicked} | title={title}"))
}
