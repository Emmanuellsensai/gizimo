// The Anthropic API key lives in the Windows Credential Manager. The web side can ask whether a key exists, save
// one, or remove it. It can never read the key back: only llm.rs reads it, inside Rust.
use keyring::Entry;

const SERVICE: &str = "gizimo";
const ACCOUNT: &str = "anthropic-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Could not open the secure key store: {e}"))
}

/// Used only by llm.rs. Never expose this through a command.
pub fn get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the saved key: {e}")),
    }
}

pub fn valid_shape(key: &str) -> bool {
    key.starts_with("sk-ant-")
        && (20..=300).contains(&key.len())
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[tauri::command]
pub fn key_status() -> Result<bool, String> {
    Ok(get()?.is_some())
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if !valid_shape(key) {
        return Err("That does not look like an Anthropic API key. It should start with sk-ant-.".into());
    }
    entry()?
        .set_password(key)
        .map_err(|e| format!("Could not save the key: {e}"))
}

#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the key: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::valid_shape;

    #[test]
    fn accepts_key_shaped_strings_only() {
        assert!(valid_shape("sk-ant-api03-abcDEF123_456-xyzxyzxyz"));
        assert!(!valid_shape("sk-ant-short"));
        assert!(!valid_shape("sk-other-abcdefghijklmnopqrstuvwxyz"));
        assert!(!valid_shape("sk-ant-has space in it 1234567890"));
        assert!(!valid_shape(&format!("sk-ant-{}", "a".repeat(400))));
        assert!(!valid_shape(""));
    }
}
