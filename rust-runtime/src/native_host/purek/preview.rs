//! Bounded local presentation of the actual L1 MPEG-TS output. No receiver,
//! room identity or authorization is fabricated for this application sink.
use super::*;
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SEGMENTS: usize = 6;
struct Segment {
    number: u64,
    start: i64,
    end: i64,
    run: u64,
    discontinuity: u64,
    date: chrono::DateTime<chrono::Utc>,
    bytes: Arc<[u8]>,
}
#[derive(Default)]
struct Buffer {
    segments: VecDeque<Segment>,
    current: Vec<u8>,
    start: i64,
    last: i64,
    sequence: u64,
    bytes: usize,
    eof: bool,
    error: bool,
    read: Option<Instant>,
    run: u64,
    discontinuity: u64,
    delivered: u64,
    date: Option<chrono::DateTime<chrono::Utc>>,
}
pub(super) struct Preview {
    buffer: Mutex<Buffer>,
    wake: Condvar,
    capability: String,
    retired: Arc<AtomicBool>,
    readers: Arc<tokio::sync::Semaphore>,
}
impl Preview {
    pub fn new(capability: String, retired: Arc<AtomicBool>) -> Self {
        Self {
            buffer: Mutex::new(Buffer::default()),
            wake: Condvar::new(),
            capability,
            retired,
            readers: Arc::new(tokio::sync::Semaphore::new(8)),
        }
    }
    pub fn push(&self, run: u64, data: &[u8], time: i64, key: bool, stop: &AtomicBool) -> bool {
        let mut b = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
        if self.retired.load(Ordering::Acquire)
            || b.run != run
            || stop.load(Ordering::Acquire)
            || b.eof
            || data.len() > 24064
            || !data.len().is_multiple_of(188)
            || time < b.last
        {
            return false;
        }
        if key && !b.current.is_empty() && time > b.start {
            Self::seal(&mut b, time);
        }
        // Retain a short sliding window, never unbounded song-sized media in RAM.
        while (b.bytes + data.len() > MAX_BYTES || b.segments.len() > MAX_SEGMENTS)
            && b.segments.len() > 3
        {
            if let Some(old) = b.segments.pop_front() {
                b.bytes -= old.bytes.len();
            }
        }
        if b.bytes + data.len() > MAX_BYTES || time - b.start > 4_000_000 {
            b.error = true;
            return false;
        }
        b.current.extend_from_slice(data);
        b.bytes += data.len();
        b.last = time;
        self.wake.notify_all();
        true
    }
    fn seal(b: &mut Buffer, end: i64) {
        let bytes = std::mem::take(&mut b.current);
        let next = Segment {
            number: 0,
            start: b.start,
            end,
            run: b.run,
            discontinuity: b.discontinuity,
            date: b.date.unwrap_or_else(chrono::Utc::now)
                + chrono::TimeDelta::microseconds(b.start),
            bytes: bytes.into(),
        };
        Self::publish(b, next);
        b.start = end;
    }
    fn publish(b: &mut Buffer, mut segment: Segment) {
        segment.number = b.sequence;
        b.sequence += 1;
        b.segments.push_back(segment);
        while b.segments.len() > MAX_SEGMENTS {
            if let Some(old) = b.segments.pop_front() {
                b.bytes -= old.bytes.len();
            }
        }
    }
    pub fn base(&self) -> String {
        format!("/media/native-output/{}/", self.capability)
    }
    pub fn begin(&self, run: u64) {
        let mut b = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
        if b.run != 0 {
            b.discontinuity += 1;
        }
        b.bytes -= b.current.len();
        b.current.clear();
        b.start = 0;
        b.last = 0;
        b.eof = false;
        b.error = false;
        b.run = run;
        let now = chrono::Utc::now();
        // A producer may run ahead of wall time. A pause/retry/seek must not
        // assign overlapping PROGRAM-DATE-TIME values to different media
        // timestamps; HLS clients otherwise map a new period into old buffers.
        let previous_end = b
            .segments
            .back()
            .map(|s| s.date + chrono::TimeDelta::microseconds(s.end - s.start));
        b.date = Some(previous_end.map_or(now, |end| end.max(now)));
    }
    #[cfg(test)]
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        self.wake.notify_all();
    }
    pub fn eof(&self) -> bool {
        self.buffer.lock().is_ok_and(|b| b.eof && !b.error)
    }
    pub fn period(&self, run: u64) -> Option<u64> {
        self.buffer
            .lock()
            .ok()
            .and_then(|b| (b.run == run).then_some(b.discontinuity))
    }
    pub fn tail(&self) -> Option<u64> {
        self.buffer.lock().ok().and_then(|b| {
            if b.eof && !b.error {
                b.segments
                    .back()
                    .filter(|s| s.run == b.run)
                    .map(|s| s.number)
            } else {
                None
            }
        })
    }
    pub fn delivered(&self, run: u64) -> bool {
        self.buffer.lock().is_ok_and(|b| b.delivered == run)
    }
    pub fn finish(&self, run: u64, error: bool, cancelled: bool) {
        let mut b = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
        if b.run != run {
            return;
        }
        if cancelled {
            b.bytes -= b.current.len();
            b.current.clear();
            self.wake.notify_all();
            return;
        }
        // L1 encodes fixed 1024-frame AAC at the shared 48 kHz rate.
        let frame_us = (1024_i64 * 1_000_000 + bilikara_rust::output_audio::RATE - 1)
            / bilikara_rust::output_audio::RATE;
        let end = (b.last + frame_us).max(b.start + 1);
        if !b.current.is_empty() {
            Self::seal(&mut b, end);
        }
        b.eof = true;
        b.error |= error;
        self.wake.notify_all();
    }
    pub fn wake(&self) {
        self.wake.notify_all();
    }
    pub fn recent(&self) -> bool {
        self.buffer.lock().is_ok_and(|b| {
            b.read
                .is_some_and(|t| t.elapsed() < Duration::from_secs(10))
        })
    }
    pub fn response(&self, file: &str, head: bool) -> Result<Response, ApiError> {
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure(429, "output_readers", "本机输出读取较多"))?;
        let mut b = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
        let requested_run = file
            .strip_prefix("index-")
            .and_then(|s| s.strip_suffix(".m3u8"))
            .and_then(|s| s.parse::<u64>().ok());
        let playlist = file == "index.m3u8" || requested_run.is_some();
        if requested_run.is_some_and(|run| run != b.run) {
            return Err(failure(410, "output_retired", "此输出已结束"));
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        while playlist
            && !b
                .segments
                .iter()
                .any(|s| requested_run.is_none_or(|run| s.run == run))
            && !b.eof
            && !self.retired.load(Ordering::Acquire)
            && Instant::now() < deadline
        {
            b = self
                .wake
                .wait_timeout(b, Duration::from_millis(50))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        if self.retired.load(Ordering::Acquire) || requested_run.is_some_and(|run| run != b.run) {
            return Err(failure(410, "output_retired", "此输出已结束"));
        }
        if b.error {
            return Err(failure(502, "output_pipeline", "本机输出管线失败"));
        }
        let (mime, bytes) = if playlist {
            let segments = b
                .segments
                .iter()
                .filter(|s| requested_run.is_none_or(|run| s.run == run))
                .collect::<Vec<_>>();
            if segments.is_empty() {
                return Err(failure(503, "output_starting", "正在准备本机输出"));
            }
            let first = segments[0].number;
            let target = segments
                .iter()
                .map(|s| ((s.end - s.start) as f64 / 1_000_000.).ceil() as i64)
                .max()
                .unwrap_or(4)
                .max(4);
            let mut text = format!(
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:{first}\n#EXT-X-INDEPENDENT-SEGMENTS\n"
            );
            text.push_str(&format!(
                "#EXT-X-DISCONTINUITY-SEQUENCE:{}\n",
                segments[0].discontinuity
            ));
            let mut previous = segments[0].discontinuity;
            for s in &segments {
                if s.discontinuity != previous {
                    text.push_str("#EXT-X-DISCONTINUITY\n");
                    previous = s.discontinuity;
                }
                let date = s.date;
                text.push_str(&format!(
                    "#EXT-X-PROGRAM-DATE-TIME:{}\n#EXTINF:{:.6},\n{}.ts\n",
                    date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    (s.end - s.start) as f64 / 1_000_000.,
                    s.number
                ));
            }
            if b.eof {
                text.push_str("#EXT-X-ENDLIST\n");
            }
            (
                "application/vnd.apple.mpegurl",
                Arc::<[u8]>::from(text.into_bytes()),
            )
        } else {
            let number = file
                .strip_suffix(".ts")
                .filter(|n| !n.is_empty() && n.len() < 20 && n.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|n| n.parse::<u64>().ok())
                .ok_or_else(|| failure(404, "output_segment", "输出片段不存在"))?;
            let segment = b
                .segments
                .iter()
                .find(|s| s.number == number)
                .ok_or_else(|| failure(410, "output_segment", "输出片段已过期"))?;
            let bytes = segment.bytes.clone();
            let run = segment.run;
            if !head {
                b.delivered = run;
            }
            ("video/MP2T", bytes)
        };
        if !head {
            b.read = Some(Instant::now());
        }
        let length = bytes.len();
        let body = if head {
            Body::empty()
        } else {
            Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
                LeasedBytes {
                    bytes: std::io::Cursor::new(bytes),
                    _permit: permit,
                },
                64 * 1024,
            ))
        };
        let mut response = body.into_response();
        response
            .headers_mut()
            .insert("content-type", mime.parse().unwrap());
        response
            .headers_mut()
            .insert("content-length", length.to_string().parse().unwrap());
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        Ok(response)
    }
}

