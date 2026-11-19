//! Live engine fixtures. Requires the GStreamer runtime plugins and ffmpeg;
//! the selected live tests fail (never skip) when either is unavailable.
#![allow(dead_code)]
use bilikara_media_engine::{
    AudioOutput, ClockMode, Engine, EngineConfig, FrameSink, MediaSource, Observation,
    ObservationKind, PcmSink, ProgramIdentity, VideoFrame,
};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const FPS: u32 = 30;
pub const SECONDS: u32 = 8;
pub const BITS: u32 = 16;
pub const BLOCK: u32 = 40;

pub fn require_live() {
    assert_eq!(
        std::env::var("BILIKARA_TEST_GSTREAMER_ENGINE").as_deref(),
        Ok("1"),
        "live engine tests require BILIKARA_TEST_GSTREAMER_ENGINE=1 and real GStreamer plugins"
    );
    assert_eq!(
        std::env::var("CUDA_VISIBLE_DEVICES").as_deref(),
        Ok(""),
        "local live tests must run with CUDA_VISIBLE_DEVICES='' (CPU-only policy)"
    );
    let capability = bilikara_media_engine::probe();
    assert!(capability.available, "GStreamer capability: {capability:?}");
}

pub struct Fixtures {
    pub video: PathBuf,
    /// 48 kHz AAC: tone 300 + 100*second Hz, 2 kHz marker in the last 60 ms.
    pub aac: PathBuf,
    /// 44.1 kHz FLAC: tone 350 + 100*second Hz (different variant).
    pub flac: PathBuf,
}

fn ffmpeg(arguments: &[&str]) {
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(arguments)
        .status()
        .expect("ffmpeg is required to generate live fixtures");
    assert!(status.success(), "ffmpeg {arguments:?}");
}

pub fn fixtures() -> &'static Fixtures {
    static FIXTURES: OnceLock<Fixtures> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-engine-fixtures-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let video = directory.join("video.mp4");
        let aac = directory.join("original.m4a");
        let flac = directory.join("instrumental.flac");
        // Each 40 px block in the top band encodes one bit of the frame index.
        let geq = format!(
            "geq=lum='if(lt(Y,80),255*mod(floor(N/pow(2,floor(X/{BLOCK}))),2),96)':cb=128:cr=128"
        );
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=gray:s=640x360:r={FPS}:d={SECONDS}"),
            "-vf",
            &geq,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-qp",
            "8",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            video.to_str().unwrap(),
        ]);
        let tone = |base: u32, rate: u32| {
            format!(
                "aevalsrc='if(gt(t,{end}),0.4*sin(2*PI*2000*t),0.3*sin(2*PI*({base}+100*floor(t))*t))':s={rate}:d={SECONDS},aformat=channel_layouts=stereo",
                end = f64::from(SECONDS) - 0.06
            )
        };
        ffmpeg(&[
            "-f", "lavfi", "-i", &tone(300, 48000), "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", aac.to_str().unwrap(),
        ]);
        ffmpeg(&[
            "-f", "lavfi", "-i", &tone(350, 44100), "-c:a", "flac", flac.to_str().unwrap(),
        ]);
        Fixtures { video, aac, flac }
    })
}

pub fn uri(path: &Path) -> String {
    format!("file://{}", path.canonicalize().unwrap().display())
}

/// Minimal loopback HTTP/1.1 file server with byte ranges, standing in for the
/// Host's loopback media routes. Counts the requests that actually reached it.
pub struct HttpFixture {
    pub port: u16,
    pub requests: Arc<AtomicUsize>,
}

