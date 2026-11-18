//! Adapt the existing L1 ABI without changing its bytes or the standalone sink.
//! The renderer reports the actual backward-seek video PTS through its PCM
//! callback. Its first video PES supplies PTS-DTS (90 kHz); added to that
//! packet's callback DTS it gives the source offset. The muxer's common PTS/
//! DTS decode lead cancels out, without shifting bytes or callback watermarks.
use super::{Event, ProbeError, Start};

const MAX_PREFIX: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Events {
    prefix: Vec<(Vec<u8>, i64)>,
    size: usize,
    key_seen: bool,
    started: bool,
}

fn invalid() -> ProbeError {
    ProbeError::BackendFailure("Invalid L1 start boundary".into())
}

fn timestamp(b: &[u8], tag: u8) -> Result<i64, ProbeError> {
    if b[0] >> 4 != tag || b[0] & 1 == 0 || b[2] & 1 == 0 || b[4] & 1 == 0 {
        return Err(invalid());
    }
    Ok((i64::from(b[0] & 14) << 29)
        | (i64::from(b[1]) << 22)
        | (i64::from(b[2] & 254) << 14)
        | (i64::from(b[3]) << 7)
        | i64::from(b[4] >> 1))
}

fn first_video_reorder(bytes: &[u8]) -> Result<Option<i64>, ProbeError> {
    for p in bytes.chunks_exact(188) {
        if p[1] & 0x40 == 0 || p[3] & 0x10 == 0 {
            continue;
        }
        let offset = if p[3] & 0x20 != 0 {
            5 + usize::from(p[4])
        } else {
            4
        };
        let data = p.get(offset..).ok_or_else(invalid)?;
        if !data.starts_with(&[0, 0, 1]) || !matches!(data.get(3), Some(0xe0..=0xef)) {
            continue;
        }
        if data.len() < 14 || data[6] & 0xc0 != 0x80 || data[7] & 0x80 == 0 || data[8] < 5 {
            return Err(invalid());
        }
        let separate_dts = data[7] & 0x40 != 0;
        let pts = timestamp(&data[9..14], if separate_dts { 3 } else { 2 })?;
        let dts = if separate_dts {
            if data.len() < 19 || data[8] < 10 {
                return Err(invalid());
            }
            timestamp(&data[14..19], 1)?
        } else {
            pts
        };
        let reorder = pts - dts;
        // L1 requires PTS >= DTS and a bounded closed GOP. A wrapped or foreign
        // timestamp must not invent a source position.
        if !(0..=4 * 90_000).contains(&reorder) {
            return Err(invalid());
        }
        return Ok(Some((reorder * 1_000_000 + 45_000) / 90_000));
    }
    Ok(None)
}