pub(crate) fn media(path: &str, head: bool) -> Result<Response, ApiError> {
    let (preview, running, file) = with_app(|app| {
        let room = &app.native().purek;
        if !room.controller.local_preview || !room.controller.selected {
            return Err(failure(410, "output_retired", "此输出已结束"));
        }
        let preview = room
            .local_preview
            .clone()
            .ok_or_else(|| failure(410, "output_retired", "此输出已结束"))?;
        let file = path
            .strip_prefix(&preview.base())
            .filter(|s| !s.contains('/'))
            .ok_or_else(|| failure(404, "output_segment", "输出片段不存在"))?
            .to_owned();
        Ok((preview, room.output.running.clone(), file))
    })?;
    let response = preview.response(&file, head)?;
    if !head
        && file.ends_with(".ts")
        && let Some(running) = running
        && running.preview.is_some()
        && preview.delivered(running.generation())
    {
        running.delivered.store(true, Ordering::Release);
        running.publish();
    }
    Ok(response)
}

pub(crate) fn endpoint(identity: &Identity, body: Option<&Value>) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let running = app
            .native()
            .purek
            .output
            .running
            .clone()
            .filter(|r| r.preview.is_some())
            .ok_or_else(|| failure(409, "output_preview", "本机输出尚未就绪"))?;
        if let Some(body) = body {
            if body.as_object().is_none_or(|o| o.len() != 2)
                || body["generation"].as_u64() != Some(running.generation())
            {
                return Err(busy());
            }
            match body["phase"].as_str() {
                Some("ended") => {
                    if !running.preview.as_ref().is_some_and(|p| p.eof()) {
                        return Err(busy());
                    }
                    let signature = super::output::signature(app, true)?;
                    app.native().purek.controller.finish(&signature);
                }
                Some("error") => app
                    .native()
                    .purek
                    .controller
                    .fail("purek_output_preview_decode"),
                _ => return Err(ApiError::invalid("invalid output preview observation")),
            }
            app.native().revision += 1;
            return app.native_snapshot(true);
        }
        Ok(
            json!({"generation":running.generation(),"period":running.preview.as_ref().unwrap().period(running.generation()).ok_or_else(busy)?,"url":format!("{}index.m3u8",running.preview.as_ref().unwrap().base()),"native_url":format!("{}index-{}.m3u8",running.preview.as_ref().unwrap().base(),running.generation())}),
        )
    })
}

