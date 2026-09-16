//! Desktop-only operational adapter. No scheduler, credentials store, installer,
//! media policy or publication authority lives here.
use super::*;
use std::ffi::OsString;
use std::io::Read;
use std::process::{Child, Command, Stdio};

#[derive(Clone, Debug)]
pub(crate) struct Executable(PathBuf);

impl Executable {
    #[cfg(test)]
    pub(super) fn fixture(path: PathBuf) -> Self {
        Self(path)
    }

    /// Trusted Host configuration only; never deserialize this from an API/FFI.
    pub(crate) fn discover(directory: &Path) -> Option<Self> {
        if let Some(path) = std::env::var_os("BB_DOWN_PATH").filter(|v| !v.is_empty()) {
            return Self::check(PathBuf::from(path)); // explicit missing override fails closed
        }
        let name = if cfg!(windows) {
            "BBDown.exe"
        } else {
            "BBDown"
        };
        let mut candidates = vec![directory.join("tools/bbdown").join(name)];
        if let Some(home) = std::env::var_os("BILIKARA_HOME") {
            candidates.push(PathBuf::from(home).join("tools/bbdown").join(name));
        }
        if let Ok(exe) = std::env::current_exe() {
            for root in exe.ancestors().skip(1).take(4) {
                for relative in [
                    "vendor",
                    "_internal/vendor",
                    "Resources/vendor",
                    "tools/bbdown",
                ] {
                    candidates.push(root.join(relative).join(name));
                }
            }
        }
        candidates.into_iter().find_map(Self::check)
    }

    fn check(path: PathBuf) -> Option<Self> {
        if !path.is_absolute() || !path.is_file() {
            return None;
        }
        let path = path.canonicalize().ok()?;
        // Offline capability check, bounded and supervised. No provider request.
        let mut command = Command::new(&path);
        command.arg("--help");
        let help = supervise(
            command,
            &AtomicBool::new(false),
            Duration::from_secs(5),
            true,
            || {},
        )
        .ok()?;
        let help = String::from_utf8_lossy(&help);
        if ![
            "BBDown version 1.6.3",
            "--skip-mux",
            "--skip-subtitle",
            "--skip-cover",
            "--skip-ai",
            "--video-only",
            "--audio-only",
            "--audio-ascending",
            "--work-dir",
            "--file-pattern",
            "--config-file",
        ]
        .iter()
        .all(|flag| help.contains(flag))
        {
            return None;
        }
        Some(Self(path))
    }
}

