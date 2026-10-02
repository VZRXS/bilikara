//! Source identity and quick-request policy, independent of network and state.
mod wire;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum MediaSource {
    #[default]
    Bilibili,
    YouTube {
        video_id: String,
    },
}

impl MediaSource {
    /// Extract one video identity from a URL or pasted share text. Only the
    /// validated eleven-character ID reaches network/download services.
    pub fn youtube_input(input: &str) -> Result<Option<Self>, &'static str> {
        let links = regex::Regex::new(
            r#"(?i)(?:[a-z][a-z0-9+.-]*://|(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/)[A-Za-z0-9:/?&=#.%_+~@!$*\\-]+"#,
        )
        .expect("constant video-link expression");
        let mut selected = None;
        let mut invalid_youtube = false;
        for candidate in links.find_iter(input) {
            // Do not recognize a suffix inside another hostname, URL or email.
            if input[..candidate.start()]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || "_-.@/=?&#%".contains(c))
            {
                continue;
            }
            let link = candidate
                .as_str()
                .trim_end_matches(['.', ',', '!', ';', ')', ']', '}', '>', '\'', '"']);
            // ASCII quotation/bracket delimiters can border a shared URL too.
            let link = link.split(['<', '>', '"', '\'']).next().unwrap_or("");
            match youtube_link(link) {
                Ok(Some(source)) => {
                    if selected
                        .as_ref()
                        .is_some_and(|previous| previous != &source)
                    {
                        return Err("Multiple YouTube videos found; paste one video link");
                    }
                    selected = Some(source);
                }
                Err(_) => invalid_youtube = true,
                Ok(None) => {}
            }
        }
        if selected.is_some() || !invalid_youtube {
            Ok(selected)
        } else {
            Err("Invalid YouTube video link")
        }
    }

    // Retain the existing public Rust entry point for callers using watch URLs.
    pub fn youtube_watch(input: &str) -> Result<Option<Self>, &'static str> {
        Self::youtube_input(input)
    }

    pub fn canonical_url(&self) -> Option<String> {
        match self {
            Self::Bilibili => None,
            Self::YouTube { video_id } => {
                Some(format!("https://www.youtube.com/watch?v={video_id}"))
            }
        }
    }

    pub fn is_bilibili(&self) -> bool {
        matches!(self, Self::Bilibili)
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Bilibili => true,
            Self::YouTube { video_id } => valid_youtube_id(video_id),
        }
    }
}

fn youtube_link(input: &str) -> Result<Option<MediaSource>, &'static str> {
    let (scheme, rest) = input.split_once("://").unwrap_or(("https", input));
    let (authority, tail) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let host = host.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "youtube.com"
            | "www.youtube.com"
            | "m.youtube.com"
            | "music.youtube.com"
            | "youtu.be"
            | "www.youtu.be"
            | "youtube-nocookie.com"
            | "www.youtube-nocookie.com"
    ) {
        return Ok(None);
    }
    let error = "Invalid YouTube video link";
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http"))
        || !authority.eq_ignore_ascii_case(&host)
        || input.contains('\\')
    {
        return Err(error);
    }
    let tail = tail.split('#').next().unwrap_or("");
    let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
    let id = if matches!(host.as_str(), "youtu.be" | "www.youtu.be") {
        path
    } else if path == "watch" && !host.ends_with("youtube-nocookie.com") {
        let mut ids = query.split('&').filter_map(|pair| pair.strip_prefix("v="));
        let id = ids.next().ok_or(error)?;
        if ids.next().is_some() {
            return Err(error);
        }
        id
    } else {
        let (kind, id) = path.split_once('/').ok_or(error)?;
        if !matches!(kind, "shorts" | "live" | "embed" | "v")
            || (host.ends_with("youtube-nocookie.com") && kind != "embed")
        {
            return Err(error);
        }
        id
    };
    if !valid_youtube_id(id) {
        return Err(error);
    }
    Ok(Some(MediaSource::YouTube {
        video_id: id.to_owned(),
    }))
}

pub fn valid_youtube_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_links_and_shared_text_follow_the_cross_client_fixtures() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/youtube_inputs.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let actual = MediaSource::youtube_input(input);
            if case["error"] == true {
                assert!(actual.is_err(), "{input}: {actual:?}");
            } else {
                let expected = case["video_id"].as_str().map(|id| MediaSource::YouTube {
                    video_id: id.into(),
                });
                assert_eq!(actual, Ok(expected), "{input}");
            }
        }
    }

    #[test]
    fn watch_is_canonical_and_never_enqueues_a_playlist() {
        let source = MediaSource::youtube_watch(
            "https://m.youtube.com/watch?v=YE7VzlLtp-4&list=RDxxx&radio=1&start_radio=1&t=35#x",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            source.canonical_url().as_deref(),
            Some("https://www.youtube.com/watch?v=YE7VzlLtp-4")
        );
        assert_eq!(MediaSource::youtube_watch("BV1xx411c7mD"), Ok(None));
        for input in [
            "https://www.youtube.com/watch?v=bad",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4&v=abcdefghijk",
            "https://www.youtube.com/playlist?list=xxx",
            "https://user@www.youtube.com/watch?v=YE7VzlLtp-4",
            "https://www.youtube.com:81/watch?v=YE7VzlLtp-4",
        ] {
            assert!(MediaSource::youtube_watch(input).is_err(), "{input}");
        }
        assert_eq!(
            MediaSource::youtube_watch("https://www.youtube.com.evil.invalid/watch?v=YE7VzlLtp-4"),
            Ok(None)
        );
    }
}
