//! YouTube quality policy. Only separate AVC/MP4 and stereo AAC/MP4 tracks
//! fit every shipped player/normalizer without a decoder or transcoder.
use crate::quality_policy::{QualityPolicyRequest, VideoQuality, decide_quality_policy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YouTubeCodec {
    Avc,
    Aac,
    Other,
}

#[derive(Debug, Clone)]
pub struct YouTubeFormat {
    pub index: usize,
    pub codec: YouTubeCodec,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u64,
    pub audio_channels: u32,
    pub original_audio: bool,
    pub default_audio: bool,
    pub protected: bool,
}

pub fn select_youtube_formats(
    formats: &[YouTubeFormat],
    quality: &str,
    cap: &str,
) -> Option<(usize, usize)> {
    let policy = decide_quality_policy(&QualityPolicyRequest {
        raw_quality: quality.into(),
        raw_cap: cap.into(),
        choice_index: None,
    });
    let max_height = policy
        .normalized_quality
        .max_height()
        .min(policy.effective_max_height);
    let max_fps = if policy.normalized_quality == VideoQuality::Q1080HighFrameRate {
        60
    } else {
        30
    };
    let video = formats
        .iter()
        .filter(|f| {
            !f.protected
                && f.codec == YouTubeCodec::Avc
                && f.height > 0
                && f.height <= max_height
                && f.fps <= max_fps
        })
        .max_by_key(|f| (f.height, f.fps, f.bitrate, std::cmp::Reverse(f.index)))?;
    let audio = formats
        .iter()
        .filter(|f| {
            !f.protected && f.codec == YouTubeCodec::Aac && (1..=2).contains(&f.audio_channels)
        })
        .max_by_key(|f| {
            (
                f.original_audio,
                f.default_audio,
                f.bitrate,
                std::cmp::Reverse(f.index),
            )
        })?;
    Some((video.index, audio.index))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn video(index: usize, height: u32, fps: u32) -> YouTubeFormat {
        YouTubeFormat {
            index,
            codec: YouTubeCodec::Avc,
            height,
            fps,
            bitrate: 100,
            audio_channels: 0,
            original_audio: false,
            default_audio: false,
            protected: false,
        }
    }
    #[test]
    fn quality_caps_fps_and_original_stereo_audio() {
        let mut formats = vec![
            video(0, 360, 30),
            video(1, 720, 30),
            video(2, 1080, 30),
            video(3, 1080, 60),
            video(4, 2160, 60),
        ];
        formats.push(YouTubeFormat {
            codec: YouTubeCodec::Aac,
            height: 0,
            audio_channels: 2,
            original_audio: true,
            ..video(5, 0, 0)
        });
        formats.push(YouTubeFormat {
            codec: YouTubeCodec::Aac,
            height: 0,
            audio_channels: 6,
            bitrate: 1000,
            ..video(6, 0, 0)
        });
        formats.push(YouTubeFormat {
            codec: YouTubeCodec::Aac,
            height: 0,
            audio_channels: 2,
            default_audio: true,
            ..video(7, 0, 0)
        });
        for (quality, expected) in [
            ("360P 流畅", 0),
            ("480P 清晰", 0),
            ("720P 高清", 1),
            ("1080P 高清", 2),
            ("1080P 高帧率", 3),
        ] {
            assert_eq!(
                select_youtube_formats(&formats, quality, ""),
                Some((expected, 5))
            );
        }
        assert_eq!(
            select_youtube_formats(&formats, "360P 流畅", "1080P 高清"),
            Some((0, 5))
        );
        assert_eq!(
            select_youtube_formats(&formats, "1080P 高帧率", "720P 高清"),
            Some((1, 5))
        );
        formats[5].protected = true;
        assert_eq!(
            select_youtube_formats(&formats, "720P 高清", ""),
            Some((1, 7))
        );
        formats[7].codec = YouTubeCodec::Other;
        assert_eq!(select_youtube_formats(&formats, "720P 高清", ""), None);
    }
}
