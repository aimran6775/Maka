//! Computer control, the pure part (phase 4 step 18): the sensitive-app list the shell
//! keeps as its own lock beside the sidecar's (sidecar/computer/policy.js), key chords to
//! virtual key codes and flags, and the accessibility-tree matcher. No frameworks here, so
//! it runs as a unit test on any host (host-tests).

/// Bundle id prefixes of apps a Ranger never drives: the shell refuses to act in them even
/// if the sidecar's list were ever out of step.
pub const SENSITIVE_BUNDLE_IDS: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.Terminal",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.Console",
    "com.googlecode.iterm2",
    "dev.warp.Warp",
    "co.zeit.hyper",
    "com.github.wez.wezterm",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.agilebits.onepassword",
    "com.1password",
    "com.bitwarden",
    "com.lastpass",
    "com.dashlane",
    "org.keepassxc",
    "com.nordpass",
    "com.enpass",
    "com.apple.Wallet",
    "com.paypal",
    "com.venmo",
    "com.squareup.cash",
    "com.coinbase",
    "com.binance",
    "com.robinhood",
    "com.revolut",
    "co.uk.getmondo",
    "com.transferwise",
    "com.wise",
];

/// Words in an app's name that mark it sensitive (matched as whole words, case-insensitive).
pub const SENSITIVE_NAME_WORDS: &[&str] = &[
    "system settings", "system preferences", "terminal", "iterm", "warp", "hyper", "wezterm", "kitty", "alacritty", "console", "keychain access", "passwords", "1password", "bitwarden", "lastpass", "dashlane", "keepass", "nordpass", "enpass", "wallet", "bank", "banking", "paypal", "venmo", "cash app", "coinbase", "binance", "robinhood", "revolut", "monzo", "wise",
];

/// Is this app one a Ranger never drives? Returns the reason when it is.
pub fn sensitive_reason(bundle_id: &str, name: &str) -> Option<String> {
    let id = bundle_id.to_ascii_lowercase();
    for prefix in SENSITIVE_BUNDLE_IDS {
        let p = prefix.to_ascii_lowercase();
        if id == p || id.starts_with(&format!("{p}.")) {
            return Some(format!("{} ({}) is on the list of apps a Ranger never drives", if name.is_empty() { bundle_id } else { name }, bundle_id));
        }
    }
    let lower = name.to_ascii_lowercase();
    for word in SENSITIVE_NAME_WORDS {
        if contains_word(&lower, word) {
            return Some(format!("{name} is on the list of apps a Ranger never drives ({word})"));
        }
    }
    None
}

/// `word` appears in `text` with non-letters (or the ends) around it.
fn contains_word(text: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = text[start..].find(word) {
        let at = start + pos;
        let end = at + word.len();
        let before_ok = at == 0 || !text[..at].chars().next_back().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
        let after_ok = end >= text.len() || !text[end..].chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        start = at + 1;
    }
    false
}

/// A parsed chord: the modifier flags as CGEvent flag bits and the virtual key code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
    pub function: bool,
    pub key_code: u16,
    pub key: String,
}

/// US-layout virtual key codes (Carbon's kVK_*), the ones a chord may name.
pub fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "a" => 0x00, "s" => 0x01, "d" => 0x02, "f" => 0x03, "h" => 0x04, "g" => 0x05, "z" => 0x06, "x" => 0x07, "c" => 0x08, "v" => 0x09,
        "b" => 0x0B, "q" => 0x0C, "w" => 0x0D, "e" => 0x0E, "r" => 0x0F, "y" => 0x10, "t" => 0x11, "1" => 0x12, "2" => 0x13, "3" => 0x14,
        "4" => 0x15, "6" => 0x16, "5" => 0x17, "=" => 0x18, "9" => 0x19, "7" => 0x1A, "-" => 0x1B, "8" => 0x1C, "0" => 0x1D, "]" => 0x1E,
        "o" => 0x1F, "u" => 0x20, "[" => 0x21, "i" => 0x22, "p" => 0x23, "return" => 0x24, "l" => 0x25, "j" => 0x26, "'" => 0x27, "k" => 0x28,
        ";" => 0x29, "\\" => 0x2A, "," => 0x2B, "/" => 0x2C, "n" => 0x2D, "m" => 0x2E, "." => 0x2F, "tab" => 0x30, "space" => 0x31, "`" => 0x32,
        "delete" => 0x33, "escape" => 0x35, "f5" => 0x60, "f6" => 0x61, "f7" => 0x62, "f3" => 0x63, "f8" => 0x64, "f9" => 0x65, "f11" => 0x67,
        "f10" => 0x6D, "f12" => 0x6F, "home" => 0x73, "pageup" => 0x74, "f4" => 0x76, "end" => 0x77, "f2" => 0x78, "pagedown" => 0x79, "f1" => 0x7A,
        "left" => 0x7B, "right" => 0x7C, "down" => 0x7D, "up" => 0x7E,
        _ => return None,
    })
}

