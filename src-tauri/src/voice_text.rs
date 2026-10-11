//! Voice, the pure part (phase 4 step 14): what the park says aloud and how a transcript
//! is tidied. No frameworks here, so it runs as a unit test on any host (host-tests).

/// One breath: the most the station voice says for one event or answer.
pub const SPEAK_MAX_CHARS: usize = 400;

/// Plain speech from text: links become "a link", markdown marks go, whitespace
/// collapses, and a long text is cut at the last sentence or clause before the limit.
pub fn speakable(text: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    for raw in text.split_whitespace() {
        let w = if raw.starts_with("http://") || raw.starts_with("https://") { "a link".to_string() } else { raw.chars().filter(|c| !matches!(c, '*' | '`' | '#' | '>' | '|')).collect::<String>() };
        if !w.is_empty() {
            words.push(w);
        }
    }
    let s = words.join(" ");
    if s.chars().count() <= SPEAK_MAX_CHARS {
        return s;
    }
    let cut: String = s.chars().take(SPEAK_MAX_CHARS).collect();
    let end = [". ", "; ", ", "].iter().filter_map(|sep| cut.rfind(sep)).max();
    match end {
        Some(i) if i > 120 => format!("{}…", &cut[..=i]),
        _ => format!("{cut}…"),
    }
}

/// A transcript as the park shows it: trimmed, whitespace collapsed, control characters
/// dropped. The recogniser's words are not changed.
pub fn tidy_transcript(text: &str) -> String {
    text.split_whitespace().map(|w| w.chars().filter(|c| !c.is_control()).collect::<String>()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakable_strips_marks_and_links() {
        assert_eq!(speakable("**Lantern Co**: 3 orders, see https://example.com/x today"), "Lantern Co: 3 orders, see a link today");
        assert_eq!(speakable("  many    spaces\n\nand lines "), "many spaces and lines");
        assert_eq!(speakable(""), "");
    }

    #[test]
    fn speakable_cuts_long_text_at_a_clause() {
        let long = format!("{}. {}", "a".repeat(200), "b".repeat(300));
        let s = speakable(&long);
        assert!(s.chars().count() <= SPEAK_MAX_CHARS + 1);
        assert!(s.ends_with("…"));
        assert!(s.starts_with(&"a".repeat(200)));
        assert_eq!(s, format!("{}.…", "a".repeat(200)));
    }

    #[test]
    fn speakable_cuts_hard_without_a_clause() {
        let s = speakable(&"x".repeat(1000));
        assert_eq!(s.chars().count(), SPEAK_MAX_CHARS + 1);
    }

    #[test]
    fn tidy_transcript_keeps_words() {
        assert_eq!(tidy_transcript("  what did\tthe Scout\u{7} find  "), "what did the Scout find");
        assert_eq!(tidy_transcript(""), "");
    }
}
