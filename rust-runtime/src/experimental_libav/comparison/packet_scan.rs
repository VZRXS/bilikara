//! M3 allowlisted summaries and exact selected-stream inventory comparison.
use super::*;
use crate::experimental_libav::{PacketScan, PacketSummary, ScanSelection, ScanTerminal};

#[derive(Debug, Clone, Serialize)]
pub struct ScanObservation {
    pub outcome: Outcome,
    pub terminal: ScanTerminal,
    pub clean_eof: bool,
    pub requested: ScanSelection,
    pub selected: Option<PacketSummary>,
    pub demuxed_packets: u64,
    pub incidental_corrupt_packets: u64,
}
impl ScanObservation {
    pub fn new(requested: ScanSelection, result: Result<PacketScan, ProbeError>) -> Self {
        match result {
            Ok(mut scan) => {
                if scan.requested != requested
                    || scan.inspection_level != super::super::InspectionLevel::PacketScan
                    || scan
                        .selected
                        .as_ref()
                        .is_some_and(|s| s.codec_name.as_deref().is_some_and(|c| !token(c)))
                {
                    return Self::error(requested, Outcome::InvalidOutput);
                }
                if let Some(s) = &mut scan.selected {
                    match s.time_base.map(rational).transpose() {
                        Ok(b) => s.time_base = b,
                        Err(o) => return Self::error(requested, o),
                    }
                }
                let clean_eof = scan.clean_eof();
                let outcome = scan
                    .error
                    .as_ref()
                    .map(Outcome::from)
                    .unwrap_or(if clean_eof {
                        Outcome::Success
                    } else {
                        Outcome::InvalidOutput
                    });
                Self {
                    outcome,
                    terminal: scan.terminal,
                    clean_eof,
                    requested,
                    selected: scan.selected,
                    demuxed_packets: scan.demuxed_packets,
                    incidental_corrupt_packets: scan.incidental_corrupt_packets,
                }
            }
            Err(e) => Self::error(requested, Outcome::from(&e)),
        }
    }
    pub fn error(requested: ScanSelection, outcome: Outcome) -> Self {
        Self {
            outcome,
            requested,
            terminal: ScanTerminal::Incomplete,
            clean_eof: false,
            selected: None,
            demuxed_packets: 0,
            incidental_corrupt_packets: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct InventoryStream {
    pub index: u32,
    pub media_type: StreamType,
    pub codec_name: Option<String>,
    pub time_base: Option<TimeBase>,
    pub packet_count: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Inventory {
    pub outcome: Outcome,
    pub process_completed: bool,
    pub diagnostics_present: bool,
    pub reference_error_code: Option<i64>,
    pub streams: Vec<InventoryStream>,
}
impl Inventory {
    pub fn error(outcome: Outcome) -> Self {
        Self {
            outcome,
            process_completed: false,
            diagnostics_present: false,
            reference_error_code: None,
            streams: vec![],
        }
    }
}
/// Narrow -count_packets adapter. No packet JSON list, tags or stderr retained.
pub fn reference_inventory(
    bytes: &[u8],
    exit_success: bool,
    diagnostics_present: bool,
) -> Inventory {
    let parse = || -> Result<Inventory, Outcome> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Outcome::InvalidOutput)?;
        let code = integer(&value["error"]["code"])?;
        if !exit_success || !value["error"].is_null() {
            let mut r = Inventory::error(if matches!(code, Some(-1094995529 | -541478725)) {
                Outcome::InvalidMedia
            } else {
                Outcome::ExecutionError
            });
            r.process_completed = true;
            r.diagnostics_present = diagnostics_present;
            r.reference_error_code = code;
            return Ok(r);
        }
        let array = value["streams"].as_array().ok_or(Outcome::InvalidOutput)?;
        if array.len() > 1 {
            return Err(Outcome::InvalidOutput);
        }
        let mut streams = Vec::new();
        for s in array {
            let codec_name = match &s["codec_name"] {
                Value::Null => None,
                Value::String(s) if s == "unknown" || s == "N/A" => None,
                Value::String(s) if token(s) => Some(s.clone()),
                _ => return Err(Outcome::InvalidOutput),
            };
            let time_base = match s["time_base"].as_str() {
                None | Some("N/A" | "0/0") => None,
                Some(s) => {
                    let (n, d) = s.split_once('/').ok_or(Outcome::InvalidOutput)?;
                    Some(rational(TimeBase {
                        numerator: n.parse().map_err(|_| Outcome::InvalidOutput)?,
                        denominator: d.parse().map_err(|_| Outcome::InvalidOutput)?,
                    })?)
                }
            };
            let packet_count = match &s["nb_read_packets"] {
                Value::Null => None,
                Value::String(s) if s == "N/A" => None,
                Value::String(s) => Some(s.parse::<u64>().map_err(|_| Outcome::InvalidOutput)?),
                Value::Number(n) => Some(n.as_u64().ok_or(Outcome::InvalidOutput)?),
                _ => return Err(Outcome::InvalidOutput),
            };
            streams.push(InventoryStream {
                index: integer(&s["index"])?
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or(Outcome::InvalidOutput)?,
                media_type: match s["codec_type"].as_str() {
                    Some("audio") => StreamType::Audio,
                    Some("video") => StreamType::Video,
                    _ => return Err(Outcome::InvalidOutput),
                },
                codec_name,
                time_base,
                packet_count,
            });
        }
        Ok(Inventory {
            outcome: if streams.is_empty() {
                Outcome::InvalidRequest
            } else {
                Outcome::Success
            },
            process_completed: true,
            diagnostics_present,
            reference_error_code: None,
            streams,
        })
    };
    parse().unwrap_or_else(Inventory::error)
}
fn exact(result: &mut Comparison, field: &str, a: Value, b: Value, clean: bool) {
    let (kind, reason) = if a.is_null() || b.is_null() {
        (Kind::NotComparable, "unknown field; no value inferred")
    } else if a != b {
        (
            Kind::SemanticMismatch,
            "different facts under the same selected-stream packet inventory contract; no tolerance",
        )
    } else if clean {
        (
            Kind::MatchingComparablePacketScan,
            "equal known selected-stream packet inventory fact",
        )
    } else {
        (
            Kind::NotComparable,
            "equal observed fact on a problem/incomplete run is not clean parity",
        )
    };
    result.add(field, a, b, kind, reason);
}
pub fn compare_inventory(a: &ScanObservation, b: &Inventory, same_build: bool) -> Comparison {
    let mut result = Comparison::new();
    if !same_build {
        result.add(
            "same_build",
            json!(false),
            Value::Null,
            Kind::BackendOrReferenceError,
            "same-build reference not established; no parity",
        );
        return result;
    }
    let clean = a.clean_eof
        && a.terminal == ScanTerminal::Eof
        && a.outcome == Outcome::Success
        && b.outcome == Outcome::Success
        && b.process_completed
        && !b.diagnostics_present
        && matches!(b.streams.as_slice(), [s] if s.packet_count.is_some_and(|n| n > 0));
    if !clean {
        result.add("completion", json!({"outcome":a.outcome,"terminal":a.terminal,"clean_eof":a.clean_eof}),
            json!({"outcome":b.outcome,"process_completed":b.process_completed,"diagnostics_present":b.diagnostics_present}),
            Kind::BackendOrReferenceError, "failed/cancelled/incomplete or diagnostic-bearing inventory is not clean successful parity; ffprobe can exit zero after read diagnostics");
        if (a.outcome == Outcome::Success) != (b.outcome == Outcome::Success) {
            result.add("operation_outcome", json!(a.outcome), json!(b.outcome), Kind::SemanticMismatch,
                "structured scan outcome differs from reference process outcome; retain evidence and explain actual demuxer/reference behavior");
        }
    }
    if let (Some(a), [b]) = (a.selected.as_ref(), b.streams.as_slice()) {
        exact(
            &mut result,
            "stream.index",
            json!(a.index),
            json!(b.index),
            clean,
        );
        exact(
            &mut result,
            "stream.media_type",
            json!(a.media_type),
            json!(b.media_type),
            clean,
        );
        if a.index == b.index && a.media_type == b.media_type {
            exact(
                &mut result,
                "stream.codec_name",
                json!(a.codec_name),
                json!(b.codec_name),
                clean,
            );
            exact(
                &mut result,
                "stream.time_base",
                json!(a.time_base),
                json!(b.time_base),
                clean,
            );
            // Failed reads may stop at different points: retained partial counts
            // are evidence, not a same-completion comparison.
            if a.packet_count == b.packet_count.unwrap_or(u64::MAX) || clean {
                exact(
                    &mut result,
                    "stream.packet_count",
                    json!(a.packet_count),
                    json!(b.packet_count),
                    clean,
                );
            } else {
                result.add(
                    "stream.packet_count",
                    json!(a.packet_count),
                    json!(b.packet_count),
                    Kind::NotComparable,
                    "partial/problem runs may stop at different positions",
                );
            }
        }
    } else if clean {
        result.add(
            "selected_inventory",
            json!(a.selected),
            json!(b.streams),
            Kind::SemanticMismatch,
            "missing selected stream in a purportedly completed inventory",
        );
    }
    result.add("payload_bytes_and_timestamp_bounds", Value::Null, Value::Null, Kind::NotComparable,
        "count_packets has no payload-byte/timestamp-bound summary; direct accumulator tests and a small packet-field spot-check cover these fields");
    result
}
#[derive(Debug, Clone, Serialize)]
pub struct Operational {
    pub outcome: Outcome,
    pub process_completed: bool,
    pub diagnostics_present: bool,
}
impl Operational {
    pub fn error(outcome: Outcome) -> Self {
        Self {
            outcome,
            process_completed: false,
            diagnostics_present: false,
        }
    }
}
pub fn compare_operational(a: &ScanObservation, b: &Operational, same_build: bool) -> Comparison {
    let mut result = Comparison::new();
    if !same_build
        || !b.process_completed
        || b.outcome != Outcome::Success
        || b.diagnostics_present
        || !a.clean_eof
        || a.terminal != ScanTerminal::Eof
        || a.outcome != Outcome::Success
    {
        result.add("operation_outcome", json!({"outcome":a.outcome,"terminal":a.terminal,"clean_eof":a.clean_eof}), json!(b),
            Kind::BackendOrReferenceError, "reference failure/diagnostics or incomplete/problem scan; equally failed operations are not clean parity");
        if same_build
            && a.clean_eof
            && b.process_completed
            && (b.diagnostics_present || b.outcome != Outcome::Success)
        {
            result.add("operation_depth", json!("demux_packet_scan"), json!("streamcopy_null_output"), Kind::DepthOrContractDifference,
                "streamcopy also applies output/timestamp policy; requires a concrete fixture explanation, never infer clean parity from exit zero with diagnostics");
        }
    } else {
        result.add("operation_outcome", json!("clean_demux_eof"), json!("successful_streamcopy_without_diagnostics"), Kind::MatchingComparablePacketScan,
            "consistent observed success for selected stream; shared libav, no independent decoding or publication proof");
    }
    result
}

#[cfg(test)]
mod tests;
