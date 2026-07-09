pub(crate) fn is_downloadable_archive(name: &str, url: &str) -> bool {
    let name = name.trim().to_lowercase();
    let url = url.trim().to_lowercase();
    if url.is_empty() {
        return false;
    }
    if [".sha256", ".sha256sum", ".sig", ".asc", ".txt"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
    {
        return false;
    }
    name.ends_with(".zip") || url.split('?').next().unwrap_or_default().ends_with(".zip")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_downloadable_zip_assets() {
        let cases = [
            ("bilikara.zip", "https://example/bilikara.zip", true),
            ("BILIKARA.ZIP", "https://example/download", true),
            ("download", "https://example/bilikara.zip?token=1", true),
            ("bilikara.zip.sha256", "https://example/file.zip", false),
            ("bilikara.sig", "https://example/file.zip", false),
            ("bilikara.txt", "https://example/file.zip", false),
            ("bilikara.tar.gz", "https://example/file.tar.gz", false),
            ("bilikara.zip", "", false),
            ("歌曲.zip", "https://example/download", true),
        ];
        for (name, url, expected) in cases {
            assert_eq!(is_downloadable_archive(name, url), expected);
        }
    }
}