fn arguments(job: &CacheJobSpec, track: &TrackSpec, directory: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        format!("https://www.bilibili.com/video/{}", job.bvid).into(),
        "-p".into(),
        track.page.page.to_string().into(),
    ];
    if track.kind == ExpectedMediaKind::Video {
        let policy = decide_quality_policy(&QualityPolicyRequest {
            raw_quality: job.video_quality.clone(),
            raw_cap: job.avc_quality_cap.clone(),
            choice_index: None,
        });
        args.extend([
            "-q".into(),
            policy
                .bbdown_quality_order
                .iter()
                .map(|q| q.label())
                .collect::<Vec<_>>()
                .join(",")
                .into(),
            "-e".into(),
            "avc".into(),
        ]);
    } else if !job.audio_hires {
        args.push("--audio-ascending".into());
    }
    args.extend([
        "--work-dir".into(),
        directory.as_os_str().to_owned(),
        "--file-pattern".into(),
        track.key.clone().into(),
        "--skip-mux".into(),
        "--skip-subtitle".into(),
        "--skip-cover".into(),
        "--skip-ai".into(),
        if track.kind == ExpectedMediaKind::Video {
            "--video-only".into()
        } else {
            "--audio-only".into()
        },
        // Do not inherit a BBDown.config enabling a muxer or aria2c.
        "--config-file".into(),
        directory.join("empty.config").into(),
    ]);
    // Always pass the P02 snapshot, using a noncredential separator when empty, rather than letting BBDown
    // pick up a credential file beside a bundled/installed executable.
    args.extend([
        "-c".into(),
        if job.cookie.is_empty() {
            ";".into()
        } else {
            job.cookie.clone().into()
        },
    ]);
    args
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: child started in its own process group; never target our group.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Drain both streams concurrently, retaining only bounded offline help. Download
/// output is never logged, parsed or returned: it can contain cookies/URLs.
fn supervise(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    capture: bool,
    mut progress: impl FnMut(),
) -> Result<Vec<u8>, CacheRuntimeError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW, no shell
    }
    if cancel.load(Ordering::Acquire) {
        return Err(CacheRuntimeError::new("cancelled", "BBDown cancelled"));
    }
    let mut child = OwnedChild(command.spawn().map_err(|_| CacheRuntimeError::new("unavailable", "BBDown could not start; configure an installed compatible executable with BB_DOWN_PATH and restart Host"))?);
    fn drain(mut input: impl Read, capture: bool) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(size) = input.read(&mut buffer) {
            if size == 0 {
                break;
            }
            if capture {
                output.extend_from_slice(&buffer[..size.min(65536 - output.len())]);
            }
        }
        output
    }
    let stdout = child.0.stdout.take().unwrap();
    let stderr = child.0.stderr.take().unwrap();
    thread::scope(|scope| {
        let out = scope.spawn(move || drain(stdout, capture));
        scope.spawn(move || drain(stderr, false));
        let start = Instant::now();
        let result = loop {
            if cancel.load(Ordering::Acquire) {
                break Err(CacheRuntimeError::new("cancelled", "BBDown cancelled"));
            }
            if start.elapsed() > timeout {
                break Err(CacheRuntimeError::new("tool_timeout", "BBDown timed out"));
            }
            match child.0.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(_)) => {
                    break Err(CacheRuntimeError::new(
                        "tool_exit",
                        "BBDown failed; check installed version, login and source access, then retry",
                    ));
                }
                Err(_) => {
                    break Err(CacheRuntimeError::new(
                        "tool_process",
                        "BBDown process status unavailable",
                    ));
                }
                Ok(None) => {
                    progress();
                    thread::sleep(Duration::from_millis(100));
                }
            }
        };
        drop(child); // terminate/reap before joining pipe readers, including cancellation
        let output = out.join().unwrap_or_default();
        result.map(|()| output)
    })
}

// BBDown 1.6.3 skip-mux output may be in its CID subdirectory. Require exactly
// one nonempty regular media file in this track's private directory; never guess
// the largest file, follow symlinks, or consume an adjacent attempt's output.
fn output(directory: &Path) -> Result<PathBuf, CacheRuntimeError> {
    let mut directories = vec![(directory.to_path_buf(), 0)];
    let mut media = Vec::new();
    let mut count = 0;
    while let Some((dir, depth)) = directories.pop() {
        for entry in fs::read_dir(dir)
            .map_err(|_| CacheRuntimeError::new("io", "BBDown output unreadable"))?
        {
            let entry =
                entry.map_err(|_| CacheRuntimeError::new("io", "BBDown output unreadable"))?;
            count += 1;
            let meta = fs::symlink_metadata(entry.path())
                .map_err(|_| CacheRuntimeError::new("io", "BBDown output unreadable"))?;
            if count > 512 || meta.file_type().is_symlink() || (meta.is_dir() && depth >= 4) {
                return Err(CacheRuntimeError::new(
                    "media_contract_violation",
                    "BBDown output escaped the bounded track contract",
                ));
            }
            if meta.is_dir() {
                directories.push((entry.path(), depth + 1));
            } else if meta.is_file()
                && matches!(
                    entry.path().extension().and_then(|s| s.to_str()),
                    Some("mp4" | "m4a" | "aac" | "flac" | "m4s")
                )
            {
                if meta.len() == 0 {
                    return Err(CacheRuntimeError::new(
                        "invalid_media",
                        "BBDown output is empty",
                    ));
                }
                media.push(entry.path());
            }
        }
    }
    match media.len() {
        0 => Err(CacheRuntimeError::new(
            "source_missing",
            "BBDown exited without a required media track",
        )),
        1 => Ok(media.remove(0)),
        _ => Err(CacheRuntimeError::new(
            "media_contract_violation",
            "BBDown produced ambiguous track outputs",
        )),
    }
}

