//! Synchronous developer orchestration, outside the runtime application graph.
use bilikara_runtime::experimental_libav::{LibavMetadataProbe, comparison::*};
use bilikara_runtime::{ExpectedMediaKind, MediaPathRequest, probe_media};
use serde_json::json;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[path = "packet_scan.rs"]
mod packet_scan;
#[path = "remux.rs"]
mod remux;

static CANCELLED: AtomicBool = AtomicBool::new(false);
extern "C" fn cancel(_: libc::c_int) {
    CANCELLED.store(true, Ordering::Relaxed);
}
const MAX_OUTPUT: usize = 64 * 1024;
const ENTRIES: &str = "stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration,start_time,time_base,bits_per_raw_sample,bit_rate:format=format_name,duration,start_time,bit_rate:error=code";
const DISCOVERY: &[&str] = &[
    "-formatprobesize",
    "65536",
    "-probesize",
    "1048576",
    "-analyzeduration",
    "1000000",
    "-max_probe_packets",
    "256",
    "-max_streams",
    "32",
    "-skip_estimate_duration_from_pts",
    "1",
    "-enable_drefs",
    "0",
    "-use_absolute_path",
    "0",
    "-protocol_whitelist",
    "fd",
    "-format_whitelist",
    "mov,flac",
];

