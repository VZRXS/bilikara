use regex::Regex;
use std::sync::OnceLock;

static UNSAFE_FILENAME_RE: OnceLock<Regex> = OnceLock::new();

pub(crate) fn safe_filename_impl(name: &str, fallback: &str) -> String {
    let regex = UNSAFE_FILENAME_RE.get_or_init(|| Regex::new(r"[^A-Za-z0-9_.-]+").unwrap());
    let normalized = regex.replace_all(name, "-");
    let normalized = normalized.trim_matches(['.', '-']);
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_cases() {
        let long_name = format!("{}.zip", "a".repeat(300));
        let cases = [
            ("bilikara-v0.7.0.zip", "fallback.zip", "bilikara-v0.7.0.zip"),
            ("歌ってみた.zip", "fallback.zip", "zip"),
            ("卡拉OK更新包.zip", "fallback.zip", "OK-.zip"),
            ("karaoke🎤mix.zip", "fallback.zip", "karaoke-mix.zip"),
            ("bad<>:\"/\\|?*name.zip", "fallback.zip", "bad-name.zip"),
            ("  update.zip  ", "fallback.zip", "update.zip"),
            ("part///name.zip", "fallback.zip", "part-name.zip"),
            ("CON", "fallback.zip", "CON"),
            ("...", "fallback.zip", "fallback.zip"),
            ("abc\0def.zip", "fallback.zip", "abc-def.zip"),
            (
                "unchanged_name-1.2.zip",
                "fallback.zip",
                "unchanged_name-1.2.zip",
            ),
        ];
        for (name, fallback, expected) in cases {
            assert_eq!(safe_filename_impl(name, fallback), expected);
        }
        assert_eq!(safe_filename_impl(&long_name, "fallback.zip"), long_name);
    }
}