impl HttpFixture {
    pub fn serve(directory: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let (root, count) = (directory.to_path_buf(), requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (root, count) = (root.clone(), count.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let mut range = None;
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                            break;
                        }
                        let lower = header.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("range: bytes=") {
                            let mut parts = value.trim().splitn(2, '-');
                            let start: u64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
                            let end: Option<u64> = parts.next().and_then(|v| v.parse().ok());
                            range = Some((start, end));
                        }
                    }
                    count.fetch_add(1, Ordering::SeqCst);
                    let mut stream = stream;
                    let name = path.trim_start_matches('/');
                    let Ok(bytes) = std::fs::read(root.join(name)) else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    };
                    let total = bytes.len() as u64;
                    let (status, start, end) = match range {
                        Some((start, end)) if start < total => (
                            "206 Partial Content",
                            start,
                            end.unwrap_or(total - 1).min(total - 1),
                        ),
                        _ => ("200 OK", 0, total.saturating_sub(1)),
                    };
                    let body = &bytes[start as usize..=end as usize];
                    let mut head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
                        body.len()
                    );
                    if status.starts_with("206") {
                        head.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = stream
                        .write_all(head.as_bytes())
                        .and_then(|()| stream.write_all(body));
                });
            }
        });
        Self { port, requests }
    }

    pub fn url(&self, path: &Path) -> String {
        format!(
            "http://127.0.0.1:{}/{}",
            self.port,
            path.file_name().unwrap().to_str().unwrap()
        )
    }
}

pub fn program(generation: u64, variant: &str) -> ProgramIdentity {
    ProgramIdentity {
        playback_generation: generation,
        item_id: format!("item-{generation}"),
        item_incarnation_id: "incarnation".into(),
        selected_audio_variant_id: variant.into(),
        artifact_set_id: Some("set".into()),
    }
}

pub fn media(audio: &Path) -> MediaSource {
    let fixtures = fixtures();
    MediaSource {
        video_uri: uri(&fixtures.video),
        audio_uri: uri(audio),
        cookies: Vec::new(),
    }
}

#[derive(Clone)]
pub struct PcmChunk {
    pub pts_ns: Option<u64>,
    pub at: Instant,
    pub samples: Arc<Vec<f32>>,
}

#[derive(Default)]
pub struct Capture {
    pub chunks: Mutex<Vec<PcmChunk>>,
}

impl PcmSink for Capture {
    fn pcm(&self, pts_ns: Option<u64>, samples: &[f32]) {
        self.chunks.lock().unwrap().push(PcmChunk {
            pts_ns,
            at: Instant::now(),
            samples: Arc::new(samples.to_vec()),
        });
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Presented {
    pub index: u32,
    pub pts_ns: Option<u64>,
    pub at: Instant,
    pub token: u64,
}

#[derive(Default)]
pub struct Frames {
    pub presented: Mutex<Vec<Presented>>,
    pub clears: Mutex<u32>,
}

pub fn frame_index(frame: &VideoFrame) -> u32 {
    let data = frame.data();
    let row = 40usize * frame.stride as usize;
    (0..BITS)
        .map(|bit| {
            let x = (bit * BLOCK + BLOCK / 2) as usize;
            // BGRx: green channel is a good luminance proxy for gray.
            let value = data[row + x * 4 + 1];
            u32::from(value > 128) << bit
        })
        .sum()
}

impl FrameSink for Frames {
    fn present(&self, frame: Arc<VideoFrame>) {
        self.presented.lock().unwrap().push(Presented {
            index: frame_index(&frame),
            pts_ns: frame.pts_ns,
            at: Instant::now(),
            token: frame.pipeline_token,
        });
    }
    fn clear(&self) {
        *self.clears.lock().unwrap() += 1;
    }
}

pub struct Harness {
    pub engine: Engine,
    pub observations: Receiver<Observation>,
    pub seen: Vec<Observation>,
    pub capture: Arc<Capture>,
    pub frames: Arc<Frames>,
}

impl Harness {
    pub fn start(clock: ClockMode) -> Self {
        require_live();
        fixtures();
        let capture = Arc::new(Capture::default());
        let frames = Arc::new(Frames::default());
        let (sender, observations) = mpsc::channel();
        let sender = Mutex::new(sender);
        let engine = Engine::start(
            EngineConfig {
                audio: AudioOutput::Capture(capture.clone()),
                clock,
                hardware_decoding: false,
            },
            frames.clone(),
            Arc::new(move |observation| {
                let _ = sender.lock().unwrap().send(observation);
            }),
        )
        .unwrap();
        Self {
            engine,
            observations,
            seen: Vec::new(),
            capture,
            frames,
        }
    }

    /// Waits for an observation matching `predicate`, recording all of them.
    pub fn wait(
        &mut self,
        timeout: Duration,
        description: &str,
        predicate: impl Fn(&Observation) -> bool,
    ) -> Observation {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.observations.recv_timeout(remaining) {
                Ok(observation) => {
                    self.seen.push(observation.clone());
                    if let ObservationKind::Error { fatal: true, .. } = &observation.kind {
                        if !predicate(&observation) {
                            panic!("fatal engine error while waiting for {description}: {observation:?}");
                        }
                    }
                    if predicate(&observation) {
                        return observation;
                    }
                }
                Err(_) => panic!(
                    "timed out waiting for {description}; observations: {:#?}",
                    self.seen.iter().rev().take(12).collect::<Vec<_>>()
                ),
            }
        }
    }

    /// Collects every observation for `duration`.
    pub fn drain(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while let Ok(observation) = self
            .observations
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            self.seen.push(observation);
        }
    }