// The same kill + wait cleanup used by the existing host subprocess pattern,
// kept local to this example. No threads, subprocess group/sandbox or scheduler.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Output {
    bytes: Vec<u8>,
    success: bool,
    diagnostic_bytes: usize,
}
fn capture(
    command: &mut Command,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<Output, Outcome> {
    capture_with_diagnostics(command, cancelled, timeout, false)
}
fn capture_with_diagnostics(
    command: &mut Command,
    cancelled: &AtomicBool,
    timeout: Duration,
    diagnostics: bool,
) -> Result<Output, Outcome> {
    capture_limited(command, cancelled, timeout, diagnostics, MAX_OUTPUT)
}
fn capture_limited(
    command: &mut Command,
    cancelled: &AtomicBool,
    timeout: Duration,
    diagnostics: bool,
    limit: usize,
) -> Result<Output, Outcome> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(Outcome::Cancelled);
    }
    let start = Instant::now();
    let child = command
        .stdout(Stdio::piped())
        .stderr(if diagnostics {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Outcome::Unavailable
            } else {
                Outcome::ExecutionError
            }
        })?;
    let mut child = OwnedChild(child);
    let mut pipe = child.0.stdout.take().ok_or(Outcome::ExecutionError)?;
    let mut errors = child.0.stderr.take();
    // Linux-only example: nonblocking drain keeps output bounded and permits
    // cancellation/deadline checks without an extra reader thread.
    unsafe {
        for fd in std::iter::once(pipe.as_raw_fd()).chain(errors.as_ref().map(AsRawFd::as_raw_fd)) {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(Outcome::ExecutionError);
            }
        }
    }
    let mut bytes = Vec::new();
    let mut diagnostic_bytes = 0;
    let mut errors_done = errors.is_none();
    let mut status = None;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(Outcome::Cancelled);
        }
        if start.elapsed() >= timeout {
            return Err(Outcome::Timeout);
        }
        let mut buffer = [0; 4096];
        // Drain a bounded chunk from both pipes each iteration. Retain only a
        // diagnostic byte count, never stderr text or a localized classifier.
        if let Some(errors) = errors.as_mut() {
            match errors.read(&mut buffer) {
                Ok(0) => errors_done = true,
                Ok(n) => {
                    diagnostic_bytes += n;
                    if diagnostic_bytes > limit {
                        return Err(Outcome::InvalidOutput);
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(Outcome::ExecutionError),
            }
        }
        match pipe.read(&mut buffer) {
            Ok(0) => {
                if let Some(status) = status.filter(|_| errors_done) {
                    return Ok(Output {
                        bytes,
                        success: status,
                        diagnostic_bytes,
                    });
                }
            }
            Ok(n) => {
                if bytes.len() + n > limit {
                    return Err(Outcome::InvalidOutput);
                }
                bytes.extend_from_slice(&buffer[..n]);
                continue;
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Outcome::ExecutionError),
        }
        status = child
            .0
            .try_wait()
            .map_err(|_| Outcome::ExecutionError)?
            .map(|s| s.success());
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn file(path: &Path) -> Result<File, Outcome> {
    if !path.is_absolute() {
        return Err(Outcome::InvalidRequest);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Outcome::SourceMissing
            } else {
                Outcome::Io
            }
        })?;
    if !file.metadata().map_err(|_| Outcome::Io)?.is_file() {
        return Err(Outcome::InvalidRequest);
    }
    Ok(file)
}
fn tool_command(prefix: &Path, tool: &str) -> Command {
    let mut command = Command::new(prefix.join("bin").join(tool));
    command
        .env("LD_LIBRARY_PATH", prefix.join("lib"))
        .env_remove("FFREPORT")
        .env_remove("LD_PRELOAD")
        .env_remove("LD_AUDIT")
        .stdin(Stdio::null());
    command
}
fn command(prefix: &Path) -> Command {
    let mut command = tool_command(prefix, "ffprobe");
    command.args(["-v", "error", "-of", "json"]);
    command
}
struct Args {
    companion: PathBuf,
    prefix: PathBuf,
    source: PathBuf,
    label: String,
    pure: Option<ExpectedMediaKind>,
    repeat: u32,
    timeout: Duration,
    scan: Option<bilikara_runtime::experimental_libav::ScanSelection>,
    remux: Option<ExpectedMediaKind>,
    keep_outputs: Option<PathBuf>,
}
fn args(args: &[OsString]) -> Option<Args> {
    if args.len() < 4 {
        return None;
    }
    let label = args[3].to_str()?;
    // Caller-supplied public identifier, never derived from a media filename.
    if label.is_empty()
        || label.len() > 64
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return None;
    }
    let mut result = Args {
        companion: (&args[0]).into(),
        prefix: (&args[1]).into(),
        source: (&args[2]).into(),
        label: label.into(),
        pure: None,
        repeat: 1,
        timeout: Duration::from_secs(5),
        scan: None,
        remux: None,
        keep_outputs: None,
    };
    if !result.companion.is_absolute()
        || !result.prefix.is_absolute()
        || !result.source.is_absolute()
    {
        return None;
    }
    let mut scan_index = None;
    let mut scan_kind = None;
    let mut args = args[4..].iter();
    while let Some(arg) = args.next() {
        match arg.to_str()? {
            "--copy-remux" => {
                if result.remux.is_some() {
                    return None;
                }
                result.remux = Some(match args.next()?.to_str()? {
                    "audio" => ExpectedMediaKind::Audio,
                    "video" => ExpectedMediaKind::Video,
                    _ => return None,
                });
            }
            "--keep-outputs" => {
                if result.keep_outputs.is_some() {
                    return None;
                }
                let path = PathBuf::from(args.next()?);
                if !path.is_absolute() {
                    return None;
                }
                result.keep_outputs = Some(path);
            }
            "--scan-stream" => {
                if scan_index.is_some() {
                    return None;
                }
                scan_index = Some(args.next()?.to_str()?.parse::<u32>().ok()?);
            }
            "--scan-kind" => {
                if scan_kind.is_some() {
                    return None;
                }
                scan_kind = Some(match args.next()?.to_str()? {
                    "audio" => ExpectedMediaKind::Audio,
                    "video" => ExpectedMediaKind::Video,
                    _ => return None,
                });
            }
            "--pure-rust" => {
                result.pure = Some(match args.next()?.to_str()? {
                    "audio" => ExpectedMediaKind::Audio,
                    "video" => ExpectedMediaKind::Video,
                    _ => return None,
                })
            }
            "--repeat" => {
                result.repeat = args.next()?.to_str()?.parse().ok()?;
                if !(1..=10).contains(&result.repeat) {
                    return None;
                }
            }
            "--timeout-ms" => {
                let ms: u64 = args.next()?.to_str()?.parse().ok()?;
                if !(1..=60000).contains(&ms) {
                    return None;
                }
                result.timeout = Duration::from_millis(ms);
            }
            "--cancelled" => CANCELLED.store(true, Ordering::Relaxed),
            _ => return None,
        }
    }
    match (scan_index, scan_kind) {
        (Some(stream_index), Some(expected_kind)) if result.pure.is_none() => {
            result.scan = Some(bilikara_runtime::experimental_libav::ScanSelection {
                stream_index,
                expected_kind,
            });
        }
        (None, None) => {}
        _ => return None,
    }
    if (result.remux.is_some() && (result.scan.is_some() || result.pure.is_some()))
        || (result.keep_outputs.is_some() && (result.remux.is_none() || result.repeat != 1))
    {
        return None;
    }
    Some(result)
}

