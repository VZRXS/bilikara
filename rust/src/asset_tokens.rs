use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

static TOKEN_RE: OnceLock<Regex> = OnceLock::new();

pub(crate) fn asset_tokens(text: &str) -> HashSet<String> {
    TOKEN_RE
        .get_or_init(|| Regex::new(r"[^a-z0-9]+").unwrap())
        .split(&text.to_lowercase())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}
fn any(tokens: &HashSet<String>, values: &[&str]) -> bool {
    values.iter().any(|v| tokens.contains(*v))
}
pub(crate) fn has_windows(t: &HashSet<String>) -> bool {
    any(t, &["windows", "window", "win", "win32", "win64"])
}
pub(crate) fn has_macos(t: &HashSet<String>) -> bool {
    any(t, &["macos", "mac", "darwin", "osx", "app"])
}
pub(crate) fn has_linux(t: &HashSet<String>) -> bool {
    t.contains("linux")
}
pub(crate) fn has_x64(text: &str, t: &HashSet<String>) -> bool {
    text.contains("x86_64") || any(t, &["x64", "amd64", "win64"])
}
pub(crate) fn has_arm64(t: &HashSet<String>) -> bool {
    any(t, &["arm64", "aarch64"])
}
pub(crate) fn has_universal(t: &HashSet<String>) -> bool {
    any(t, &["universal", "universal2"])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifications() {
        let cases = [
            (
                "bilikara-windows-x64.zip",
                true,
                false,
                false,
                true,
                false,
                false,
            ),
            ("bilikara-win64.zip", true, false, false, true, false, false),
            (
                "bilikara-windows-arm64.zip",
                true,
                false,
                false,
                false,
                true,
                false,
            ),
            (
                "bilikara-macos-arm64.zip",
                false,
                true,
                false,
                false,
                true,
                false,
            ),
            (
                "bilikara-darwin-aarch64.zip",
                false,
                true,
                false,
                false,
                true,
                false,
            ),
            (
                "bilikara-macos-universal2.zip",
                false,
                true,
                false,
                false,
                false,
                true,
            ),
            (
                "bilikara-linux-x86_64.zip",
                false,
                false,
                true,
                true,
                false,
                false,
            ),
            ("app.zip", false, true, false, false, false, false),
            ("unknown.zip", false, false, false, false, false, false),
            ("WIN32.ZIP", true, false, false, false, false, false),
            ("", false, false, false, false, false, false),
            ("歌曲", false, false, false, false, false, false),
        ];
        for (s, w, m, l, x, a, u) in cases {
            let t = asset_tokens(s);
            assert_eq!(
                (
                    has_windows(&t),
                    has_macos(&t),
                    has_linux(&t),
                    has_x64(&s.to_lowercase(), &t),
                    has_arm64(&t),
                    has_universal(&t)
                ),
                (w, m, l, x, a, u)
            );
        }
    }
}