/// "cmd+shift+s" -> a Chord; the sidecar validated it already, this is the second reading.
pub fn parse_chord(modifiers: &[String], key: &str) -> Result<Chord, String> {
    let key = match key.to_ascii_lowercase().as_str() {
        "enter" => "return".to_string(),
        "esc" => "escape".to_string(),
        "backspace" => "delete".to_string(),
        k => k.to_string(),
    };
    let key_code = key_code(&key).ok_or_else(|| format!("\"{key}\" is not a key the shell can press"))?;
    let mut chord = Chord { command: false, control: false, option: false, shift: false, function: false, key_code, key };
    for m in modifiers {
        match m.to_ascii_lowercase().as_str() {
            "command" | "cmd" | "meta" => chord.command = true,
            "control" | "ctrl" => chord.control = true,
            "option" | "alt" | "opt" => chord.option = true,
            "shift" => chord.shift = true,
            "function" | "fn" => chord.function = true,
            other => return Err(format!("\"{other}\" is not a modifier")),
        }
    }
    Ok(chord)
}

/// CGEvent flag bits for the chord (kCGEventFlagMask*).
pub fn chord_flags(c: &Chord) -> u64 {
    let mut f = 0u64;
    if c.shift {
        f |= 1 << 17;
    }
    if c.control {
        f |= 1 << 18;
    }
    if c.option {
        f |= 1 << 19;
    }
    if c.command {
        f |= 1 << 20;
    }
    if c.function {
        f |= 1 << 23;
    }
    f
}

/// One node of the flattened accessibility tree, as the shell reports it to the sidecar.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AxNode {
    pub id: String,
    pub role: String,
    pub title: String,
    pub value: String,
    pub description: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The nodes whose title, value or description contain the query (case-insensitive), or
/// whose role is the query. The sidecar matches again; this keeps the wire small.
pub fn locate(nodes: &[AxNode], query: &str, max: usize) -> Vec<AxNode> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for n in nodes {
        let hay = format!("{} {} {}", n.title, n.value, n.description).to_lowercase();
        if n.role.to_lowercase() == q || hay.contains(&q) {
            out.push(n.clone());
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// The halt hotkey as the shell registers it (⌃⌥⌘H).
pub const HALT_HOTKEY_LABEL: &str = "⌃⌥⌘H";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_apps_match_by_bundle_prefix_and_name_word() {
        assert!(sensitive_reason("com.apple.systempreferences", "System Settings").is_some());
        assert!(sensitive_reason("com.1password.1password", "1Password").is_some());
        assert!(sensitive_reason("com.example.mybank", "My Bank").is_some());
        assert!(sensitive_reason("com.apple.Safari", "Safari").is_none());
        assert!(sensitive_reason("com.walletwise.notes", "Walletwise Notes").is_none(), "a word inside a word is not a match");
        assert!(sensitive_reason("", "").is_none());
        assert_eq!(sensitive_reason("com.apple.Terminal", "Terminal").unwrap(), "Terminal (com.apple.Terminal) is on the list of apps a Ranger never drives");
    }

    #[test]
    fn chords_parse_to_key_codes_and_flags() {
        let c = parse_chord(&["command".into(), "shift".into()], "s").unwrap();
        assert_eq!(c.key_code, 0x01);
        assert!(c.command && c.shift && !c.option);
        assert_eq!(chord_flags(&c), (1 << 20) | (1 << 17));
        assert_eq!(parse_chord(&[], "Enter").unwrap().key_code, 0x24);
        assert_eq!(parse_chord(&[], "esc").unwrap().key, "escape");
        assert!(parse_chord(&["hyper".into()], "s").is_err());
        assert!(parse_chord(&[], "eject").is_err());
        assert_eq!(chord_flags(&parse_chord(&["fn".into()], "f1").unwrap()), 1 << 23);
    }

    #[test]
    fn locate_matches_text_and_role() {
        let nodes = vec![
            AxNode { id: "1".into(), role: "AXButton".into(), title: "Save".into(), value: "".into(), description: "".into(), x: 1.0, y: 2.0, w: 3.0, h: 4.0 },
            AxNode { id: "2".into(), role: "AXTextField".into(), title: "Search".into(), value: "lanterns".into(), description: "".into(), x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
        ];
        assert_eq!(locate(&nodes, "save", 10).len(), 1);
        assert_eq!(locate(&nodes, "LANTERNS", 10)[0].id, "2");
        assert_eq!(locate(&nodes, "axbutton", 10)[0].id, "1");
        assert!(locate(&nodes, "  ", 10).is_empty());
        assert_eq!(locate(&nodes, "a", 1).len(), 1);
    }
}