pub fn run(arguments: &[OsString]) -> i32 {
    let Some(args) = args(arguments) else {
        eprintln!(
            "usage: libav_metadata compare /trusted/companion.so /same-build/prefix /absolute/sample PUBLIC_LABEL [--pure-rust audio|video | --scan-stream INDEX --scan-kind audio|video | --copy-remux audio|video [--keep-outputs /absolute/NEW-directory]] [--repeat 1..10] [--timeout-ms 1..60000] [--cancelled]"
        );
        return 2;
    };
    // Process-local developer signal handler; M1 gets the same atomic flag.
    unsafe {
        libc::signal(libc::SIGINT, cancel as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, cancel as *const () as libc::sighandler_t);
    }
    let total = Instant::now();
    let setup = Instant::now();
    let probe = if CANCELLED.load(Ordering::Relaxed) {
        Err(Outcome::Cancelled)
    } else {
        // SAFETY: explicit developer invocation authorizes this trusted native
        // companion/dependency prefix; never reached by ordinary startup.
        unsafe { LibavMetadataProbe::load(&args.companion) }.map_err(|e| Outcome::from(&e))
    };
    let load_us = setup.elapsed().as_micros();
    let setup = Instant::now();
    let reference_build = capture(
        command(&args.prefix).args([
            "-show_entries",
            "program_version=version,configuration:library_version=name,version",
        ]),
        &CANCELLED,
        args.timeout,
    )
    .and_then(|o| {
        if o.success {
            ReferenceBuild::parse(&o.bytes)
        } else {
            Err(Outcome::ExecutionError)
        }
    });
    let reference_identity_us = setup.elapsed().as_micros();
    if args.remux.is_some() {
        return remux::run(
            &args,
            &probe,
            &reference_build,
            load_us,
            reference_identity_us,
        );
    }
    if args.scan.is_some() {
        return packet_scan::run(
            &args,
            &probe,
            &reference_build,
            load_us,
            reference_identity_us,
        );
    }
    let same_build = probe
        .as_ref()
        .ok()
        .zip(reference_build.as_ref().ok())
        .is_some_and(|(p, r)| r.matches(p.backend_info()));
    let mut failed = false;
    for iteration in 1..=args.repeat {
        let run_start = Instant::now();
        let call = Instant::now();
        let raw = probe
            .as_ref()
            .map(|p| p.probe_metadata(&args.source, &CANCELLED));
        let libav_call_us = call.elapsed().as_micros();
        let conversion = Instant::now();
        let libav = match raw {
            Ok(result) => Observation::libav(result),
            Err(error) => Observation::error(*error),
        };
        let mut comparison_us = conversion.elapsed().as_micros();
        let call = Instant::now();
        let reference_output = match &reference_build {
            Err(error) => Err(*error),
            Ok(_) if !same_build => Err(Outcome::Unavailable),
            Ok(_) => file(&args.source).and_then(|file| {
                capture(
                    command(&args.prefix)
                        .args(DISCOVERY)
                        .args(["-fd", "0", "-show_entries", ENTRIES, "-i", "fd:"])
                        .stdin(Stdio::from(file)),
                    &CANCELLED,
                    args.timeout,
                )
            }),
        };
        let reference_process_probe_us = call.elapsed().as_micros();
        let conversion = Instant::now();
        let reference = match reference_output {
            Ok(o) => reference_metadata(&o.bytes, o.success),
            Err(error) => Observation::error(error),
        };
        comparison_us += conversion.elapsed().as_micros();
        let call = Instant::now();
        let pure = args.pure.map(|expected_kind| {
            let result = if CANCELLED.load(Ordering::Relaxed) {
                Err(Outcome::Cancelled)
            } else {
                file(&args.source).and_then(|_| {
                    probe_media(&MediaPathRequest {
                        schema_version: 1,
                        source: args.source.clone(),
                        expected_kind,
                    })
                    .map_err(|e| e.kind.into())
                })
            };
            PureObservation::new(expected_kind, result)
        });
        let pure_sample_scan_us = args.pure.map(|_| call.elapsed().as_micros());
        let conversion = Instant::now();
        let primary = compare(&libav, &reference, same_build);
        let secondary = pure.as_ref().map(|p| compare_pure(&libav, p));
        failed |= CANCELLED.load(Ordering::Relaxed)
            || primary.needs_analysis()
            || secondary.as_ref().is_some_and(Comparison::needs_analysis);
        comparison_us += conversion.elapsed().as_micros();
        let report = json!({
            "schema_version":1, "fixture_label":args.label, "iteration":iteration,
            "run_kind":if iteration==1 {"first_in_process"} else {"repeated_in_process"},
            "same_build":same_build, "comparison_cancelled":CANCELLED.load(Ordering::Relaxed),
            "same_build_checks":probe.as_ref().ok().zip(reference_build.as_ref().ok()).map(|(p,r)| r.checks(p.backend_info())),
            "identity": {
                "libav":probe.as_ref().ok().and_then(|p| libav_identity(p.backend_info()).ok()),
                "ffprobe":reference_build.as_ref().ok().and_then(|r| r.identity().ok()),
                "reference_identity_outcome":reference_build.as_ref().map(|_| Outcome::Success).unwrap_or_else(|e| *e),
                "configuration_comparison":"exact raw configuration and build/runtime versions checked in memory; path-bearing options omitted from report",
                "pure_rust":args.pure.map(|_| json!({"backend":"bilikara_runtime::probe_media","crate_version":env!("CARGO_PKG_VERSION"),"configuration":"existing default MP4 operation"}))
            },
            "inspection": {
                "libav":"stream_metadata: open_input + find_stream_info; packet reads and limited decoding possible",
                "ffprobe":"stream_metadata: open_input + find_stream_info; no packet/frame enumeration",
                "pure_rust":args.pure.map(|_| "MP4 exactly one requested track; structure and sample payload inspection; no complete decode"),
                "discovery":{"format_probe_bytes":65536,"probe_bytes":1048576,"analyze_media_us":1000000,"max_probe_packets":256,"max_streams":32,"skip_estimate_duration_from_pts":true},
                "differences":["both use seekable fd without filename hint; M1 pre-probes before open_input; CLI probes inside open_input", "M1 denies every subordinate io_open; CLI has fd-only protocols and disabled MOV drefs; caller must supply self-contained input", "M1 cancellation is cooperative; CLI deadline kills and reaps the reference; Pure Rust scan only checks cancellation before entry"],
                "complete_media_validation":"not_established", "media_acceptance":"not_requested", "authority":"developer_observation_only"
            },
            "libav":libav, "ffprobe":reference, "pure_rust":pure,
            "primary":primary,"secondary":secondary,
            "elapsed_us":{"companion_load_and_negotiate_once":load_us,"reference_identity_process_once":reference_identity_us,"libav_call":libav_call_us,"reference_process_startup_and_probe":reference_process_probe_us,"pure_rust_sample_scan":pure_sample_scan_us,"normalization_and_comparison":comparison_us,"run_before_serialization":run_start.elapsed().as_micros(),"process_setup_and_runs_before_serialization":total.elapsed().as_micros()},
            "timing_boundary":"monotonic wall time; libav call includes M1 open/discovery/conversion/cleanup; reference includes file open + child start/probe/drain/reap; per-call/run times exclude report serialization/output; cumulative process time includes earlier report output; setup-once values repeat for context, not per-run cost"
        });
        println!(
            "{}",
            serde_json::to_string(&report).expect("allowlisted report")
        );
        if CANCELLED.load(Ordering::Relaxed) {
            break;
        }
    }
    i32::from(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_reference_diagnostics_are_bounded_and_never_retained() {
        let flag = AtomicBool::new(false);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf summary; printf SECRET_TITLE >&2"]);
        let output =
            capture_with_diagnostics(&mut cmd, &flag, Duration::from_secs(2), true).unwrap();
        assert!(output.success);
        assert_eq!(output.bytes, b"summary");
        assert_eq!(output.diagnostic_bytes, 12);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "exec /usr/bin/head -c 100000 /dev/zero >&2"]);
        assert_eq!(
            capture_with_diagnostics(&mut cmd, &flag, Duration::from_secs(2), true).err(),
            Some(Outcome::InvalidOutput)
        );
    }
    #[test]
    fn reference_deadline_cancellation_output_bound_and_reaping() {
        let dir = std::env::temp_dir().join(format!("bilikara-m2-child-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("pid");
        for cancellation in [false, true] {
            let flag = AtomicBool::new(false);
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "echo $$ > \"$1\"; exec sleep 30", "m2"])
                .arg(&pidfile);
            let outcome = std::thread::scope(|scope| {
                if cancellation {
                    scope.spawn(|| {
                        let start = Instant::now();
                        while !pidfile.exists() && start.elapsed() < Duration::from_secs(2) {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        flag.store(true, Ordering::Relaxed);
                    });
                }
                capture(
                    &mut cmd,
                    &flag,
                    if cancellation {
                        Duration::from_secs(3)
                    } else {
                        Duration::from_millis(80)
                    },
                )
                .err()
                .unwrap()
            });
            assert_eq!(
                outcome,
                if cancellation {
                    Outcome::Cancelled
                } else {
                    Outcome::Timeout
                }
            );
            let pid: i32 = std::fs::read_to_string(&pidfile)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "child must be killed and reaped"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            std::fs::remove_file(&pidfile).unwrap();
        }
        let mut cmd = Command::new("/usr/bin/head");
        cmd.args(["-c", "100000", "/dev/zero"]);
        assert_eq!(
            capture(&mut cmd, &AtomicBool::new(false), Duration::from_secs(2)).err(),
            Some(Outcome::InvalidOutput)
        );
        assert_eq!(
            capture(
                &mut Command::new(dir.join("absent")),
                &AtomicBool::new(false),
                Duration::from_secs(2)
            )
            .err(),
            Some(Outcome::Unavailable)
        );
        std::fs::remove_dir(&dir).unwrap();
    }
}
