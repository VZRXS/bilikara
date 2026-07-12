use regex::Regex;
use std::sync::OnceLock;

static VERSION_RE: OnceLock<Regex> = OnceLock::new();

pub(crate) fn normalize_version_tag_impl(version: &str) -> String {
    version.trim().to_string()
}

pub(crate) fn version_tuple_impl(version: &str) -> Option<[String; 3]> {
    let regex = VERSION_RE
        .get_or_init(|| Regex::new(r"(?i)^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$").unwrap());
    let normalized = normalize_version_tag_impl(version);
    let captures = regex.captures(&normalized)?;
    Some([
        captures.get(1)?.as_str().to_string(),
        captures.get(2)?.as_str().to_string(),
        captures.get(3)?.as_str().to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_version_tags() {
        assert_eq!(normalize_version_tag_impl("  v0.7.0  "), "v0.7.0");
        assert_eq!(normalize_version_tag_impl("dev"), "dev");
        assert_eq!(normalize_version_tag_impl(""), "");
    }

    #[test]
    fn parses_supported_version_tuples() {
        assert_eq!(
            version_tuple_impl("v0.7.0"),
            Some(["0".to_string(), "7".to_string(), "0".to_string()])
        );
        assert_eq!(
            version_tuple_impl("  10.20.30-preview.4  "),
            Some(["10".to_string(), "20".to_string(), "30".to_string()])
        );
        assert_eq!(
            version_tuple_impl("V1.2.3-PREVIEW.9"),
            Some(["1".to_string(), "2".to_string(), "3".to_string()])
        );
        assert_eq!(version_tuple_impl("v0.7.0-2-gabcdef"), None);
        assert_eq!(version_tuple_impl("dev"), None);
    }

    #[test]
    fn preserves_arbitrarily_large_numeric_fields() {
        assert_eq!(
            version_tuple_impl("v999999999999999999999.2.3"),
            Some([
                "999999999999999999999".to_string(),
                "2".to_string(),
                "3".to_string(),
            ])
        );
    }
}
