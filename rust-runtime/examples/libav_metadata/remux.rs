//! Explicit paired transform experiment; no application graph uses this driver.
use super::*;
use bilikara_runtime::experimental_libav::{
    CopyProfile, CopyRemuxRequest, ScanSelection,
    comparison::{packet_scan::ScanObservation, remux as content},
};
#[cfg(target_os = "linux")]
use std::os::unix::fs::DirBuilderExt;

#[path = "flac.rs"]
mod flac;

const COPY_OUTPUT: &[&str] = &[
    "-map",
    "0:0",
    "-c",
    "copy",
    "-copytb",
    "1",
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-fflags",
    "-autobsf",
    "-avoid_negative_ts",
    "disabled",
    "-movflags",
    "+faststart",
    "-use_editlist",
    "1",
    "-f",
    "mp4",
    "-n",
];
const FLAC_OUTPUT: &[&str] = &[
    "-map",
    "0:0",
    "-c",
    "copy",
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-fflags",
    "-autobsf",
    "-avoid_negative_ts",
    "disabled",
    "-write_header",
    "1",
    "-f",
    "flac",
    "-n",
];
const CONTENT_ENTRIES: &str = "stream=index,codec_name,time_base,extradata:packet=stream_index,pts,dts,duration,size,data:packet_side_data=side_data_type,skip_samples,discard_padding,skip_reason,discard_reason";

