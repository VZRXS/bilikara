//! Per-reader TS counters and adaptation-only discontinuity markers. The
//! algorithm follows Kirakara-Show's MpegTsContinuityRewriter (MIT, FMPeach);
//! see NOTICE.md in this module. PCR/PTS/DTS and all payload bytes are preserved.

pub(super) const PACKET: usize = 188;

/// A reader pins a complete PES delivery unit before writing any of it. Finite
/// PES lengths can close a unit immediately; zero-length video PES are closed
/// by T3's next flushed packet watermark (or EOF), never an arbitrary chunk.
pub(super) struct PesBoundary {
    remaining: Box<[u32; 8192]>,
    active: usize,
    seen: bool,
}

impl Default for PesBoundary {
    fn default() -> Self {
        Self {
            remaining: Box::new([0; 8192]),
            active: 0,
            seen: false,
        }
    }
}

impl PesBoundary {
    pub(super) fn observe(&mut self, bytes: &[u8]) -> bool {
        for p in bytes.chunks_exact(PACKET) {
            if p[3] & 0x10 == 0 {
                continue;
            }
            let offset = if p[3] & 0x20 != 0 {
                5 + usize::from(p[4])
            } else {
                4
            };
            let payload = &p[offset..];
            let pid = (usize::from(p[1] & 31) << 8) | usize::from(p[2]);
            if p[1] & 0x40 != 0 && payload.starts_with(&[0, 0, 1]) {
                if self.remaining[pid] != 0 {
                    self.active -= 1;
                }
                self.seen = true;
                self.active += 1;
                let length = payload.get(4..6).map(|b| u16::from_be_bytes([b[0], b[1]]));
                self.remaining[pid] = match length {
                    Some(length) if length != 0 => u32::from(length) + 6,
                    _ => u32::MAX,
                };
            }
            let remaining = &mut self.remaining[pid];
            if *remaining != 0 && *remaining != u32::MAX {
                *remaining = remaining.saturating_sub(payload.len() as u32);
                if *remaining == 0 {
                    self.active -= 1;
                }
            }
        }
        self.seen && self.active == 0
    }

    pub(super) fn reset(&mut self) {
        self.remaining.fill(0);
        self.active = 0;
        self.seen = false;
    }
}

pub(super) fn valid(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len().is_multiple_of(PACKET)
        && bytes.chunks_exact(PACKET).all(|p| {
            p[0] == 0x47
                && p[1] & 0x80 == 0
                && p[3] & 0xc0 == 0
                && match (p[3] >> 4) & 3 {
                    1 => true,
                    2 => p[4] == 183,
                    3 => p[4] <= 182,
                    _ => false,
                }
        })
}

pub(super) struct Continuity {
    next: Box<[u8; 8192]>,
    seen: Box<[bool; 8192]>,
}

impl Continuity {
    pub(super) fn new() -> Self {
        Self {
            next: Box::new([0; 8192]),
            seen: Box::new([false; 8192]),
        }
    }

    pub(super) fn rewrite(&mut self, bytes: &mut [u8]) {
        for p in bytes.chunks_exact_mut(PACKET) {
            let pid = (usize::from(p[1] & 31) << 8) | usize::from(p[2]);
            // Null packets have no continuity requirement.
            if pid == 8191 {
                continue;
            }
            let payload = p[3] & 0x10 != 0;
            let counter = if payload || !self.seen[pid] {
                self.next[pid]
            } else {
                self.next[pid].wrapping_sub(1) & 15
            };
            p[3] = (p[3] & 0xf0) | counter;
            if payload {
                self.next[pid] = (counter + 1) & 15;
                self.seen[pid] = true;
            }
        }
    }

    // Emit one packet at a time so even 8191 seen PIDs cannot allocate an
    // unbounded marker batch. Adaptation-only packets do not advance CC.
    pub(super) fn discontinuities(&self) -> impl Iterator<Item = [u8; PACKET]> + '_ {
        self.seen.iter().enumerate().filter_map(|(pid, seen)| {
            if !seen {
                return None;
            }
            let mut p = [0xff; PACKET];
            p[0] = 0x47;
            p[1] = (pid >> 8) as u8;
            p[2] = pid as u8;
            p[3] = 0x20 | (self.next[pid].wrapping_sub(1) & 15);
            p[4] = 183;
            p[5] = 0x80;
            Some(p)
        })
    }
}