pub(super) fn run_track(
    executable: &Executable,
    shared: &Arc<SharedRuntime>,
    job: &QueuedJob,
    track: &TrackSpec,
    cancel: &Arc<AtomicBool>,
) -> Result<TrackResult, CacheRuntimeError> {
    if let Some(message) = crate::desktop_login::download_login_error("bbdown", &job.spec.cookie) {
        append_log(&job.spec.log_file, "download_login_required source=bbdown");
        return Err(CacheRuntimeError::new("authentication", message));
    }
    append_log(
        &job.spec.log_file,
        "download_credentials_loaded source=bbdown (attempt login; credentials redacted)",
    );
    // Reuse the Native resolver/rankers only as a supported-DASH preflight.
    // BBDown owns the transfer. In particular reject non-DASH segmented input
    // before BBDown's legacy segment merger can try a media CLI.
    emit_track_progress(shared, job, track, "resolving", 1, (0, 0));
    resolve_track_stream(&job.spec, track)?;
    let directory = job
        .spec
        .cache_root
        .join(".staging")
        .join(&job.reservation.item_incarnation_id)
        .join(&job.reservation.artifact_set_id)
        .join(&track.key);
    fs::create_dir(&directory)
        .map_err(|_| CacheRuntimeError::new("io", "Cannot create BBDown track directory"))?;
    fs::write(directory.join("empty.config"), b"")
        .map_err(|_| CacheRuntimeError::new("io", "Cannot isolate BBDown configuration"))?;
    let mut command = Command::new(&executable.0);
    command
        .args(arguments(&job.spec, track, &directory))
        .current_dir(&directory)
        .env("PATH", "");
    emit_track_progress(shared, job, track, "downloading", 1, (0, 0));
    let mut last_progress = Instant::now();
    supervise(command, cancel, Duration::from_secs(3600), false, || {
        if last_progress.elapsed() >= Duration::from_secs(1) {
            emit_track_progress(shared, job, track, "downloading", 1, (0, 0));
            last_progress = Instant::now();
        }
    })?;
    let source = output(&directory)?;
    // Inspect the actual codec: BBDown names FLAC-in-MP4 audio .m4a too.
    let inspection = crate::media_routing::inspect(
        &crate::media_routing::InspectRequest {
            schema_version: 1,
            operation: crate::media_routing::Operation::Metadata,
            source: source.clone(),
            expected_kind: track.kind,
            container_hint: None,
            compatibility: None,
        },
        cancel,
        &|| false,
    )
    .map_err(|e| CacheRuntimeError::new(e.kind, e.message))?;
    let codec = match inspection {
        crate::media_routing::Inspection::Completed { metadata, .. } => metadata
            .streams
            .first()
            .and_then(|stream| stream.codec.clone()),
        crate::media_routing::Inspection::Compatibility { .. } => {
            // The same retained Rust MP4 probe used by Native normalization.
            // There is no CLI compatibility execution in this Host.
            Some(
                crate::media_backend::probe_media(&crate::media_backend::MediaPathRequest {
                    schema_version: 1,
                    source: source.clone(),
                    expected_kind: track.kind,
                })
                .map_err(|e| {
                    CacheRuntimeError::new(
                        e.kind.as_str(),
                        "BBDown output failed native media inspection",
                    )
                })?
                .codec,
            )
        }
    };
    let flac = codec.as_deref() == Some("flac");
    let extension = if flac {
        "flac"
    } else if track.kind == ExpectedMediaKind::Video {
        "mp4"
    } else {
        "m4a"
    };
    let final_name = format!("{}.{}", track.key, extension);
    let destination = directory.join(format!("normalized-{final_name}"));
    let probe = normalize_track(&job.spec, track, &source, &destination, cancel)?;
    emit_track_progress(
        shared,
        job,
        track,
        "ready",
        1,
        (probe.file_bytes, probe.file_bytes),
    );
    Ok(TrackResult {
        spec: track.clone(),
        temporary_path: destination,
        final_name,
        probe,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> CacheJobSpec {
        serde_json::from_value(json!({"item_id":"a", "item_incarnation_id":"incarnation", "bvid":"BV1xx411c7mD", "video_page":2,
            "pages":[{"page":2,"cid":22},{"page":1,"cid":11}], "cache_root":"/tmp/cache", "log_file":"/tmp/log",
            "cookie":"SESSDATA=synthetic secret; bili_jct=synthetic", "video_quality":"1080P 高清", "avc_quality_cap":"480P 清晰"})).unwrap()
    }
    #[test]
    fn typed_arguments_capture_pages_quality_cookie_and_skip_mux_without_cli() {
        let job = job();
        let tracks = track_specs(&job).unwrap();
        let directory = std::env::temp_dir().join("BBDown 空 path");
        let args = arguments(&job, &tracks[0], &directory);
        let pairs = |key: &str| args.windows(2).find(|p| p[0] == key).unwrap()[1].clone();
        assert_eq!(pairs("-p"), "2");
        assert_eq!(pairs("--work-dir"), directory.as_os_str());
        assert_eq!(pairs("-c"), job.cookie.as_str());
        assert_eq!(pairs("-e"), "avc");
        let policy = decide_quality_policy(&QualityPolicyRequest {
            raw_quality: job.video_quality.clone(),
            raw_cap: job.avc_quality_cap.clone(),
            choice_index: None,
        });
        assert_eq!(
            pairs("-q"),
            policy
                .bbdown_quality_order
                .iter()
                .map(|q| q.label())
                .collect::<Vec<_>>()
                .join(",")
                .as_str()
        );
        assert!(args.contains(&"--skip-mux".into()));
        assert!(args.contains(&"--video-only".into()));
        assert!(!args.iter().any(|a| a.to_string_lossy().contains("ffmpeg")
            || a.to_string_lossy().contains("ffprobe")
            || a.to_string_lossy().contains("aria2")));
        assert_eq!(
            tracks.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
            ["video-p2", "audio-p2", "audio-p1"]
        );
        assert!(arguments(&job, &tracks[1], &directory).contains(&"--audio-ascending".into()));
        let mut hires = job.clone();
        hires.audio_hires = true;
        hires.cookie.clear();
        let args = arguments(&hires, &tracks[1], &directory);
        assert!(!args.contains(&"--audio-ascending".into()));
        assert_eq!(args.last().unwrap(), ";"); // blocks BBDown's adjacent credential fallback
    }
    #[test]
    fn wire_cannot_select_a_desktop_executor() {
        assert!(matches!(job().executor, Executor::Native));
        let mut wire = json!({"item_id":"a","item_incarnation_id":"b","bvid":"BV1xx411c7mD","video_page":1,"pages":[],"cache_root":"/tmp/c","log_file":"/tmp/l"});
        wire["executor"] = json!({"bbdown":"/arbitrary/program"});
        assert!(serde_json::from_value::<CacheJobSpec>(wire).is_err());
    }
    #[test]
    fn output_requires_one_owned_nonempty_file() {
        let root = std::env::temp_dir().join(format!(
            "bbdown-output-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        assert_eq!(output(&root).unwrap_err().kind, "source_missing");
        fs::write(root.join("audio.m4a"), b"").unwrap();
        assert_eq!(output(&root).unwrap_err().kind, "invalid_media");
        fs::write(root.join("audio.m4a"), b"must still pass media validation").unwrap();
        assert_eq!(output(&root).unwrap(), root.join("audio.m4a"));
        fs::write(root.join("extra.mp4"), b"ambiguous").unwrap();
        assert_eq!(output(&root).unwrap_err().kind, "media_contract_violation");
        fs::remove_file(root.join("extra.mp4")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("audio.m4a"), root.join("link.m4a")).unwrap();
            assert_eq!(output(&root).unwrap_err().kind, "media_contract_violation");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn supervisor_drains_redacts_cancels_reaps_and_bounds_help() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf credential-secret; printf credential-secret >&2; exit 9",
        ]);
        let error = supervise(
            command,
            &AtomicBool::new(false),
            Duration::from_secs(2),
            false,
            || {},
        )
        .unwrap_err();
        assert_eq!(error.kind, "tool_exit");
        assert!(!error.message.contains("credential-secret"));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "yes output | head -c 200000"]);
        assert_eq!(
            supervise(
                command,
                &AtomicBool::new(false),
                Duration::from_secs(2),
                true,
                || {}
            )
            .unwrap()
            .len(),
            65536
        );
        let cancel = AtomicBool::new(false);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let start = Instant::now();
        let error = supervise(command, &cancel, Duration::from_secs(2), false, || {
            cancel.store(true, Ordering::Release)
        })
        .unwrap_err();
        assert_eq!(error.kind, "cancelled");
        assert!(start.elapsed() < Duration::from_secs(2));
        let error = supervise(
            Command::new("/nonexistent/bbdown"),
            &AtomicBool::new(false),
            Duration::from_secs(1),
            false,
            || {},
        )
        .unwrap_err();
        assert_eq!(error.kind, "unavailable");
        assert!(Executable::check(PathBuf::from("/bin/true")).is_none());
    }
}