struct LeasedBytes {
    bytes: std::io::Cursor<Arc<[u8]>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl tokio::io::AsyncRead for LeasedBytes {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.bytes).poll_read(cx, buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet() -> Vec<u8> {
        let mut p = vec![0; 188];
        p[0] = 0x47;
        p
    }
    fn ready() -> Preview {
        let p = Preview::new("synthetic-only".into(), Arc::new(AtomicBool::new(false)));
        p.begin(1);
        p
    }
    fn body(response: Response) -> Vec<u8> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async {
                axum::body::to_bytes(response.into_body(), MAX_BYTES)
                    .await
                    .unwrap()
                    .to_vec()
            })
    }
    #[test]
    fn local_preview_is_bounded_and_discontinuous_periods_reuse_only_the_mode_capability() {
        let p = ready();
        let stop = AtomicBool::new(false);
        for n in 0..20 {
            assert!(p.push(1, &packet(), n * 1_000_000, true, &stop));
        }
        let b = p.buffer.lock().unwrap();
        assert_eq!(b.segments.len(), MAX_SEGMENTS);
        assert!(b.bytes <= MAX_BYTES);
        assert_eq!(b.segments.front().unwrap().number, 13);
        drop(b);
        let playlist = String::from_utf8(body(p.response("index.m3u8", false).unwrap())).unwrap();
        assert!(playlist.contains("#EXT-X-MEDIA-SEQUENCE:13"));
        assert!(playlist.contains("#EXT-X-PROGRAM-DATE-TIME:"));
        assert!(!playlist.contains("#EXT-X-ENDLIST"));
        assert_eq!(p.response("0.ts", false).err().unwrap().status, 410);
        p.finish(1, false, false);
        assert!(p.eof());
        assert_eq!(body(p.response("19.ts", false).unwrap()), packet());
        assert!(
            String::from_utf8(body(p.response("index.m3u8", false).unwrap()))
                .unwrap()
                .contains("#EXT-X-ENDLIST")
        );
        let previous_end = {
            let b = p.buffer.lock().unwrap();
            let s = b.segments.back().unwrap();
            s.date + chrono::TimeDelta::microseconds(s.end - s.start)
        };
        p.begin(2);
        assert!(
            p.buffer.lock().unwrap().date.unwrap() >= previous_end,
            "new periods cannot overlap the previous presentation clock"
        );
        assert!(!p.eof());
        assert_eq!(p.response("index-1.m3u8", false).err().unwrap().status, 410);
        assert_eq!(p.period(1), None);
        assert_eq!(p.period(2), Some(1));
        assert!(!p.push(1, &packet(), 20_000_000, true, &stop));
        assert!(p.push(2, &packet(), 0, true, &stop));
        assert!(p.push(2, &packet(), 1_000_000, true, &stop));
        assert!(p.push(2, &packet(), 2_000_000, true, &stop));
        assert!(
            String::from_utf8(body(p.response("index.m3u8", false).unwrap()))
                .unwrap()
                .contains("#EXT-X-DISCONTINUITY\n")
        );
        let native = String::from_utf8(body(p.response("index-2.m3u8", false).unwrap())).unwrap();
        assert!(native.contains("20.ts"));
        assert!(!native.contains("19.ts"));
        p.retire();
        assert_eq!(p.response("index.m3u8", false).err().unwrap().status, 410);
    }
    #[test]
    fn preview_reader_leases_cap_concurrent_bodies_and_release_on_drop() {
        let p = ready();
        let stop = AtomicBool::new(false);
        assert!(p.push(1, &packet(), 0, true, &stop));
        assert!(p.push(1, &packet(), 1_000_000, true, &stop));
        assert!(p.push(1, &packet(), 2_000_000, true, &stop));
        let mut held = (0..8)
            .map(|_| p.response("0.ts", false).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(p.response("0.ts", false).err().unwrap().status, 429);
        held.pop();
        assert!(p.response("0.ts", true).is_ok());
        drop(held);
        assert_eq!(p.readers.available_permits(), 8);
        assert!(!p.push(1, &[0; 187], 3_000_000, false, &stop));
        assert!(!p.push(1, &packet(), 0, false, &stop));
    }
    #[test]
    fn preview_never_grows_past_its_memory_or_gop_bound() {
        let p = ready();
        let stop = AtomicBool::new(false);
        let chunk = packet().repeat(128);
        while p.buffer.lock().unwrap().bytes + chunk.len() <= MAX_BYTES {
            assert!(p.push(1, &chunk, 0, true, &stop));
        }
        assert!(!p.push(1, &chunk, 0, false, &stop));
        assert!(p.buffer.lock().unwrap().bytes <= MAX_BYTES);
        let p = ready();
        assert!(p.push(1, &packet(), 0, true, &stop));
        assert!(!p.push(1, &packet(), 4_000_001, false, &stop));
    }
}
