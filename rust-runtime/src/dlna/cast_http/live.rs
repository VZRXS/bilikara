//! Whole-GOP, bounded multi-reader storage for T3's schema-2 event stream.
use super::continuity;
use crate::experimental_libav::{LibavMetadataProbe, ProbeError, cast_mux::*};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const MAX_CHUNK: usize = 188 * 128;
pub const MAX_RING_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct LiveOptions {
    /// Never less than ten seconds. Whole GOPs may extend this window.
    pub retention: Duration,
    /// Shared with T3's producer pacing and each reader's initial burst.
    pub burst: Duration,
    pub max_bytes: usize,
    /// Allowed delay behind the wall-clock playback point, excluding the
    /// initial backward keyframe seek. Independent of bitrate and burst bytes.
    pub max_client_lag: Duration,
}

impl Default for LiveOptions {
    fn default() -> Self {
        Self {
            retention: Duration::from_secs(10),
            burst: Duration::from_secs(5),
            max_bytes: 64 * 1024 * 1024,
            max_client_lag: Duration::from_secs(3),
        }
    }
}

impl LiveOptions {
    pub fn pacing(&self) -> CastPacing {
        CastPacing::Realtime { burst: self.burst }
    }

    fn validate(&self) -> Result<(), LiveError> {
        if self.retention < Duration::from_secs(10)
            || self.retention > Duration::from_secs(120)
            || self.burst > self.retention
            || self.max_bytes < MAX_CHUNK
            || self.max_bytes > MAX_RING_BYTES
            || self.max_client_lag.is_zero()
            || self.max_client_lag > self.retention
        {
            return Err(LiveError::InvalidOptions);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveError {
    InvalidOptions,
    InvalidEvent,
    /// The ten-second window / current GOP cannot fit. Never silently retain
    /// less history or block the generator on one HTTP consumer.
    BufferLimit,
    /// External DTS exceeded elapsed playback time plus the configured burst.
    /// Terminal: no bytes are accepted or evicted for the rejected event.
    ProducerAhead,
    ProducerFailed,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct LiveSnapshot {
    pub start: Option<CastStart>,
    pub buffered_bytes: usize,
    pub retained_span: Duration,
    pub keyframes: usize,
    pub finished: bool,
    pub error: Option<LiveError>,
}

struct Chunk {
    index: u64,
    sequence: u64,
    time_us: i64,
    bytes: Arc<[u8]>,
    ends_unit: bool,
}

#[derive(Default)]
struct Ring {
    start: Option<CastStart>,
    chunks: VecDeque<Chunk>,
    keys: VecDeque<(u64, i64, u64)>,
    bytes: usize,
    next: u64,
    next_index: u64,
    last_time: i64,
    finished: bool,
    error: Option<LiveError>,
    began: Option<tokio::time::Instant>,
    pes: continuity::PesBoundary,
}

/// Shared reader/cancellation handle. Only its unique producer can write.
///
/// ```compile_fail
/// use bilikara_runtime::dlna::cast_http::{LiveOptions, LiveStream};
/// use bilikara_runtime::experimental_libav::cast_mux::CastEvent;
/// let (stream, _) = LiveStream::external(LiveOptions::default()).unwrap();
/// stream.push(CastEvent::Data { bytes: &[], time_us: 0, key: true });
/// ```
/// ```compile_fail
/// use bilikara_runtime::dlna::cast_http::{LiveOptions, LiveStream};
/// let (stream, _) = LiveStream::external(LiveOptions::default()).unwrap();
/// stream.finish(true);
/// ```
/// ```compile_fail
/// use bilikara_runtime::dlna::cast_http::LiveStream;
/// use bilikara_runtime::experimental_libav::{LibavMetadataProbe, cast_mux::CastInputs};
/// fn duplicate_writer(stream: &LiveStream, probe: &LibavMetadataProbe, inputs: &CastInputs<'_>) {
///     stream.generate(probe, inputs, 1024);
/// }
/// ```
pub struct LiveStream {
    pub(super) options: LiveOptions,
    ring: Mutex<Ring>,
    pub(super) wake: Notify,
    stop: AtomicBool,
}

/// One external producer for a fresh stream. Dropping an unfinished producer
/// fails the stream and wakes readers, including during callback unwinding.
/// Keep this handle on the producer worker; individual HTTP readers do not own it.
/// It is not cloneable, and writes require exclusive access.
///
/// ```compile_fail
/// use bilikara_runtime::dlna::cast_http::LiveProducer;
/// fn duplicate<T: Clone>() {}
/// duplicate::<LiveProducer>();
/// ```
/// ```compile_fail
/// use bilikara_runtime::dlna::cast_http::LiveProducer;
/// fn shared_writer(producer: &LiveProducer) {
///     producer.push(&[], 0, true).unwrap();
/// }
/// ```
pub struct LiveProducer {
    stream: Arc<LiveStream>,
    finished: bool,
}

impl LiveProducer {
    /// Submit the actual timestamp basis immediately before producing data.
    /// This starts the playback clock; do not synthesize a basis from wall time.
    pub fn start(&mut self, start: CastStart) -> Result<(), LiveError> {
        self.stream.push_event(CastEvent::Start(start), true)
    }

    /// Nonblocking, bounded copy of a complete TS-aligned callback chunk.
    /// `time_us` is a nonnegative, monotonic DTS watermark relative to Start's
    /// timestamp origin. A key chunk starts a decodable GOP with PSI/IDR.
    /// Like T3, the producer must flush complete muxed packets before changing
    /// the watermark; equal-watermark chunks may continue the same PES.
    /// Exceeding elapsed playback time plus `burst` fails the generation with
    /// `ProducerAhead`, before changing or evicting any buffered data.
    pub fn push(&mut self, bytes: &[u8], time_us: i64, key: bool) -> Result<(), LiveError> {
        self.stream.push_event(
            CastEvent::Data {
                bytes,
                time_us,
                key,
            },
            true,
        )
    }

    /// Borrow for native callbacks (including next's L1). Generation retirement
    /// sets this flag even while no bytes are being produced. Never clear it.
    pub fn cancellation(&self) -> &AtomicBool {
        self.stream.cancellation()
    }

    /// External pacing must use the same lead as the HTTP readers. The ring
    /// never blocks a producer; exceeding its byte budget or lead is an error.
    pub fn pacing(&self) -> CastPacing {
        self.stream.options.pacing()
    }

    /// Close after EOF or failure. Preserve validation/buffer/cancellation errors.
    pub fn finish(mut self, success: bool) -> Result<(), LiveError> {
        self.stream.finish(success);
        self.finished = true;
        self.stream.snapshot().error.map_or(Ok(()), Err)
    }

    /// Consume the unique writer on a worker thread for T3 generation.
    /// T3 enforces realtime pacing before invoking this internal event sink;
    /// its own Start clock precedes delivery to the ring by callback overhead.
    /// External writers instead use `start` / `push` and the ring's lead check.
    pub fn generate(
        mut self,
        probe: &LibavMetadataProbe,
        inputs: &CastInputs<'_>,
        max_bytes: u64,
    ) -> Result<CastSummary, ProbeError> {
        let result = probe.cast_ts_with_events(
            inputs,
            self.pacing(),
            max_bytes,
            self.cancellation(),
            &mut |event| self.stream.push_event(event, false).is_ok(),
        );
        self.stream.finish(result.is_ok());
        self.finished = true;
        result
    }
}

impl Drop for LiveProducer {
    fn drop(&mut self) {
        if !self.finished {
            self.stream.finish(false);
        }
    }
}

pub(super) struct Cursor {
    sequence: Option<u64>,
    index: u64,
    join_slack_us: i64,
    pending_jump: bool,
}

impl Cursor {
    pub(super) fn new() -> Self {
        Self {
            sequence: None,
            index: 0,
            join_slack_us: 0,
            pending_jump: false,
        }
    }
}

pub(super) enum Read {
    Data {
        chunks: Vec<Arc<[u8]>>,
        time_us: i64,
        jumped: bool,
        start: CastStart,
        playback_us: i64,
    },
    Wait,
    End(Result<(), LiveError>),
}

impl LiveStream {
    /// Allocate a separate generation and its external producer. Publish the
    /// stream through CastEndpoint::publish_live, then feed the producer from a
    /// worker. Use a fresh pair for every seek/restart. T3 can consume the
    /// producer with `generate`; external producers use `start` / `push`.
    ///
    /// ```no_run
    /// use bilikara_runtime::dlna::cast_http::{LiveError, LiveOptions, LiveStream};
    /// use bilikara_runtime::experimental_libav::cast_mux::CastStart;
    /// use std::sync::atomic::Ordering;
    /// fn feed(start: CastStart, packet: &[u8]) -> Result<(), LiveError> {
    ///     let (stream, mut producer) = LiveStream::external(LiveOptions::default())?;
    ///     let cancelled = stream.cancellation();
    ///     producer.start(start)?;
    ///     if !cancelled.load(Ordering::Acquire) {
    ///         producer.push(packet, 0, true)?;
    ///     }
    ///     producer.finish(true)
    /// }
    /// ```
    pub fn external(options: LiveOptions) -> Result<(Arc<Self>, LiveProducer), LiveError> {
        let stream = Arc::new(Self::new(options)?);
        let producer = LiveProducer {
            stream: stream.clone(),
            finished: false,
        };
        Ok((stream, producer))
    }

    pub(super) fn new(options: LiveOptions) -> Result<Self, LiveError> {
        options.validate()?;
        Ok(Self {
            options,
            ring: Mutex::new(Ring::default()),
            wake: Notify::new(),
            stop: AtomicBool::new(false),
        })
    }

    /// Borrow from the reader handle when a native call also needs a mutable
    /// producer in its callback. Generation retirement sets it; never clear it.
    pub fn cancellation(&self) -> &AtomicBool {
        &self.stop
    }

    // Synthetic ring tests intentionally bypass realtime pacing.
    #[cfg(test)]
    pub(super) fn push(&self, event: CastEvent<'_>) -> Result<(), LiveError> {
        self.push_event(event, false)
    }

    /// Nonblocking T3 callback adapter. Bounded copies only, no client IO.
    fn push_event(&self, event: CastEvent<'_>, enforce_lead: bool) -> Result<(), LiveError> {
        if self.stop.load(Ordering::Acquire) {
            return Err(LiveError::Cancelled);
        }
        let mut r = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        if self.stop.load(Ordering::Acquire) {
            return Err(LiveError::Cancelled);
        }
        if let Some(error) = r.error {
            return Err(error);
        }
        let result = if r.finished {
            Err(LiveError::InvalidEvent)
        } else {
            match event {
                CastEvent::Start(start) if r.start.is_none() && r.chunks.is_empty() => {
                    r.start = Some(start);
                    r.began = Some(tokio::time::Instant::now());
                    Ok(())
                }
                CastEvent::Data {
                    bytes,
                    time_us,
                    key,
                } => self.append(&mut r, bytes, time_us, key, enforce_lead),
                _ => Err(LiveError::InvalidEvent),
            }
        };
        if let Err(error) = result {
            r.error = Some(error);
            r.finished = true;
        }
        drop(r);
        self.wake.notify_waiters();
        result
    }

    fn append(
        &self,
        r: &mut Ring,
        bytes: &[u8],
        time_us: i64,
        key: bool,
        enforce_lead: bool,
    ) -> Result<(), LiveError> {
        if r.start.is_none()
            || (r.chunks.is_empty() && !key)
            || time_us < 0
            || time_us < r.last_time
            || bytes.len() > MAX_CHUNK
            || !continuity::valid(bytes)
        {
            return Err(LiveError::InvalidEvent);
        }
        if enforce_lead
            && Duration::from_micros(time_us as u64)
                > r.began
                    .expect("validated Start")
                    .elapsed()
                    .saturating_add(self.options.burst)
        {
            return Err(LiveError::ProducerAhead);
        }
        let cutoff = time_us.saturating_sub(self.options.retention.as_micros() as i64);
        if r.chunks.back().is_some_and(|c| time_us > c.time_us || key) {
            // T3 flushes AVIO after each complete muxed packet. A changed
            // watermark / new IDR group therefore closes the previous PES.
            r.chunks.back_mut().expect("back exists").ends_unit = true;
            r.pes.reset();
        }
        // Keep the entire GOP containing the beginning of the window.
        while let Some(&(sequence, _, _)) = r.keys.get(1).filter(|(_, time, _)| *time <= cutoff) {
            while r.chunks.front().is_some_and(|c| c.sequence < sequence) {
                r.bytes -= r.chunks.pop_front().expect("front exists").bytes.len();
            }
            r.keys.pop_front();
        }
        if bytes.len() > self.options.max_bytes.saturating_sub(r.bytes) {
            return Err(LiveError::BufferLimit);
        }
        let sequence = r.next;
        r.next = r
            .next
            .checked_add(bytes.len() as u64)
            .ok_or(LiveError::BufferLimit)?;
        r.bytes += bytes.len();
        r.last_time = time_us;
        let index = r.next_index;
        r.next_index = r.next_index.checked_add(1).ok_or(LiveError::BufferLimit)?;
        if key {
            r.keys.push_back((sequence, time_us, index));
        }
        let ends_unit = r.pes.observe(bytes);
        r.chunks.push_back(Chunk {
            index,
            sequence,
            time_us,
            bytes: Arc::from(bytes),
            ends_unit,
        });
        Ok(())
    }

    /// External producers call this after EOF or failure; generate does it for
    /// callers automatically. Already reported ring errors are preserved.
    pub(super) fn finish(&self, success: bool) {
        let mut r = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        r.finished = true;
        if let Some(last) = r.chunks.back_mut() {
            last.ends_unit = true;
        }
        if !success && r.error.is_none() {
            r.error = Some(LiveError::ProducerFailed);
        }
        drop(r);
        self.wake.notify_waiters();
    }

    pub fn cancel(&self) {
        if !self.stop.swap(true, Ordering::AcqRel) {
            let mut r = self.ring.lock().unwrap_or_else(|e| e.into_inner());
            r.chunks = VecDeque::new();
            r.keys = VecDeque::new();
            r.bytes = 0;
            r.finished = true;
            r.error = Some(LiveError::Cancelled);
        }
        self.wake.notify_waiters();
    }

    pub fn snapshot(&self) -> LiveSnapshot {
        let r = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        LiveSnapshot {
            start: r.start,
            buffered_bytes: r.bytes,
            retained_span: Duration::from_micros(
                r.chunks
                    .front()
                    .map_or(0, |c| r.last_time - c.time_us)
                    .max(0) as u64,
            ),
            keyframes: r.keys.len(),
            finished: r.finished,
            error: r.error,
        }
    }

    #[cfg(test)]
    pub(super) fn set_elapsed(&self, elapsed: Duration) {
        self.ring.lock().unwrap().began = Some(tokio::time::Instant::now() - elapsed);
    }

    pub(super) fn read(&self, cursor: &mut Cursor) -> Read {
        if self.stop.load(Ordering::Acquire) {
            return Read::End(Err(LiveError::Cancelled));
        }
        let r = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = r.error {
            return Read::End(Err(error));
        }
        // T3 starts its realtime clock at Start, with burst seconds of lead.
        // Its most recently generated key is ahead of playback, not a join.
        let playback_us = r
            .began
            .map_or(0, |began| {
                began.elapsed().as_micros().min(i64::MAX as u128) as i64
            })
            .min(r.last_time);
        let target = r
            .keys
            .iter()
            .rev()
            .find(|(_, time, _)| *time <= playback_us)
            .or_else(|| r.keys.front());
        match cursor.sequence {
            None => {
                if let Some(&(sequence, time, index)) = target {
                    cursor.sequence = Some(sequence);
                    cursor.index = index;
                    cursor.join_slack_us = playback_us.saturating_sub(time).max(0);
                }
            }
            Some(sequence) => {
                let expired = r.chunks.front().is_some_and(|c| sequence < c.sequence);
                let time = r
                    .chunks
                    .front()
                    .and_then(|front| cursor.index.checked_sub(front.index))
                    .and_then(|offset| usize::try_from(offset).ok())
                    .and_then(|offset| r.chunks.get(offset))
                    .map_or(r.last_time, |c| c.time_us);
                let lagged = playback_us.saturating_sub(time)
                    > self.options.max_client_lag.as_micros() as i64 + cursor.join_slack_us;
                if (expired || lagged)
                    && let Some(&(key_sequence, _, index)) =
                        target.filter(|(key_sequence, _, _)| *key_sequence > sequence)
                {
                    cursor.sequence = Some(key_sequence);
                    cursor.index = index;
                    cursor.pending_jump = true;
                }
            }
        }
        let offset = r
            .chunks
            .front()
            .and_then(|front| cursor.index.checked_sub(front.index))
            .and_then(|offset| usize::try_from(offset).ok());
        let chunk = offset.and_then(|offset| r.chunks.get(offset));
        if let Some(chunk) = chunk.filter(|chunk| cursor.sequence == Some(chunk.sequence)) {
            let offset = offset.expect("chunk offset");
            let Some(end) = r.chunks.iter().skip(offset).position(|c| c.ends_unit) else {
                return Read::Wait;
            };
            let last = &r.chunks[offset + end];
            let chunks = r
                .chunks
                .iter()
                .skip(offset)
                .take(end + 1)
                .map(|c| c.bytes.clone())
                .collect();
            cursor.sequence = Some(last.sequence + last.bytes.len() as u64);
            cursor.index = last.index + 1;
            Read::Data {
                chunks,
                time_us: chunk.time_us,
                jumped: std::mem::take(&mut cursor.pending_jump),
                start: r.start.expect("validated start"),
                playback_us,
            }
        } else if r.finished {
            Read::End(Ok(()))
        } else {
            Read::Wait
        }
    }
}
