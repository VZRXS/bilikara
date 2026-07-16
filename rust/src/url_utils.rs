fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub(crate) fn release_list_api_from_latest(api_url: &str) -> String {
    let url = api_url.trim();
    url.strip_suffix("/latest")
        .map(str::to_string)
        .unwrap_or_default()
}

pub(crate) fn format_download_proxy_url(proxy: &str, url: &str) -> String {
    let proxy = proxy.trim();
    let url = url.trim();
    if proxy.is_empty() || url.is_empty() {
        return String::new();
    }

    if proxy.contains("{url_encoded}") {
        return proxy.replace("{url_encoded}", &percent_encode(url));
    }
    if proxy.contains("{url}") {
        return proxy.replace("{url}", url);
    }

    let separator = if proxy.ends_with(['/', '=', '?', '&']) {
        ""
    } else {
        "/"
    };
    format!("{proxy}{separator}{url}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_release_list_urls() {
        assert_eq!(
            release_list_api_from_latest(" https://api.example/releases/latest "),
            "https://api.example/releases"
        );
        assert_eq!(release_list_api_from_latest("https://example/latest/"), "");
        assert_eq!(release_list_api_from_latest(""), "");
    }

    #[test]
    fn formats_proxy_urls() {
        assert_eq!(
            format_download_proxy_url("https://proxy/{url}", " https://example/a.zip "),
            "https://proxy/https://example/a.zip"
        );
        assert_eq!(
            format_download_proxy_url(
                "https://proxy/?target={url_encoded}",
                "https://example/歌曲 a.zip?x=1&y=2"
            ),
            "https://proxy/?target=https%3A%2F%2Fexample%2F%E6%AD%8C%E6%9B%B2%20a.zip%3Fx%3D1%26y%3D2"
        );
        assert_eq!(
            format_download_proxy_url("https://proxy", "https://example/a.zip"),
            "https://proxy/https://example/a.zip"
        );
        assert_eq!(format_download_proxy_url("", "https://example/a.zip"), "");
    }
}
