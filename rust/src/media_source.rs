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
    pub fn youtube_watch(input: &str) -> Result<Option<Self>, &'static str> {
        // Intentionally a strict ASCII watch-link grammar, not a generic URL
        // resolver. Only the eleven-character video ID ever reaches I/O.
        let input = input.trim();
        let Some((scheme, rest)) = input.split_once("://") else {
            return Ok(None);
        };
        let (authority, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority
            .rsplit('@')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("");
        if ![
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
        ]
        .iter()
        .any(|h| host.eq_ignore_ascii_case(h))
        {
            return Ok(None);
        }
        let error = "Only YouTube watch?v= links are supported";
        if !matches!(scheme, "https" | "http")
            || !authority.eq_ignore_ascii_case(host)
            || host.eq_ignore_ascii_case("youtu.be")
            || input.bytes().any(|b| b.is_ascii_control() || b == b'\\')
        {
            return Err(error);
        }
        let tail = tail.split('#').next().unwrap_or("");
        let Some(("watch", query)) = tail.split_once('?') else {
            return Err(error);
        };
        let mut ids = query.split('&').filter_map(|pair| pair.strip_prefix("v="));
        let id = ids.next().ok_or(error)?;
        if ids.next().is_some() || !valid_youtube_id(id) {
            return Err(error);
        }
        Ok(Some(Self::YouTube {
            video_id: id.into(),
        }))
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
            "https://www.youtube.com/shorts/YE7VzlLtp-4",
            "https://youtu.be/YE7VzlLtp-4",
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