impl Events {
    pub(super) fn push(
        &mut self,
        source_start: Option<i64>,
        bytes: &[u8],
        time_us: i64,
        key: bool,
        visit: &mut dyn FnMut(Event<'_>) -> bool,
    ) -> Result<(), ProbeError> {
        let accepted = if self.started {
            visit(Event::Data {
                bytes,
                time_us,
                key,
            })
        } else {
            self.size = self.size.checked_add(bytes.len()).ok_or_else(invalid)?;
            if self.size > MAX_PREFIX {
                return Err(invalid());
            }
            self.key_seen |= key;
            let reorder = first_video_reorder(bytes)?;
            self.prefix.push((bytes.to_vec(), time_us));
            let Some(reorder) = reorder else {
                return Ok(());
            };
            if !self.key_seen {
                return Err(invalid());
            }
            let source_start_us = source_start.ok_or_else(invalid)?;
            if !visit(Event::Start(Start {
                source_start_us,
                timestamp_origin_us: source_start_us
                    .checked_sub(time_us.checked_add(reorder).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?,
            })) {
                return Err(ProbeError::Cancelled);
            }
            // AAC priming can precede the first video packet. Keep it, including
            // its PSI, in the first joinable group. Later groups retain the
            // companion's exact key boundaries. Each original chunk keeps its
            // DTS watermark and the <= 24064-byte callback bound.
            for (index, (bytes, time_us)) in self.prefix.drain(..).enumerate() {
                if !visit(Event::Data {
                    bytes: &bytes,
                    time_us,
                    key: index == 0,
                }) {
                    return Err(ProbeError::Cancelled);
                }
            }
            self.started = true;
            true
        };
        if accepted {
            Ok(())
        } else {
            Err(ProbeError::Cancelled)
        }
    }

    pub(super) fn finish(&self) -> Result<(), ProbeError> {
        if self.started { Ok(()) } else { Err(invalid()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires real L1 companion; test:purek-l1 runs the actual seek fixture"]
    fn real_l1_seek_reports_actual_source_and_preserves_ts_bytes() {
        use super::super::{Control, LibavMetadataProbe};
        use bilikara_rust::output_audio::OffsetMode;
        use std::{path::Path, sync::atomic::AtomicBool};
        let companion = std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").unwrap();
        let probe = unsafe { LibavMetadataProbe::load(Path::new(&companion)) }.unwrap();
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/native_host/cast_session/fixtures");
        let video = directory.join("keyframes-30s.mp4");
        let audio = directory.join("audio-30s.m4a");
        let stop = AtomicBool::new(false);
        let mut controls = || {
            Ok(Control {
                offset_ms: 0,
                key_shift: 0,
                volume_percent: 100,
                muted: false,
                track: 0,
                mode: OffsetMode::Splice,
            })
        };
        let mut original = Vec::new();
        probe
            .render_live_ts(
                &video,
                &[&audio],
                3_000_000,
                &stop,
                &mut |bytes, _, _| {
                    original.extend_from_slice(bytes);
                    true
                },
                &mut controls,
            )
            .unwrap();
        let mut start = None;
        let mut adapted = Vec::new();
        probe
            .render_live_ts_with_events(
                &video,
                &[&audio],
                3_000_000,
                &stop,
                &mut |event| {
                    match event {
                        Event::Start(value) => {
                            assert!(start.is_none());
                            start = Some(value);
                        }
                        Event::Data { bytes, key, .. } => {
                            assert!(start.is_some());
                            if adapted.is_empty() {
                                assert!(key);
                            }
                            adapted.extend_from_slice(bytes);
                        }
                    }
                    true
                },
                &mut controls,
            )
            .unwrap();
        let start = start.unwrap();
        // Independent fixture: 30fps, two B frames, closed two-second GOPs.
        assert_eq!(start.source_start_us, 2_000_000);
        assert!(
            (start.timestamp_origin_us - 1_933_333).abs() <= 11,
            "{start:?}"
        );
        assert!(!original.is_empty());
        assert_eq!(
            adapted, original,
            "Start adaptation must not change a TS byte"
        );
    }

    fn video() -> [u8; 188] {
        let mut p = [0xff; 188];
        p[..4].copy_from_slice(&[0x47, 0x41, 0, 0x10]);
        // Independently specified MPEG-2 video PES, PTS = 90000 (one second).
        p[4..18].copy_from_slice(&[0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 5, 0xbf, 0x21]);
        p
    }

    #[test]
    fn initial_audio_is_preserved_and_source_origin_uses_video_pts() {
        let mut adapter = Events::default();
        let mut audio = video();
        audio[7] = 0xc0;
        let mut start = None;
        let mut chunks = Vec::new();
        let mut sink = |e: Event<'_>| {
            match e {
                Event::Start(s) => {
                    assert!(chunks.is_empty());
                    start = Some(s);
                }
                Event::Data {
                    bytes,
                    time_us,
                    key,
                } => chunks.push((bytes.to_vec(), time_us, key)),
            }
            true
        };
        adapter
            .push(Some(4_000_000), &audio, 0, false, &mut sink)
            .unwrap();
        adapter
            .push(Some(4_000_000), &video(), 250_000, true, &mut sink)
            .unwrap();
        adapter
            .push(Some(4_000_000), &video(), 2_250_000, true, &mut sink)
            .unwrap();
        adapter.finish().unwrap();
        let start = start.unwrap();
        assert_eq!(start.source_start_us, 4_000_000);
        // PTS-only PES has no reorder; its muxer PTS lead is not source time.
        assert_eq!(start.timestamp_origin_us, 3_750_000);
        assert_eq!(
            chunks,
            vec![
                (audio.to_vec(), 0, true),
                (video().to_vec(), 250_000, false),
                (video().to_vec(), 2_250_000, true)
            ]
        );
    }

    #[test]
    fn missing_key_source_or_timestamp_markers_fail_before_publication() {
        for (source, key, malformed) in [
            (Some(0), false, false),
            (None, true, false),
            (Some(0), true, true),
        ] {
            let mut p = video();
            if malformed {
                p[13] &= !1;
            }
            assert!(
                Events::default()
                    .push(source, &p, 0, key, &mut |_| panic!(
                        "invalid start published"
                    ))
                    .is_err()
            );
        }
        assert!(Events::default().finish().is_err());
    }

    #[test]
    fn prefix_is_bounded_and_consumer_cancellation_propagates() {
        let mut adapter = Events::default();
        let mut audio = video();
        audio[7] = 0xc0;
        let chunk = audio.repeat(128);
        let mut bytes = 0;
        loop {
            bytes += chunk.len();
            let result = adapter.push(Some(0), &chunk, 0, false, &mut |_| panic!("no video yet"));
            if bytes > MAX_PREFIX {
                assert!(result.is_err());
                break;
            }
            result.unwrap();
        }
        for allow_start in [false, true] {
            assert!(matches!(
                Events::default().push(Some(0), &video(), 0, true, &mut |event| allow_start
                    && matches!(event, Event::Start(_))),
                Err(ProbeError::Cancelled)
            ));
        }
    }
}
