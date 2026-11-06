//! lib/shared/gzm-stop-key.ts

/// A GZM pole's name without its post number: "Pszczelnik Park 02", "... Pętla Zach. 1t", "Katowice Sądowa 1A".
/// The TS is `name.replace(/\s\d{1,2}[a-z]?$/i, "")`: a whitespace, 1-2 digits, an optional ASCII letter, the end.
pub fn gzm_stop_key(name: &str) -> &str {
    let b = name.as_bytes();
    let mut end = b.len();
    if end > 0 && b[end - 1].is_ascii_alphabetic() {
        end -= 1;
    }
    let digits = b[..end].iter().rev().take_while(|c| c.is_ascii_digit()).count();
    if !(1..=2).contains(&digits) {
        return name;
    }
    let head = &name[..end - digits];
    match head.chars().next_back() {
        Some(c) if crate::js::is_space(c) => &head[..head.len() - c.len_utf8()],
        _ => name,
    }
}