struct Experiment {
    path: PathBuf,
    keep: bool,
}
impl Experiment {
    fn new(keep: Option<&Path>) -> Result<Self, Outcome> {
        let path = match keep {
            Some(path) => path.to_owned(),
            None => {
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).map_err(|_| Outcome::ExecutionError)?;
                std::env::temp_dir()
                    .join(format!("bilikara-m5-{:032x}", u128::from_ne_bytes(nonce)))
            }
        };
        private_directory(&path).map_err(|_| Outcome::Io)?;
        Ok(Self {
            path,
            keep: keep.is_some(),
        })
    }
}
impl Drop for Experiment {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
fn bounded_content(args: &Args, path: &Path) -> Result<(content::EncodedSample, bool), Outcome> {
    let file = file(path)?;
    if file.metadata().map_err(|_| Outcome::Io)?.len() > content::MAX_MEDIA_BYTES {
        return Err(Outcome::InvalidRequest);
    }
    let result = capture_limited(
        command(&args.prefix)
            .args(DISCOVERY)
            .args([
                "-fd",
                "0",
                "-show_packets",
                "-show_data",
                "-show_entries",
                CONTENT_ENTRIES,
                "-i",
                "fd:",
            ])
            .stdin(Stdio::from(file)),
        &CANCELLED,
        args.timeout,
        true,
        content::MAX_CONTENT_JSON,
    )?;
    if !result.success {
        return Err(Outcome::ExecutionError);
    }
    // Keep diagnostic presence distinct from the encoded-content comparison.
    // No stderr classifier or full decode certificate is introduced.
    Ok((content::parse(&result.bytes)?, result.diagnostic_bytes > 0))
}
fn observations(
    probe: &LibavMetadataProbe,
    path: &Path,
    kind: ExpectedMediaKind,
) -> serde_json::Value {
    let metadata = Observation::libav(probe.probe_metadata(path, &CANCELLED));
    let selection = ScanSelection {
        stream_index: 0,
        expected_kind: kind,
    };
    let scan = ScanObservation::new(selection, probe.scan_packets(path, selection, &CANCELLED));
    json!({"metadata":metadata, "scan":scan})
}

pub(super) fn run(
    args: &Args,
    probe: &Result<LibavMetadataProbe, Outcome>,
    reference: &Result<ReferenceBuild, Outcome>,
    load_us: u128,
    inventory_us: u128,
) -> i32 {
    let start = Instant::now();
    let ffmpeg = capture(
        tool_command(&args.prefix, "ffmpeg").arg("-version"),
        &CANCELLED,
        args.timeout,
    )
    .and_then(|o| {
        if o.success {
            ReferenceBuild::parse_ffmpeg(&o.bytes)
        } else {
            Err(Outcome::ExecutionError)
        }
    });
    let ffmpeg_identity_us = start.elapsed().as_micros();
    let matches = |r: &Result<ReferenceBuild, Outcome>| {
        probe
            .as_ref()
            .ok()
            .zip(r.as_ref().ok())
            .is_some_and(|(p, r)| r.matches(p.backend_info()))
    };
    let same_build = matches(reference) && matches(&ffmpeg);
    let flac = args.profile == CopyProfile::Flac;
    let output_options = if flac { FLAC_OUTPUT } else { COPY_OUTPUT };
    let mut failed = false;
    for iteration in 1..=args.repeat {
        let started = Instant::now();
        let effective_command = [
            &["-nostdin", "-v", "error", "-xerror", "-copyts"][..],
            DISCOVERY,
            &["-fd", "0", "-i", "fd:"],
            output_options,
            &["OWNED_REFERENCE_OUTPUT"],
        ]
        .concat();
        let mut report = json!({"schema_version":1, "operation":"copy_remux", "profile":args.profile.name(),
            "fixture_label":args.label, "iteration":iteration, "expected_kind":args.remux,
            "same_build":same_build, "capability_schema":probe.as_ref().ok().filter(|p| p.copy_profile_available(args.profile)).map(|_| 1),
            "identity":{"libav":probe.as_ref().ok().and_then(|p| libav_identity(p.backend_info()).ok()),
                "ffprobe":reference.as_ref().ok().and_then(|r| r.identity().ok()), "ffmpeg":ffmpeg.as_ref().ok().and_then(|r| r.ffmpeg_identity().ok())},
            "same_build_checks":{"ffprobe":probe.as_ref().ok().zip(reference.as_ref().ok()).map(|(p,r)| r.checks(p.backend_info())),
                "ffmpeg":probe.as_ref().ok().zip(ffmpeg.as_ref().ok()).map(|(p,r)| r.checks(p.backend_info()))},
            "inspection":{"authority":"experimental_artifacts_only", "complete_media_validation":"not_established", "media_acceptance":"not_requested",
                "timing":"preserve media timeline; actual post-header time base; no repair/zero shift; edit lists enabled; known PTS/DTS/positive durations required",
                "content_bound":{"media_bytes":content::MAX_MEDIA_BYTES,"packets":content::MAX_PACKETS,"json_bytes":content::MAX_CONTENT_JSON},
                "evidence":"shared libav; no independent decoder or playback certificate; not a cache-ready projection"},
            "reference_command":{"program":if cfg!(windows) {"RESTORED_CLI/ffmpeg.exe"} else {"FFMPEG_PREFIX/bin/ffmpeg"}, "arguments":effective_command,
                "input":"read-only source descriptor on stdin", "environment":if cfg!(windows) {"restored package directory; inherited minimal Windows system PATH"} else {"child-only LD_LIBRARY_PATH=FFMPEG_PREFIX/lib; FFREPORT/LD_PRELOAD/LD_AUDIT removed"}},
            "outputs_retained":args.keep_outputs.is_some(),
            "elapsed_us":{"companion_load_once":load_us, "ffprobe_identity_once":inventory_us,"ffmpeg_identity_once":ffmpeg_identity_us}
        });
        if flac {
            report["inspection"]["timing"] = json!(
                "complete encoded samples in order, original rate/channels/precision; zero-start continuous untrimmed profile; reject demux-visible offsets/gaps/skip/discard/configuration changes; raw FLAC has no MP4 presentation timeline"
            );
            report["inspection"]["evidence"] = json!(
                "shared libav metadata/scan/streamcopy; full bounded PCM + independent Claxon diagnostic oracle; no playback certificate"
            );
            report["inspection"]["metadata_policy"] = json!(
                "preserve full STREAMINFO including unknown values; no input tags/chapters/artwork; muxer vendor comment and default padding allowed; no byte-identity requirement"
            );
        }
        let result = (|| -> Result<(), Outcome> {
            let p = probe.as_ref().map_err(|e| *e)?;
            if !p.copy_profile_available(args.profile) || !same_build {
                return Err(Outcome::Unavailable);
            }
            if CANCELLED.load(Ordering::Relaxed) {
                return Err(Outcome::Cancelled);
            }
            // Bounded content evidence is mandatory for this explicit small-
            // fixture comparison, never an unbounded full-file packet dump.
            if file(&args.source)?
                .metadata()
                .map_err(|_| Outcome::Io)?
                .len()
                > content::MAX_MEDIA_BYTES
            {
                return Err(Outcome::InvalidRequest);
            }
            let experiment = Experiment::new(args.keep_outputs.as_deref())?;
            let native_path = experiment
                .path
                .join(format!("companion.{}", args.profile.extension()));
            let cli_path = experiment
                .path
                .join(format!("reference.{}", args.profile.extension()));
            let kind = args.remux.unwrap();
            report["input"] = observations(p, &args.source, kind);
            let start = Instant::now();
            let native = p.copy_profile(
                &CopyRemuxRequest {
                    source: &args.source,
                    destination: &native_path,
                    expected_kind: kind,
                },
                args.profile,
                &CANCELLED,
            );
            report["elapsed_us"]["native_transform"] = json!(start.elapsed().as_micros());
            // A contract failure cannot authorize the CLI to drop extra tracks.
            let native = native.map_err(|e| {
                report["companion"] = json!({"outcome":Outcome::from(&e),"published":false});
                Outcome::from(&e)
            })?;
            report["companion"] = json!({"outcome":"success", "result":native});
            let start = Instant::now();
            let cli = capture_with_diagnostics(
                tool_command(&args.prefix, "ffmpeg")
                    .args(["-nostdin", "-v", "error", "-xerror", "-copyts"])
                    .args(DISCOVERY)
                    .args(["-fd", "0", "-i", "fd:"])
                    .args(output_options)
                    .arg(&cli_path)
                    .stdin(Stdio::from(file(&args.source)?)),
                &CANCELLED,
                args.timeout,
                true,
            )?;
            report["elapsed_us"]["reference_transform"] = json!(start.elapsed().as_micros());
            report["reference"] = json!({"outcome":if cli.success { Outcome::Success } else { Outcome::ExecutionError },"diagnostics_present":cli.diagnostic_bytes > 0});
            if !cli.success {
                return Err(Outcome::ExecutionError);
            }
            report["reference"]["observations"] = observations(p, &cli_path, kind);
            // Existing read-only S3 probe supplies layout facts for the CLI
            // artifact too; it does not normalize or publish anything.
            if !flac {
                let layout = probe_media(&MediaPathRequest {
                    schema_version: 1,
                    source: cli_path.clone(),
                    expected_kind: kind,
                })
                .map_err(|e| Outcome::from(e.kind))?;
                report["reference"]["layout"] =
                    json!({"leading_moov":layout.fast_start,"fragmented":layout.fragmented});
                if !layout.fast_start || layout.fragmented {
                    return Err(Outcome::InvalidOutput);
                }
            }
            let artifact_pair = compare(
                &Observation::libav(p.probe_metadata(&native_path, &CANCELLED)),
                &Observation::libav(p.probe_metadata(&cli_path, &CANCELLED)),
                same_build,
            );
            let artifact_bad = artifact_pair.needs_analysis();
            report["artifact_metadata_comparison"] = json!(artifact_pair);
            if artifact_bad {
                return Err(Outcome::InvalidOutput);
            }
            // Same-build M2 reference metadata semantics for each artifact.
            for (name, path) in [
                ("input", &args.source),
                ("companion_output", &native_path),
                ("reference_output", &cli_path),
            ] {
                let metadata = Observation::libav(p.probe_metadata(path, &CANCELLED));
                let r = capture(
                    command(&args.prefix)
                        .args(DISCOVERY)
                        .args(["-fd", "0", "-show_entries", ENTRIES, "-i", "fd:"])
                        .stdin(Stdio::from(file(path)?)),
                    &CANCELLED,
                    args.timeout,
                )?;
                let pair = compare(
                    &metadata,
                    &reference_metadata(&r.bytes, r.success),
                    same_build,
                );
                let bad = pair.needs_analysis();
                report["metadata_comparison"][name] = json!(pair);
                if bad {
                    return Err(Outcome::InvalidOutput);
                }
            }
            let (input, input_diagnostics) = bounded_content(args, &args.source)?;
            let (native_content, native_diagnostics) = bounded_content(args, &native_path)?;
            let (reference_content, reference_diagnostics) = bounded_content(args, &cli_path)?;
            report["content_reference_diagnostics"] = json!({"input":input_diagnostics,"companion_output":native_diagnostics,"reference_output":reference_diagnostics});
            report["clean_reference_execution"] = json!(
                cli.diagnostic_bytes == 0
                    && !input_diagnostics
                    && !native_diagnostics
                    && !reference_diagnostics
            );
            let checks = [
                content::compare(&input, &native_content),
                content::compare(&input, &reference_content),
                content::compare(&native_content, &reference_content),
            ];
            let ok = checks.iter().all(|c| c.matches);
            report["content_comparison"] = json!({"input_to_companion":checks[0], "input_to_reference":checks[1], "companion_to_reference":checks[2]});
            report["output_bytes"] = json!({"companion":native.output_bytes, "reference":std::fs::metadata(&cli_path).map_err(|_| Outcome::Io)?.len()});
            if !ok {
                return Err(Outcome::InvalidOutput);
            }
            if flac {
                flac::verify(
                    args,
                    p,
                    &experiment.path,
                    &native_path,
                    &cli_path,
                    &mut report,
                )?;
            }
            Ok(())
        })();
        report["outcome"] = json!(
            result
                .as_ref()
                .map(|_| Outcome::Success)
                .unwrap_or_else(|e| *e)
        );
        report["elapsed_us"]["total"] = json!(started.elapsed().as_micros());
        report["comparison_cancelled"] = json!(CANCELLED.load(Ordering::Relaxed));
        failed |= result.is_err();
        println!(
            "{}",
            serde_json::to_string(&report).expect("allowlisted remux report")
        );
        if CANCELLED.load(Ordering::Relaxed) {
            break;
        }
    }
    i32::from(failed)
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(target_os = "linux")]
    builder.mode(0o700);
    builder.create(path)
}
