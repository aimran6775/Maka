//! Computer control, the pure part (phase 4 step 18): the sensitive-app list the shell
//! keeps as its own lock beside the sidecar's (sidecar/computer/policy.js), key chords to
//! virtual key codes and flags, and the accessibility-tree matcher. No frameworks here, so
//! it runs as a unit test on any host (host-tests).

/// Maka's own bundle id (tauri.conf.json): the first app a Ranger never drives, because a
/// Ranger that could focus Maka could click its own Gate items (safety 2026-10-11 H2).
pub const MAKA_BUNDLE_ID: &str = "com.makapark.maka";

/// Bundle id prefixes of apps a Ranger never drives: the shell refuses to act in them even
/// if the sidecar's list were ever out of step. Browsers are on it: the web is driven
/// through the sidecar's browser tools, which carry the outbound guard and the payment
/// handoff; a browser driven by clicks and keys would carry neither (H2).
pub const SENSITIVE_BUNDLE_IDS: &[&str] = &[
    MAKA_BUNDLE_ID,
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview",
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "org.chromium.Chromium",
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
    "company.thebrowser.Browser",
    "com.kagi.kagimacOS",
    "org.torproject.torbrowser",
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
    "maka", "safari", "chrome", "chromium", "firefox", "edge", "brave", "opera", "vivaldi", "arc", "orion", "tor browser",
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

/// Hosts a front window may never show: a title or URL naming one is a local web UI, which
/// may be Maka's own (safety 2026-10-11 H2). The sidecar applies the same rule
/// (policy.js namesLoopback) with its own host:port added.
pub const LOOPBACK_HOSTS: &[&str] = &["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"];

/// Does this window title or URL name a loopback host (or one of `own_hosts`, the
/// sidecar's own host:port strings)? Returns the host that matched.
pub fn loopback_host_in(text: &str, own_hosts: &[String]) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    let boundary = |c: Option<char>| !matches!(c, Some(c) if c.is_ascii_alphanumeric() || c == '.' || c == '-');
    for host in LOOPBACK_HOSTS {
        let mut start = 0;
        while let Some(pos) = lower[start..].find(host) {
            let at = start + pos;
            let end = at + host.len();
            if boundary(lower[..at].chars().next_back()) && boundary(lower[end..].chars().next()) {
                return Some((*host).to_string());
            }
            start = at + 1;
        }
    }
    // 127.x.y.z beyond 127.0.0.1 and *.local names.
    for token in lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        if token.starts_with("127.") && token.split('.').count() == 4 && token.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            return Some(token.to_string());
        }
        if token.len() > 6 && token.ends_with(".local") {
            return Some(token.to_string());
        }
    }
    for own in own_hosts {
        if !own.is_empty() && lower.contains(&own.to_ascii_lowercase()) {
            return Some(own.clone());
        }
    }
    None
}

/// The reason a front window may not be driven, or None: a title or URL naming a loopback
/// host (Maka's own UI, or any local web UI).
pub fn loopback_window_reason(title: &str, url: &str, own_hosts: &[String]) -> Option<String> {
    if let Some(h) = loopback_host_in(url, own_hosts) {
        return Some(format!("the window in front (url names {h}) shows a local web UI, which may be Maka's own; a Ranger never drives it"));
    }
    if let Some(h) = loopback_host_in(title, own_hosts) {
        return Some(format!("the window in front (title names {h}) shows a local web UI, which may be Maka's own; a Ranger never drives it"));
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
        assert!(sensitive_reason("com.apple.Safari", "Safari").is_some(), "a browser is driven through the browser tools only (safety 2026-10-11 H2)");
        assert!(sensitive_reason("com.google.Chrome", "Google Chrome").is_some());
        assert!(sensitive_reason("com.apple.Notes", "Notes").is_none());
        assert!(sensitive_reason("com.walletwise.notes", "Walletwise Notes").is_none(), "a word inside a word is not a match");
        assert!(sensitive_reason("", "").is_none());
        assert_eq!(sensitive_reason("com.apple.Terminal", "Terminal").unwrap(), "Terminal (com.apple.Terminal) is on the list of apps a Ranger never drives");
    }

    #[test]
    fn maka_itself_is_never_driven_and_nor_is_a_loopback_window() {
        // Safety 2026-10-11 H2: a Ranger could otherwise focus Maka and click its own Gate items.
        assert_eq!(MAKA_BUNDLE_ID, "com.makapark.maka");
        assert_eq!(sensitive_reason("com.makapark.maka", "Maka").unwrap(), "Maka (com.makapark.maka) is on the list of apps a Ranger never drives");
        assert!(sensitive_reason("com.makapark.maka.dev", "").is_some(), "a bundle id under Maka's");
        assert!(sensitive_reason("com.example.other", "Maka").is_some(), "the name alone");
        assert!(sensitive_reason("com.example.other", "Makaroni").is_none(), "a word inside a word is not a match");
        let none: [String; 0] = [];
        assert_eq!(loopback_host_in("Maka — 127.0.0.1:4777", &none).as_deref(), Some("127.0.0.1"));
        assert_eq!(loopback_host_in("http://localhost:4777/park", &none).as_deref(), Some("localhost"));
        assert_eq!(loopback_host_in("http://[::1]:4777/", &none).as_deref(), Some("[::1]"));
        assert_eq!(loopback_host_in("http://127.1.2.3/", &none).as_deref(), Some("127.1.2.3"));
        assert_eq!(loopback_host_in("http://studio.local/", &none).as_deref(), Some("studio.local"));
        assert_eq!(loopback_host_in("https://example.com/localhosting", &none), None, "a word inside a word is not a host");
        assert_eq!(loopback_host_in("Notes", &none), None);
        assert_eq!(loopback_host_in("", &none), None);
        let own = ["192.168.1.9:4777".to_string()];
        assert_eq!(loopback_host_in("Maka 192.168.1.9:4777", &own).as_deref(), Some("192.168.1.9:4777"));
        assert!(loopback_window_reason("Shopping list", "", &none).is_none());
        assert!(loopback_window_reason("Maka", "http://127.0.0.1:4777/", &none).unwrap().contains("url names 127.0.0.1"));
        assert!(loopback_window_reason("localhost:3000 — dashboard", "", &none).unwrap().contains("title names localhost"));
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
