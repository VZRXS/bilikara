use regex::Regex;
use std::sync::OnceLock;

static FULLWIDTH_BRACKET_RE: OnceLock<Regex> = OnceLock::new();
static EDGE_SEPARATOR_RE: OnceLock<Regex> = OnceLock::new();
static MULTISPACE_RE: OnceLock<Regex> = OnceLock::new();
static KARAOKE_TAGS_RE: OnceLock<Regex> = OnceLock::new();
static BRACKET_BLOCK_RE: OnceLock<Regex> = OnceLock::new();

fn init_regexes() {
    FULLWIDTH_BRACKET_RE.get_or_init(|| Regex::new(r"【[^】]*】").unwrap());
    EDGE_SEPARATOR_RE.get_or_init(|| Regex::new(r"^[\s\-|｜/:：]+|[\s\-|｜/:：]+$").unwrap());
    MULTISPACE_RE.get_or_init(|| Regex::new(r"\s+").unwrap());

    let keywords = r"(?i)\s*[\s/|\\、，,\-]*\s*(?:ニコカラ|カラオケ|Aegisub|びりから|ビリカラ|纯k投屏|ktv导唱字幕|ktv字幕|导唱字幕|卡拉OK字幕|卡拉OK|导唱|字幕|on/off vocal|on/off|自用|无损|Hi-Res|flac|\d+kHz|\d+bit|1080p|4k|UHD|60帧|60fps|mv|pv)\s*[\s/|\\、，,\-]*\s*";
    KARAOKE_TAGS_RE.get_or_init(|| Regex::new(keywords).unwrap());
    BRACKET_BLOCK_RE.get_or_init(|| Regex::new(r"([\[\(『<〈《](.*?)[\]\)』>〉》])").unwrap());
}

fn remove_part_suffix(display_title: &str, part_title: &str) -> String {
    let normalized_display = display_title.trim();
    let normalized_part = part_title.trim();
    if normalized_display.is_empty() || normalized_part.is_empty() {
        return normalized_display.to_string();
    }

    let suffix = format!(" - {}", normalized_part);
    if normalized_display.ends_with(&suffix) {
        let len_without_suffix = normalized_display.len() - suffix.len();
        normalized_display[..len_without_suffix]
            .trim_end()
            .to_string()
    } else {
        normalized_display.to_string()
    }
}

pub(crate) fn clean_display_title_impl(
    title: &str,
    display_title: &str,
    part_title: &str,
) -> String {
    init_regexes();

    let title_sanitized = title.replace('\0', "");
    let display_title_sanitized = display_title.replace('\0', "");
    let part_title_sanitized = part_title.replace('\0', "");

    let base_title = title_sanitized.trim();
    let fallback_title = remove_part_suffix(&display_title_sanitized, &part_title_sanitized);
    let candidate = if !base_title.is_empty() {
        base_title
    } else if !fallback_title.is_empty() {
        &fallback_title
    } else {
        display_title_sanitized.trim()
    };

    let cleaned = FULLWIDTH_BRACKET_RE
        .get()
        .unwrap()
        .replace_all(candidate, " ");
    let cleaned =
        BRACKET_BLOCK_RE
            .get()
            .unwrap()
            .replace_all(&cleaned, |caps: &regex::Captures| {
                let full_block = &caps[1];
                let inner_content = &caps[2];

                let cleaned_inner = KARAOKE_TAGS_RE
                    .get()
                    .unwrap()
                    .replace_all(inner_content, "");
                let cleaned_inner = EDGE_SEPARATOR_RE
                    .get()
                    .unwrap()
                    .replace_all(&cleaned_inner, "");
                let cleaned_inner = cleaned_inner.trim();

                if cleaned_inner.is_empty() {
                    " ".to_string()
                } else {
                    let first_char = full_block.chars().next().unwrap_or('[');
                    let last_char = full_block.chars().last().unwrap_or(']');
                    format!("{}{}{}", first_char, cleaned_inner, last_char)
                }
            });

    let cleaned = MULTISPACE_RE.get().unwrap().replace_all(&cleaned, " ");
    let cleaned = cleaned.trim();
    let cleaned = EDGE_SEPARATOR_RE.get().unwrap().replace_all(cleaned, "");
    let cleaned = cleaned.trim();

    if cleaned.is_empty() {
        candidate.trim().to_string()
    } else {
        cleaned.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_display_title_cases() {
        assert_eq!(clean_display_title_impl("【ニコカラ】歌词", "", ""), "歌词");
        assert_eq!(
            clean_display_title_impl("【纯k投屏】七里香 卡拉OK字幕 1080p", "", ""),
            "七里香 卡拉OK字幕 1080p"
        );
        assert_eq!(
            clean_display_title_impl(
                "ニコカラ Aegisub びりから on/off vocal 无损 1080p mv",
                "",
                ""
            ),
            "ニコカラ Aegisub びりから on/off vocal 无损 1080p mv"
        );
        assert_eq!(
            clean_display_title_impl(
                "[Aegisub] (KTV) 『字幕』 <60fps> 〈无损〉 《Hi-Res》",
                "",
                ""
            ),
            "(KTV)"
        );
        assert_eq!(
            clean_display_title_impl("【ニコカラ】丸の内サディスティック [on vocal]", "", ""),
            "丸の内サディスティック [on vocal]"
        );
        assert_eq!(
            clean_display_title_impl("【卡拉OK】七里香", "", ""),
            "七里香"
        );
        assert_eq!(
            clean_display_title_impl("", "My Display Title", ""),
            "My Display Title"
        );
        assert_eq!(clean_display_title_impl("", "歌名 - P2", "P2"), "歌名");
        assert_eq!(
            clean_display_title_impl("歌名 - / \\ 、 ， , - 纯k", "", ""),
            "歌名 - / \\ 、 ， , - 纯k"
        );
        assert_eq!(clean_display_title_impl("abc\0def", "", ""), "abcdef");
        assert_eq!(
            clean_display_title_impl("【ニコカラ\0】歌词", "", ""),
            "歌词"
        );
    }
}
