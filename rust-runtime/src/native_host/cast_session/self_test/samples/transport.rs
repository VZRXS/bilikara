//! Bounded index for the exact bundled sample. Not a general TS demuxer.
use super::*;
use crate::{dlna::cast_http::LiveProducer, experimental_libav::cast_mux::CastStart};

#[derive(Debug)]
pub(super) struct Unit {
    pub offset: usize,
    pub time_us: i64,
    pub key: bool,
}
pub(super) fn index(bytes: &[u8]) -> Result<Vec<Unit>, ()> {
    if bytes.is_empty() || bytes.len() > SAMPLE_BYTES || !bytes.len().is_multiple_of(188) {
        return Err(());
    }
    let mut counters = [None; 8192];
    let mut units: Vec<Unit> = Vec::new();
    let mut pat = 0;
    let mut first = None;
    for (n, p) in bytes.chunks_exact(188).enumerate() {
        if p[0] != 0x47 || p[1] & 0x80 != 0 || p[3] & 0xc0 != 0 || p[3] & 0x30 == 0 {
            return Err(());
        }
        let pid = (usize::from(p[1] & 31) << 8) | usize::from(p[2]);
        if !matches!(pid, 0 | 17 | 256 | 257 | 4096) {
            return Err(());
        }
        let offset = if p[3] & 0x20 != 0 {
            5 + usize::from(p[4])
        } else {
            4
        };
        if offset > 188 {
            return Err(());
        }
        if p[3] & 0x10 == 0 {
            continue;
        }
        let cc = p[3] & 15;
        if counters[pid].is_some_and(|last| cc != (last + 1) & 15) {
            return Err(());
        }
        counters[pid] = Some(cc);
        if pid == 0 {
            pat = n * 188;
        }
        if pid != 256 || p[1] & 0x40 == 0 {
            continue;
        }
        let pes = &p[offset..];
        if pes.len() < 14
            || !pes.starts_with(&[0, 0, 1, 0xe0])
            || pes[7] & 0xc0 != 0x80
            || pes[8] < 5
        {
            return Err(());
        }
        let b = &pes[9..14];
        if b[0] & 0xf1 != 0x21 || b[2] & 1 != 1 || b[4] & 1 != 1 {
            return Err(());
        }
        let pts = (i64::from((b[0] >> 1) & 7) << 30)
            | (i64::from(b[1]) << 22)
            | (i64::from(b[2] >> 1) << 15)
            | (i64::from(b[3]) << 7)
            | i64::from(b[4] >> 1);
        let origin = *first.get_or_insert(pts);
        let time_us = (pts - origin) * 1_000_000 / 90_000;
        if !(0..=21_000_000).contains(&time_us)
            || units.last().is_some_and(|u| time_us <= u.time_us)
        {
            return Err(());
        }
        let key = p[3] & 0x20 != 0 && p[4] > 0 && p[5] & 0x40 != 0;
        let boundary = if units.is_empty() {
            0
        } else if pat > units.last().unwrap().offset {
            pat
        } else {
            n * 188
        };
        units.push(Unit {
            offset: boundary,
            time_us,
            key,
        });
    }
    // Exact asset contract prevents a partial final frame, missing keyframe,
    // altered topology or truncated stream from entering the producer.
    if units.len() != 600
        || units.iter().filter(|u| u.key).count() != 40
        || !units[0].key
        || !verified(bytes)
    {
        return Err(());
    }
    Ok(units)
}
pub(super) async fn produce(
    stream: &mut LiveProducer,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), ()> {
    let units = index(bytes)?;
    stream
        .start(CastStart {
            source_start_us: 0,
            timestamp_origin_us: 0,
            profile: 77,
            level: 40,
            width: 1920,
            height: 1080,
            has_b_frames: false,
            audio_transcoded: false,
        })
        .map_err(|_| ())?;
    let start = tokio::time::Instant::now();
    for (i, unit) in units.iter().enumerate() {
        let pace = Duration::from_micros(unit.time_us.max(0) as u64)
            .saturating_sub(Duration::from_secs(5));
        tokio::select! {biased;_=cancel.cancelled()=>return Err(()),_=tokio::time::sleep_until(start+pace)=>{}}
        let end = units.get(i + 1).map_or(bytes.len(), |u| u.offset);
        for (j, chunk) in bytes[unit.offset..end].chunks(188 * 128).enumerate() {
            stream
                .push(chunk, unit.time_us, unit.key && j == 0)
                .map_err(|_| ())?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    const BYTES: &[u8] = include_bytes!("../../../../../../resources/cast-samples/sample-b.ts");
    #[test]
    fn pinned_ts_index_covers_every_byte_and_all_keyframes() {
        let units = index(BYTES).unwrap();
        assert_eq!(units.len(), 600);
        assert_eq!(units.iter().filter(|u| u.key).count(), 40);
        assert_eq!(units[0].offset, 0);
        assert_eq!(units[599].time_us, 19_966_666);
        let mut total = 0;
        for (i, u) in units.iter().enumerate() {
            let end = units.get(i + 1).map_or(BYTES.len(), |n| n.offset);
            assert!(end > u.offset);
            assert_eq!(u.offset % 188, 0);
            total += end - u.offset;
        }
        assert_eq!(total, BYTES.len());
    }
    #[test]
    fn malformed_sample_is_bounded_and_rejected() {
        for size in [0, 1, 187, 188, BYTES.len() - 1, BYTES.len() - 188] {
            assert!(index(&BYTES[..size]).is_err());
        }
        for kind in 0..5 {
            let mut bytes = BYTES.to_vec();
            match kind {
                0 => bytes[0] = 0,
                1 => {
                    bytes[1] = 0x1f;
                    bytes[2] = 0xff;
                }
                2 => bytes[3] ^= 1,
                3 => bytes[4] = 255,
                _ => {
                    for p in bytes.chunks_exact_mut(188) {
                        if p[3] & 0x20 != 0 && p[4] > 0 {
                            p[5] &= !0x40;
                        }
                    }
                }
            }
            assert!(index(&bytes).is_err(), "case {kind}");
        }
    }
}