    pub fn eos_count(&self, program: &ProgramIdentity) -> usize {
        self.seen
            .iter()
            .filter(|o| &o.program == program && matches!(o.kind, ObservationKind::Eos { .. }))
            .count()
    }

    pub fn pcm_after(&self, at: Instant) -> Vec<PcmChunk> {
        self.capture
            .chunks
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.at >= at)
            .cloned()
            .collect()
    }
}

pub fn is(kind: &'static str) -> impl Fn(&Observation) -> bool {
    move |o| {
        let name = match &o.kind {
            ObservationKind::Loading => "loading",
            ObservationKind::Ready => "ready",
            ObservationKind::Playing => "playing",
            ObservationKind::Paused => "paused",
            ObservationKind::Position => "position",
            ObservationKind::SeekSettled { .. } => "seek-settled",
            ObservationKind::Eos { .. } => "eos",
            ObservationKind::Error { .. } => "error",
            ObservationKind::ClockLost => "clock-lost",
            ObservationKind::Stopped => "stopped",
        };
        name == kind
    }
}

/// Dominant frequency (Hz) of the left channel from zero crossings.
pub fn frequency(samples: &[f32]) -> f64 {
    let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
    if left.len() < 480 {
        return 0.0;
    }
    let crossings = left
        .windows(2)
        .filter(|w| (w[0] <= 0.0 && w[1] > 0.0) || (w[0] >= 0.0 && w[1] < 0.0))
        .count();
    crossings as f64 / 2.0 / (left.len() as f64 / 48_000.0)
}

/// Goertzel power of the left channel at `hz`.
pub fn tone_power(samples: &[f32], hz: f64) -> f64 {
    let left: Vec<f64> = samples.iter().step_by(2).map(|v| f64::from(*v)).collect();
    let coefficient = 2.0 * (2.0 * std::f64::consts::PI * hz / 48_000.0).cos();
    let (mut previous, mut before) = (0.0, 0.0);
    for value in &left {
        let current = value + coefficient * previous - before;
        before = previous;
        previous = current;
    }
    (previous * previous + before * before - coefficient * previous * before)
        / (left.len().max(1) as f64).powi(2)
}

pub fn rms(samples: &[f32]) -> f64 {
    (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len().max(1) as f64)
        .sqrt()
}

/// Concatenated PCM whose timestamps lie in `[from, to)` seconds.
pub fn window(chunks: &[PcmChunk], from: f64, to: f64) -> Vec<f32> {
    let mut out = Vec::new();
    for chunk in chunks {
        let Some(pts) = chunk.pts_ns else { continue };
        let start = pts as f64 / 1e9;
        for (index, frame) in chunk.samples.chunks_exact(2).enumerate() {
            let time = start + index as f64 / 48_000.0;
            if time >= from && time < to {
                out.extend_from_slice(frame);
            }
        }
    }
    out
}
