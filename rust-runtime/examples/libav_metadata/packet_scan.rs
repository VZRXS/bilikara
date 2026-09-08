//! M3 branch of the M2 runner; same child lifecycle, input checks and identity.
use super::*;
use bilikara_runtime::experimental_libav::comparison::packet_scan::*;
const PACKET_ENTRIES: &str =
    "stream=index,codec_type,codec_name,time_base,nb_read_packets:error=code";

pub(super) fn run(
    args: &Args,
    probe: &Result<LibavMetadataProbe, Outcome>,
    reference_build: &Result<ReferenceBuild, Outcome>,
    load_us: u128,
    inventory_identity_us: u128,
) -> i32 {
    let selection = args.scan.unwrap();
    let started = Instant::now();
    let ffmpeg_build = capture(
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
    let operational_identity_us = started.elapsed().as_micros();
    let matches = |b: &Result<ReferenceBuild, Outcome>| {
        probe
            .as_ref()
            .ok()
            .zip(b.as_ref().ok())
            .is_some_and(|(p, b)| b.matches(p.backend_info()))
    };
    let same_inventory = matches(reference_build);
    let same_operational = matches(&ffmpeg_build);
    let mut failed = false;
    for iteration in 1..=args.repeat {
        let start = Instant::now();
        let scan = match probe {
            Ok(p) => ScanObservation::new(
                selection,
                p.scan_packets(&args.source, selection, &CANCELLED),
            ),
            Err(e) => ScanObservation::error(selection, *e),
        };
        let scan_us = start.elapsed().as_micros();
        let start = Instant::now();
        let inventory = match reference_build {
            Err(e) => Inventory::error(*e),
            Ok(_) if !same_inventory => Inventory::error(Outcome::Unavailable),
            Ok(_) => {
                let output = file(&args.source).and_then(|file| {
                    capture_with_diagnostics(
                        command(&args.prefix)
                            .args(DISCOVERY)
                            .args([
                                "-fd",
                                "0",
                                "-count_packets",
                                "-select_streams",
                                &selection.stream_index.to_string(),
                                "-show_entries",
                                PACKET_ENTRIES,
                                "-i",
                                "fd:",
                            ])
                            .stdin(Stdio::from(file)),
                        &CANCELLED,
                        args.timeout,
                        true,
                    )
                });
                match output {
                    Ok(o) => reference_inventory(&o.bytes, o.success, o.diagnostic_bytes > 0),
                    Err(e) => Inventory::error(e),
                }
            }
        };
        let inventory_us = start.elapsed().as_micros();
        let start = Instant::now();
        let operational = match &ffmpeg_build {
            Err(e) => Operational::error(*e),
            Ok(_) if !same_operational => Operational::error(Outcome::Unavailable),
            Ok(_) => {
                let output = file(&args.source).and_then(|file| {
                    capture_with_diagnostics(
                        tool_command(&args.prefix, "ffmpeg")
                            .args(["-nostdin", "-v", "error", "-xerror"])
                            // Pinned MOV dref options default to zero. ffmpeg rejects
                            // MOV-only options as unused on FLAC; keep the defaults.
                            .args(
                                DISCOVERY
                                    .chunks_exact(2)
                                    .filter(|pair| {
                                        !matches!(pair[0], "-enable_drefs" | "-use_absolute_path")
                                    })
                                    .flatten(),
                            )
                            .args([
                                "-fd",
                                "0",
                                "-i",
                                "fd:",
                                "-map",
                                &format!("0:{}", selection.stream_index),
                                "-c",
                                "copy",
                                "-f",
                                "null",
                                "-",
                            ])
                            .stdin(Stdio::from(file)),
                        &CANCELLED,
                        args.timeout,
                        true,
                    )
                });
                match output {
                    Ok(o) => Operational {
                        outcome: if o.success {
                            Outcome::Success
                        } else {
                            Outcome::ExecutionError
                        },
                        process_completed: true,
                        diagnostics_present: o.diagnostic_bytes > 0,
                    },
                    Err(e) => Operational::error(e),
                }
            }
        };
        let operational_us = start.elapsed().as_micros();
        let inventory_comparison = compare_inventory(&scan, &inventory, same_inventory);
        let operational_comparison = compare_operational(&scan, &operational, same_operational);
        failed |= inventory_comparison.needs_analysis()
            || operational_comparison.needs_analysis()
            || CANCELLED.load(Ordering::Relaxed);
        let report = json!({
            "schema_version":1, "operation":"packet_scan", "fixture_label":args.label, "iteration":iteration,
            "scan_capability_schema":probe.as_ref().ok().filter(|p| p.packet_scan_available()).map(|_| 1),
            "requested":selection, "same_build":{"inventory":same_inventory,"operational":same_operational},
            "same_build_checks":{
                "ffprobe":probe.as_ref().ok().zip(reference_build.as_ref().ok()).map(|(p,b)| b.checks(p.backend_info())),
                "ffmpeg":probe.as_ref().ok().zip(ffmpeg_build.as_ref().ok()).map(|(p,b)| b.checks(p.backend_info()))
            },
            "identity":{
                "libav":probe.as_ref().ok().and_then(|p| libav_identity(p.backend_info()).ok()),
                "ffprobe":reference_build.as_ref().ok().and_then(|b| b.identity().ok()),
                "ffmpeg":ffmpeg_build.as_ref().ok().and_then(|b| b.ffmpeg_identity().ok())
            },
            "inspection":{
                "libav":"packet_scan: fresh open + discovery + buffered prefix + av_read_frame to terminal; selected aggregate only",
                "inventory":"ffprobe count_packets; exact selected index, same discovery settings; count only, no packet dump",
                "operational":"existing -v error -xerror -map 0:INDEX -c copy -f null -; also applies output/timestamp policy; no full decode",
                "incidental_scope":"companion demuxes other streams as needed; selected counts exclude them; observed incidental corruption retained separately and prevents clean EOF",
                "completion":"clean_eof requires EOF, selected packets, no structured error or observed corrupt flag; does not establish original completeness or decodability",
                "diagnostics":"reference stderr is counted and discarded, never parsed; zero exit with diagnostics is not clean parity; no per-call libav log interception",
                "complete_media_validation":"not_established", "media_acceptance":"not_requested", "authority":"developer_observation_only"
            },
            "libav":scan,"ffprobe":inventory,"ffmpeg":operational,
            "primary":inventory_comparison,"operational_comparison":operational_comparison,
            "elapsed_us":{"companion_load_and_negotiate_once":load_us,"inventory_identity_process_once":inventory_identity_us,"operational_identity_process_once":operational_identity_us,"libav_scan":scan_us,"inventory_process":inventory_us,"operational_process":operational_us},
            "timing_boundary":"monotonic wall time; native includes file open/discovery/scan/conversion/cleanup; references include file open/start/drain/reap; serialization excluded; setup-once repeated for context",
            "cancellation":"cooperative native flag observed before/after reads, including buffered reads; no hard native deadline; reference timeout kills/reaps child",
            "comparison_cancelled":CANCELLED.load(Ordering::Relaxed)
        });
        println!(
            "{}",
            serde_json::to_string(&report).expect("allowlisted scan report")
        );
        if CANCELLED.load(Ordering::Relaxed) {
            break;
        }
    }
    i32::from(failed)
}
