//! Pure receiver-format interpretation. Advertisements never qualify playback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SinkFormat {
    pub mime: String,
    pub profile: Option<String>,
}

#[derive(Clone)]
pub(super) struct ProtocolInfo {
    pub formats: Vec<SinkFormat>,
    // Distinguish an empty advertisement from a nonempty, incompatible one
    // whose entries were filtered out (for example RTSP-only receivers).
    pub empty: bool,
}
impl ProtocolInfo {
    pub fn parse(sink: &str) -> Result<Self, ()> {
        Ok(Self {
            formats: sink_formats(sink)?,
            empty: sink.trim().is_empty(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TsProtocol {
    Mp2t,
    Mpeg,
}
impl TsProtocol {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Mp2t => "video/MP2T",
            Self::Mpeg => "video/mpeg",
        }
    }
    pub fn info(self) -> String {
        // A sink profile is a receiver restriction, not proof that our media
        // meets its resolution/level/framing constraints. Never echo it back.
        format!("http-get:*:{}:*", self.mime())
    }
}

pub(super) fn ts_protocol(formats: &[SinkFormat]) -> Option<TsProtocol> {
    for f in formats {
        let aac_ts = f
            .profile
            .as_ref()
            .is_none_or(|p| p.starts_with("AVC_TS_") && p.contains("AAC"));
        if f.mime == "video/mp2t" && aac_ts {
            return Some(TsProtocol::Mp2t);
        }
        // DLNA's *_ISO profiles use 188-byte TS. Do not alias the 192-byte
        // video/vnd.dlna.mpeg-tts format to our 188-byte libav muxer.
        if f.mime == "video/mpeg"
            && aac_ts
            && f.profile.as_ref().is_none_or(|p| p.ends_with("_ISO"))
        {
            return Some(TsProtocol::Mpeg);
        }
    }
    formats
        .iter()
        .any(|f| matches!(f.mime.as_str(), "*" | "video/*") && f.profile.is_none())
        .then_some(TsProtocol::Mp2t)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Assessment {
    MissingAvTransport,
    MissingVideoFormat,
    RequiresHardwareValidation,
}

pub(super) fn assess(av_transport: bool, formats: &[SinkFormat]) -> Assessment {
    if !av_transport {
        Assessment::MissingAvTransport
    } else if !formats
        .iter()
        .any(|f| matches!(f.mime.as_str(), "video/mp2t" | "video/mp4"))
        && ts_protocol(formats).is_none()
    {
        Assessment::MissingVideoFormat
    } else {
        Assessment::RequiresHardwareValidation
    }
}

/// Keep MIME and DLNA profile only; never publish arbitrary vendor parameters.
/// An empty Sink is a valid domain result, distinct from malformed protocolInfo.
pub(super) fn sink_formats(text: &str) -> Result<Vec<SinkFormat>, ()> {
    if text.len() > 65536 {
        return Err(());
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for (index, entry) in text.split(',').enumerate() {
        if index >= 128 {
            return Err(());
        }
        let parts: Vec<_> = entry.trim().splitn(4, ':').collect();
        if parts.len() != 4
            || parts.iter().any(|s| s.is_empty())
            || entry.chars().any(char::is_control)
        {
            return Err(());
        }
        let mut content_format = parts[2].split(';');
        let mime = content_format.next().ok_or(())?.trim().to_ascii_lowercase();
        let token = |s: &str| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-*".contains(&c))
        };
        if mime != "*" {
            let Some((kind, subtype)) = mime.split_once('/') else {
                return Err(());
            };
            if !token(kind) || !token(subtype) {
                return Err(());
            }
        }
        // Common LPCM advertisements include rate/channels MIME parameters.
        // Validate their shape, but keep them out of the public G0 projection.
        for parameter in content_format {
            let Some((name, value)) = parameter.trim().split_once('=') else {
                return Err(());
            };
            if !token(name)
                || value.is_empty()
                || value.len() > 256
                || !value.bytes().all(|c| (32..=126).contains(&c))
            {
                return Err(());
            }
        }
        let mut profile = None;
        for parameter in parts[3].split(';') {
            if let Some(value) = parameter.strip_prefix("DLNA.ORG_PN=") {
                if profile.is_some()
                    || value.is_empty()
                    || value.len() > 64
                    || !value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                {
                    return Err(());
                }
                profile = Some(value.to_owned());
            }
        }
        if (!parts[0].eq_ignore_ascii_case("http-get") && parts[0] != "*") || parts[1] != "*" {
            continue;
        }
        let format = SinkFormat { mime, profile };
        if !result.contains(&format) {
            result.push(format);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_info_handles_empty_duplicates_profiles_and_other_transports() {
        assert_eq!(sink_formats("  "), Ok(vec![]));
        let formats = sink_formats("http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3;DLNA.ORG_OP=00,http-get:*:video/mp4:*,http-get:*:video/mp4:*,rtsp-rtp-udp:*:video/mp2t:*").unwrap();
        assert_eq!(formats.len(), 2);
        assert_eq!(formats[0].mime, "video/mp2t");
        assert_eq!(formats[0].profile.as_deref(), Some("AVC_TS_HD_50_AC3"));
        assert_eq!(
            assess(true, &formats),
            Assessment::RequiresHardwareValidation
        );
        assert_eq!(assess(false, &formats), Assessment::MissingAvTransport);
        assert_eq!(assess(true, &[]), Assessment::MissingVideoFormat);
        assert_eq!(
            assess(true, &sink_formats("http-get:*:video/*:*").unwrap()),
            Assessment::RequiresHardwareValidation
        );
    }
    #[test]
    fn malformed_and_unbounded_advertisements_are_errors() {
        for text in [
            "http-get:*:video/mp2t",
            "http-get:*:video/mp2t:",
            "http-get:*:bad:*",
            "http-get:*:video/mp2t:*\r\n",
            "http-get:*:video/mp2t:DLNA.ORG_PN=http://example.invalid",
            "http-get:*:video/mp2t:DLNA.ORG_PN=A;DLNA.ORG_PN=B",
        ] {
            assert_eq!(sink_formats(text), Err(()));
        }
        assert!(sink_formats(&"http-get:*:video/mp2t:*,".repeat(129)).is_err());
        assert!(sink_formats(&"x".repeat(65537)).is_err());
    }
    #[test]
    fn wildcard_and_parameterized_audio_do_not_hide_explicit_video_formats() {
        let formats = sink_formats("http-get:*:*:*,http-get:*:audio/L16;rate=48000;channels=2:DLNA.ORG_PN=LPCM,http-get:*:video/MP2T:*").unwrap();
        assert_eq!(formats.len(), 3);
        assert_eq!(formats[1].mime, "audio/l16");
        assert_eq!(formats[1].profile.as_deref(), Some("LPCM"));
        assert_eq!(
            assess(true, &formats),
            Assessment::RequiresHardwareValidation
        );
        assert_eq!(
            assess(true, &formats[..2]),
            Assessment::RequiresHardwareValidation
        );
        for invalid in [
            "http-get:*:video/mp2t;rate:*",
            "http-get:*:audio/L16;rate=:*",
        ] {
            assert!(sink_formats(invalid).is_err());
        }
    }

    #[test]
    fn ts_selection_matches_wire_format_without_claiming_a_receiver_profile() {
        for (sink, expected) in [
            ("http-get:*:video/MP2T:*", Some(TsProtocol::Mp2t)),
            (
                "http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5",
                Some(TsProtocol::Mp2t),
            ),
            (
                "http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5_ISO",
                Some(TsProtocol::Mpeg),
            ),
            ("http-get:*:video/mpeg:*", Some(TsProtocol::Mpeg)),
            ("http-get:*:video/*:*", Some(TsProtocol::Mp2t)),
            ("*:*:*:*", Some(TsProtocol::Mp2t)),
            (
                "http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5",
                None,
            ),
            ("http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL", None),
            ("http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3", None),
            ("http-get:*:video/mp4:*", None),
            ("http-get:*:audio/*:*", None),
            ("rtsp-rtp-udp:*:video/MP2T:*", None),
        ] {
            assert_eq!(
                ts_protocol(&sink_formats(sink).unwrap()),
                expected,
                "{sink}"
            );
        }
        assert_eq!(TsProtocol::Mpeg.info(), "http-get:*:video/mpeg:*");
        assert_eq!(TsProtocol::Mp2t.info(), "http-get:*:video/MP2T:*");
        assert!(ProtocolInfo::parse(" ").unwrap().empty);
        assert!(
            !ProtocolInfo::parse("rtsp-rtp-udp:*:video/MP2T:*")
                .unwrap()
                .empty
        );
    }
}
