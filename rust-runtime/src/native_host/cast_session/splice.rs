//! Continuous composited cast: each program segment is muxed on its own
//! clock (starting near zero). Splicing shifts every PCR, PTS and DTS of a
//! segment onto the session clock, so the receiver sees one MPEG-TS stream.
//! Continuity counters are rewritten per HTTP reader (`cast_http`).

pub(super) const PACKET: usize = 188;
/// 33-bit PCR base / PTS / DTS arithmetic.
const WRAP: i64 = 1 << 33;

/// Microseconds to 90 kHz ticks.
pub(super) fn ticks(us: i64) -> i64 {
    us * 9 / 100
}

fn add(value: i64, offset: i64) -> i64 {
    (value + offset).rem_euclid(WRAP)
}

fn read_timestamp(b: &[u8]) -> i64 {
    (i64::from(b[0] >> 1) & 7) << 30
        | i64::from(b[1]) << 22
        | (i64::from(b[2]) >> 1) << 15
        | i64::from(b[3]) << 7
        | i64::from(b[4]) >> 1
}

fn write_timestamp(b: &mut [u8], value: i64) {
    // Keep the 4-bit prefix and the marker bits.
    b[0] = (b[0] & 0xf1) | (((value >> 30) & 7) as u8) << 1;
    b[1] = (value >> 22) as u8;
    b[2] = (((value >> 15) & 0x7f) as u8) << 1 | 1;
    b[3] = (value >> 7) as u8;
    b[4] = ((value & 0x7f) as u8) << 1 | 1;
}

/// Shifts every PCR and PES PTS/DTS in whole TS packets by `offset` 90 kHz
/// ticks. PSI and payload bytes are untouched. Returns false for bytes that
/// are not whole, synchronized packets.
pub(super) fn shift(bytes: &mut [u8], offset: i64) -> bool {
    if !bytes.len().is_multiple_of(PACKET) {
        return false;
    }
    for p in bytes.chunks_exact_mut(PACKET) {
        if p[0] != 0x47 {
            return false;
        }
        let control = (p[3] >> 4) & 3;
        let mut payload = 4;
        if control & 2 != 0 {
            let length = usize::from(p[4]);
            if length > 183 {
                return false;
            }
            // PCR: 33-bit base, 6 reserved bits, 9-bit extension.
            if length >= 7 && p[5] & 0x10 != 0 {
                let base = i64::from(p[6]) << 25
                    | i64::from(p[7]) << 17
                    | i64::from(p[8]) << 9
                    | i64::from(p[9]) << 1
                    | i64::from(p[10]) >> 7;
                let base = add(base, offset);
                p[6] = (base >> 25) as u8;
                p[7] = (base >> 17) as u8;
                p[8] = (base >> 9) as u8;
                p[9] = (base >> 1) as u8;
                p[10] = (p[10] & 0x7f) | ((base & 1) as u8) << 7;
            }
            payload = 5 + length;
        }
        if control & 1 == 0 || p[1] & 0x40 == 0 || payload + 19 > PACKET {
            continue;
        }
        let pes = &mut p[payload..];
        // A PES start with an optional header (not padding/private_2/PSM...).
        if pes[..3] != [0, 0, 1]
            || matches!(
                pes[3],
                0xbc | 0xbe | 0xbf | 0xf0 | 0xf1 | 0xf2 | 0xf8 | 0xff
            )
        {
            continue;
        }
        if pes[6] & 0xc0 != 0x80 {
            continue;
        }
        let flags = pes[7] >> 6;
        if flags & 2 != 0 {
            let value = add(read_timestamp(&pes[9..14]), offset);
            write_timestamp(&mut pes[9..14], value);
        }
        if flags == 3 {
            let value = add(read_timestamp(&pes[14..19]), offset);
            write_timestamp(&mut pes[14..19], value);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A video PES start with PCR, PTS and DTS, and a PAT.
    fn packets(pts: i64, dts: i64, pcr: i64) -> Vec<u8> {
        let mut video = [0xff_u8; PACKET];
        video[..4].copy_from_slice(&[0x47, 0x41, 0x00, 0x30]);
        video[4] = 7;
        video[5] = 0x10;
        video[6] = (pcr >> 25) as u8;
        video[7] = (pcr >> 17) as u8;
        video[8] = (pcr >> 9) as u8;
        video[9] = (pcr >> 1) as u8;
        video[10] = ((pcr & 1) as u8) << 7 | 0x7e;
        video[11] = 0x2a;
        let pes = &mut video[12..];
        pes[..9].copy_from_slice(&[0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10]);
        pes[9] = 0x31;
        write_timestamp(&mut pes[9..14], pts);
        pes[14] = 0x11;
        write_timestamp(&mut pes[14..19], dts);
        let mut pat = [0xff_u8; PACKET];
        pat[..8].copy_from_slice(&[0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xb0, 0x0d]);
        [video, pat].concat()
    }

    fn timestamps(bytes: &[u8]) -> (i64, i64, i64, u8) {
        let pcr = i64::from(bytes[6]) << 25
            | i64::from(bytes[7]) << 17
            | i64::from(bytes[8]) << 9
            | i64::from(bytes[9]) << 1
            | i64::from(bytes[10]) >> 7;
        (
            read_timestamp(&bytes[21..26]),
            read_timestamp(&bytes[26..31]),
            pcr,
            bytes[11],
        )
    }

    #[test]
    fn shifts_pcr_pts_and_dts_and_keeps_markers_psi_and_extension() {
        let mut bytes = packets(180_000, 171_000, 126_000);
        let original = bytes.clone();
        assert!(shift(&mut bytes, ticks(10_000_000)));
        assert_eq!(timestamps(&bytes), (1_080_000, 1_071_000, 1_026_000, 0x2a));
        // Prefix nibbles, marker bits, the PCR extension and the PAT stay.
        assert_eq!(bytes[21] & 0xf1, original[21] & 0xf1);
        assert_eq!(bytes[26] & 0xf1, original[26] & 0xf1);
        assert_eq!(bytes[10] & 0x7f, 0x7e);
        assert_eq!(bytes[PACKET..], original[PACKET..]);
        // Wraps at 33 bits like the receiver's clock.
        let mut bytes = packets(WRAP - 90, WRAP - 90, WRAP - 90);
        assert!(shift(&mut bytes, 180));
        assert_eq!(timestamps(&bytes).0, 90);
        assert_eq!(timestamps(&bytes).2, 90);
        // Round trip.
        assert!(shift(&mut bytes, -180));
        assert_eq!(timestamps(&bytes).0, WRAP - 90);
        assert!(!shift(&mut bytes[..100], 1));
    }
}
