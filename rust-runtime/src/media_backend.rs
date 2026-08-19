use mp4::{
    AacConfig, AvcConfig, MediaConfig, MediaType, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer,
    TrackConfig, TrackType, Vp9Config,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MEDIA_SCHEMA_VERSION: u32 = 1;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpectedMediaKind {
    Video,
    Audio,
}

impl ExpectedMediaKind {
    fn track_type(self) -> TrackType {
        match self {
            Self::Video => TrackType::Video,
            Self::Audio => TrackType::Audio,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaPathRequest {
    pub schema_version: u32,
    pub source: PathBuf,
    pub expected_kind: ExpectedMediaKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaNormalizeRequest {
    pub schema_version: u32,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub expected_kind: ExpectedMediaKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaErrorKind {
    InvalidRequest,
    SourceMissing,
    DestinationExists,
    UnsupportedCodec,
    InvalidMedia,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaError {
    pub kind: MediaErrorKind,
    pub message: String,
}

impl MediaError {
    fn new(kind: MediaErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn invalid_media(message: impl Into<String>) -> Self {
        Self::new(MediaErrorKind::InvalidMedia, message)
    }

    fn io(message: impl Into<String>) -> Self {
        Self::new(MediaErrorKind::Io, message)
    }
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MediaError {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaProbe {
    pub path: PathBuf,
    pub kind: ExpectedMediaKind,
    pub codec: String,
    pub duration_seconds: f64,
    pub sample_count: u32,
    pub sample_bytes: u64,
    pub file_bytes: u64,
    pub fragmented: bool,
    pub fast_start: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaNormalizeResult {
    pub source: MediaProbe,
    pub output: MediaProbe,
}

pub fn probe_media(request: &MediaPathRequest) -> Result<MediaProbe, MediaError> {
    validate_source_request(request.schema_version, &request.source)?;
    probe_path(&request.source, request.expected_kind)
}

pub fn normalize_media(
    request: &MediaNormalizeRequest,
) -> Result<MediaNormalizeResult, MediaError> {
    validate_source_request(request.schema_version, &request.source)?;
    validate_destination(&request.destination)?;

    let source_probe = probe_path(&request.source, request.expected_kind)?;
    if source_probe.codec == "flac" {
        return normalize_flac_mp4(&request.source, &request.destination, source_probe);
    }
    let raw_path = temporary_path(&request.destination, "remux");
    let fast_path = temporary_path(&request.destination, "faststart");
    let result = (|| {
        remux_single_track(&request.source, &raw_path, request.expected_kind)?;
        relocate_moov_to_front(&raw_path, &fast_path)?;
        let output_probe = probe_path(&fast_path, request.expected_kind)?;
        if !output_probe.fast_start {
            return Err(MediaError::invalid_media(
                "normalized MP4 does not have a leading moov box",
            ));
        }
        if output_probe.sample_count != source_probe.sample_count
            || output_probe.sample_bytes != source_probe.sample_bytes
        {
            return Err(MediaError::invalid_media(
                "normalized MP4 sample inventory does not match its source",
            ));
        }
        publish_no_replace(&fast_path, &request.destination)?;
        let mut published_probe = output_probe;
        published_probe.path = request.destination.clone();
        Ok(MediaNormalizeResult {
            source: source_probe,
            output: published_probe,
        })
    })();
    let _ = fs::remove_file(&raw_path);
    let _ = fs::remove_file(&fast_path);
    if result.is_err() {
        let _ = fs::remove_file(&request.destination);
    }
    result
}

fn validate_source_request(schema_version: u32, source: &Path) -> Result<(), MediaError> {
    if schema_version != MEDIA_SCHEMA_VERSION {
        return Err(MediaError::new(
            MediaErrorKind::InvalidRequest,
            "unsupported media request schema",
        ));
    }
    if !source.is_absolute() || source.file_name().is_none() {
        return Err(MediaError::new(
            MediaErrorKind::InvalidRequest,
            "media source must be an absolute file path",
        ));
    }
    if !source.is_file() {
        return Err(MediaError::new(
            MediaErrorKind::SourceMissing,
            "media source does not exist",
        ));
    }
    Ok(())
}

fn validate_destination(destination: &Path) -> Result<(), MediaError> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(MediaError::new(
            MediaErrorKind::InvalidRequest,
            "media destination must be an absolute file path",
        ));
    }
    if destination.exists() {
        return Err(MediaError::new(
            MediaErrorKind::DestinationExists,
            "media destination already exists",
        ));
    }
    if !destination.parent().is_some_and(Path::is_dir) {
        return Err(MediaError::new(
            MediaErrorKind::InvalidRequest,
            "media destination parent does not exist",
        ));
    }
    Ok(())
}

fn open_reader(path: &Path) -> Result<Mp4Reader<File>, MediaError> {
    let file = File::open(path).map_err(|_| MediaError::io("failed to open media source"))?;
    let size = file
        .metadata()
        .map_err(|_| MediaError::io("failed to stat media source"))?
        .len();
    if size == 0 {
        return Err(MediaError::invalid_media("media source is empty"));
    }
    Mp4Reader::read_header(file, size)
        .map_err(|_| MediaError::invalid_media("failed to parse MP4 structure"))
}

fn selected_track_id(
    reader: &Mp4Reader<File>,
    expected_kind: ExpectedMediaKind,
) -> Result<u32, MediaError> {
    let mut matching = Vec::new();
    for (track_id, track) in reader.tracks() {
        let track_type = track
            .track_type()
            .map_err(|_| MediaError::invalid_media("MP4 contains an invalid track type"))?;
        if track_type == expected_kind.track_type() {
            matching.push(*track_id);
        }
    }
    if matching.len() != 1 || reader.tracks().len() != 1 {
        return Err(MediaError::invalid_media(
            "media source must contain exactly one track of the expected kind",
        ));
    }
    Ok(matching[0])
}

fn probe_path(path: &Path, expected_kind: ExpectedMediaKind) -> Result<MediaProbe, MediaError> {
    let file_bytes = path
        .metadata()
        .map_err(|_| MediaError::io("failed to stat media file"))?
        .len();
    let fast_start = has_leading_moov(path)?;
    let mut reader = open_reader(path)?;
    let fragmented = reader.is_fragmented();
    let track_id = selected_track_id(&reader, expected_kind)?;
    let track = reader
        .tracks()
        .get(&track_id)
        .ok_or_else(|| MediaError::invalid_media("expected media track is missing"))?;
    let codec = match track.media_type() {
        Ok(media_type) => codec_name(media_type)?,
        Err(_)
            if expected_kind == ExpectedMediaKind::Audio && flac_stream_info(path)?.is_some() =>
        {
            "flac".to_string()
        }
        Err(_) => {
            return Err(MediaError::new(
                MediaErrorKind::UnsupportedCodec,
                "unsupported MP4 codec",
            ));
        }
    };
    let timescale = track.timescale();
    if timescale == 0 {
        return Err(MediaError::invalid_media(
            "media track has a zero timescale",
        ));
    }
    let samples = source_samples(path, &mut reader, track_id)?;
    let sample_count = u32::try_from(samples.len())
        .map_err(|_| MediaError::invalid_media("media track contains too many samples"))?;
    if samples.is_empty() {
        return Err(MediaError::invalid_media("media track contains no samples"));
    }

    let mut sample_bytes = 0_u64;
    let mut duration_units = 0_u64;
    for sample in samples {
        if sample.bytes.is_empty() {
            return Err(MediaError::invalid_media("MP4 contains an empty sample"));
        }
        sample_bytes = sample_bytes.saturating_add(sample.bytes.len() as u64);
        duration_units =
            duration_units.max(sample.start_time.saturating_add(sample.duration as u64));
    }
    if sample_bytes == 0 || duration_units == 0 {
        return Err(MediaError::invalid_media(
            "media track has no decodable duration or payload",
        ));
    }

    Ok(MediaProbe {
        path: path.to_path_buf(),
        kind: expected_kind,
        codec,
        duration_seconds: duration_units as f64 / timescale as f64,
        sample_count,
        sample_bytes,
        file_bytes,
        fragmented,
        fast_start,
    })
}

fn codec_name(media_type: MediaType) -> Result<String, MediaError> {
    match media_type {
        MediaType::H264 => Ok("h264".to_string()),
        MediaType::VP9 => Ok("vp9".to_string()),
        MediaType::AAC => Ok("aac".to_string()),
        MediaType::H265 => Err(MediaError::new(
            MediaErrorKind::UnsupportedCodec,
            "HEVC remux is not supported by the native media backend",
        )),
        _ => Err(MediaError::new(
            MediaErrorKind::UnsupportedCodec,
            "unsupported MP4 codec",
        )),
    }
}

fn track_config(reader: &Mp4Reader<File>, track_id: u32) -> Result<TrackConfig, MediaError> {
    let track = reader
        .tracks()
        .get(&track_id)
        .ok_or_else(|| MediaError::invalid_media("expected media track is missing"))?;
    let media_conf = match track
        .media_type()
        .map_err(|_| MediaError::new(MediaErrorKind::UnsupportedCodec, "unsupported MP4 codec"))?
    {
        MediaType::H264 => MediaConfig::AvcConfig(AvcConfig {
            width: track.width(),
            height: track.height(),
            seq_param_set: track
                .sequence_parameter_set()
                .map_err(|_| MediaError::invalid_media("H.264 SPS is missing"))?
                .to_vec(),
            pic_param_set: track
                .picture_parameter_set()
                .map_err(|_| MediaError::invalid_media("H.264 PPS is missing"))?
                .to_vec(),
        }),
        MediaType::VP9 => MediaConfig::Vp9Config(Vp9Config {
            width: track.width(),
            height: track.height(),
        }),
        MediaType::AAC => MediaConfig::AacConfig(AacConfig {
            bitrate: track.bitrate(),
            profile: track
                .audio_profile()
                .map_err(|_| MediaError::invalid_media("AAC profile is missing"))?,
            freq_index: track
                .sample_freq_index()
                .map_err(|_| MediaError::invalid_media("AAC sample rate is missing"))?,
            chan_conf: track
                .channel_config()
                .map_err(|_| MediaError::invalid_media("AAC channel configuration is missing"))?,
        }),
        MediaType::H265 => {
            return Err(MediaError::new(
                MediaErrorKind::UnsupportedCodec,
                "HEVC remux is not supported by the native media backend",
            ));
        }
        _ => {
            return Err(MediaError::new(
                MediaErrorKind::UnsupportedCodec,
                "unsupported MP4 codec",
            ));
        }
    };
    Ok(TrackConfig {
        track_type: track
            .track_type()
            .map_err(|_| MediaError::invalid_media("MP4 contains an invalid track type"))?,
        timescale: track.timescale(),
        language: track.language().to_string(),
        media_conf,
    })
}

fn remux_single_track(
    source: &Path,
    destination: &Path,
    expected_kind: ExpectedMediaKind,
) -> Result<(), MediaError> {
    let mut reader = open_reader(source)?;
    let track_id = selected_track_id(&reader, expected_kind)?;
    let config = track_config(&reader, track_id)?;
    let samples = source_samples(source, &mut reader, track_id)?;

    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| MediaError::io("failed to create normalized MP4"))?;
    let mp4_config = Mp4Config {
        major_brand: "isom"
            .parse()
            .map_err(|_| MediaError::invalid_media("invalid MP4 brand"))?,
        minor_version: 512,
        compatible_brands: ["isom", "iso2", "avc1", "mp41"]
            .iter()
            .map(|brand| brand.parse())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| MediaError::invalid_media("invalid MP4 compatible brand"))?,
        timescale: 1000,
    };
    let mut writer = Mp4Writer::write_start(output, &mp4_config)
        .map_err(|_| MediaError::io("failed to initialize normalized MP4"))?;
    writer
        .add_track(&config)
        .map_err(|_| MediaError::invalid_media("failed to copy MP4 track configuration"))?;
    for sample in samples {
        writer
            .write_sample(1, &sample)
            .map_err(|_| MediaError::io("failed to write normalized MP4 sample"))?;
    }
    writer
        .write_end()
        .map_err(|_| MediaError::io("failed to finalize normalized MP4"))?;
    let output = writer.into_writer();
    output
        .sync_all()
        .map_err(|_| MediaError::io("failed to flush normalized MP4"))
}

#[derive(Debug, Clone, Copy)]
struct FragmentSample {
    offset: u64,
    size: u32,
    start_time: u64,
    duration: u32,
    rendering_offset: i32,
    is_sync: bool,
}

#[derive(Debug, Default)]
struct FragmentTrackHeader {
    track_id: u32,
    base_data_offset: Option<u64>,
    default_sample_duration: Option<u32>,
    default_sample_size: Option<u32>,
    default_sample_flags: Option<u32>,
}

#[derive(Debug, Default)]
struct FragmentRun {
    sample_count: u32,
    data_offset: Option<i32>,
    first_sample_flags: Option<u32>,
    sample_durations: Vec<u32>,
    sample_sizes: Vec<u32>,
    sample_flags: Vec<u32>,
    sample_cts: Vec<i32>,
}

fn source_samples(
    path: &Path,
    reader: &mut Mp4Reader<File>,
    track_id: u32,
) -> Result<Vec<Mp4Sample>, MediaError> {
    if !reader.is_fragmented() {
        let count = reader
            .sample_count(track_id)
            .map_err(|_| MediaError::invalid_media("failed to count MP4 samples"))?;
        let mut samples = Vec::with_capacity(count as usize);
        for sample_id in 1..=count {
            samples.push(
                reader
                    .read_sample(track_id, sample_id)
                    .map_err(|_| MediaError::invalid_media("failed to read an MP4 sample"))?
                    .ok_or_else(|| MediaError::invalid_media("MP4 sample is missing"))?,
            );
        }
        return Ok(samples);
    }

    let fragment_samples = fragmented_sample_table(path, reader, track_id)?;
    let mut file = File::open(path).map_err(|_| MediaError::io("failed to open fragmented MP4"))?;
    let mut samples = Vec::with_capacity(fragment_samples.len());
    for sample in fragment_samples {
        let mut bytes = vec![0_u8; sample.size as usize];
        file.seek(SeekFrom::Start(sample.offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|_| MediaError::invalid_media("failed to read fragmented MP4 sample"))?;
        samples.push(Mp4Sample {
            start_time: sample.start_time,
            duration: sample.duration,
            rendering_offset: sample.rendering_offset,
            is_sync: sample.is_sync,
            bytes: bytes.into(),
        });
    }
    Ok(samples)
}

fn fragmented_sample_table(
    path: &Path,
    reader: &Mp4Reader<File>,
    track_id: u32,
) -> Result<Vec<FragmentSample>, MediaError> {
    let boxes = top_level_boxes(path)?;
    let mdat_ranges: Vec<(u64, u64)> = boxes
        .iter()
        .filter(|entry| entry.kind == *b"mdat")
        .map(|entry| (entry.start + entry.header_size, entry.start + entry.size))
        .collect();
    let trex = reader.moov.mvex.as_ref().map(|mvex| &mvex.trex);
    let mut file = File::open(path).map_err(|_| MediaError::io("failed to open fragmented MP4"))?;
    let mut samples = Vec::new();
    let mut running_decode_time = 0_u64;

    for moof in boxes.iter().filter(|entry| entry.kind == *b"moof") {
        let mut bytes = vec![
            0_u8;
            usize::try_from(moof.size).map_err(|_| MediaError::invalid_media(
                "MP4 moof box is too large"
            ))?
        ];
        file.seek(SeekFrom::Start(moof.start))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|_| MediaError::io("failed to read MP4 moof box"))?;
        let trafs = child_boxes(&bytes, moof.header_size as usize, bytes.len())?;
        for traf in trafs.into_iter().filter(|entry| entry.kind == *b"traf") {
            let children = child_boxes(
                &bytes,
                traf.start as usize + traf.header_size as usize,
                (traf.start + traf.size) as usize,
            )?;
            let tfhd_box = children
                .iter()
                .find(|entry| entry.kind == *b"tfhd")
                .ok_or_else(|| MediaError::invalid_media("fragmented MP4 tfhd box is missing"))?;
            let tfhd = parse_tfhd(&bytes, *tfhd_box)?;
            if tfhd.track_id != track_id {
                continue;
            }
            let decode_time = children
                .iter()
                .find(|entry| entry.kind == *b"tfdt")
                .map(|entry| parse_tfdt(&bytes, *entry))
                .transpose()?
                .unwrap_or(running_decode_time);
            let mut current_decode_time = decode_time;
            let mut next_data_offset: Option<u64> = None;
            let run_boxes: Vec<TopLevelBox> = children
                .into_iter()
                .filter(|entry| entry.kind == *b"trun")
                .collect();
            if run_boxes.is_empty() {
                return Err(MediaError::invalid_media(
                    "fragmented MP4 trun box is missing",
                ));
            }
            for run_box in run_boxes {
                let run = parse_trun(&bytes, run_box)?;
                let base = tfhd.base_data_offset.unwrap_or(moof.start);
                let mut data_offset = if let Some(offset) = run.data_offset {
                    checked_signed_offset(base, offset)?
                } else if let Some(offset) = next_data_offset {
                    offset
                } else {
                    following_mdat_payload(&boxes, moof.start + moof.size)?
                };
                for index in 0..run.sample_count as usize {
                    let duration = run
                        .sample_durations
                        .get(index)
                        .copied()
                        .or(tfhd.default_sample_duration)
                        .or_else(|| trex.map(|value| value.default_sample_duration))
                        .filter(|value| *value > 0)
                        .ok_or_else(|| {
                            MediaError::invalid_media("fragment sample duration is missing")
                        })?;
                    let size = run
                        .sample_sizes
                        .get(index)
                        .copied()
                        .or(tfhd.default_sample_size)
                        .or_else(|| trex.map(|value| value.default_sample_size))
                        .filter(|value| *value > 0)
                        .ok_or_else(|| {
                            MediaError::invalid_media("fragment sample size is missing")
                        })?;
                    let flags = run
                        .sample_flags
                        .get(index)
                        .copied()
                        .or_else(|| (index == 0).then_some(run.first_sample_flags).flatten())
                        .or(tfhd.default_sample_flags)
                        .or_else(|| trex.map(|value| value.default_sample_flags))
                        .unwrap_or(0);
                    let end = data_offset.checked_add(size as u64).ok_or_else(|| {
                        MediaError::invalid_media("fragment sample offset overflow")
                    })?;
                    if !mdat_ranges
                        .iter()
                        .any(|(start, mdat_end)| data_offset >= *start && end <= *mdat_end)
                    {
                        return Err(MediaError::invalid_media(
                            "fragment sample points outside an mdat box",
                        ));
                    }
                    samples.push(FragmentSample {
                        offset: data_offset,
                        size,
                        start_time: current_decode_time,
                        duration,
                        rendering_offset: run.sample_cts.get(index).copied().unwrap_or(0),
                        is_sync: flags & 0x0001_0000 == 0,
                    });
                    data_offset = end;
                    current_decode_time = current_decode_time.saturating_add(duration as u64);
                }
                next_data_offset = Some(data_offset);
            }
            running_decode_time = running_decode_time.max(current_decode_time);
        }
    }
    if samples.is_empty() {
        return Err(MediaError::invalid_media(
            "fragmented MP4 contains no samples for the expected track",
        ));
    }
    Ok(samples)
}

fn child_boxes(
    bytes: &[u8],
    mut cursor: usize,
    end: usize,
) -> Result<Vec<TopLevelBox>, MediaError> {
    let mut boxes = Vec::new();
    while cursor < end {
        if end.saturating_sub(cursor) < 8 {
            return Err(MediaError::invalid_media("truncated MP4 child box"));
        }
        let short_size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap());
        let kind = bytes[cursor + 4..cursor + 8].try_into().unwrap();
        let (size, header_size) = if short_size == 1 {
            if end.saturating_sub(cursor) < 16 {
                return Err(MediaError::invalid_media(
                    "truncated extended MP4 child box",
                ));
            }
            (
                u64::from_be_bytes(bytes[cursor + 8..cursor + 16].try_into().unwrap()),
                16,
            )
        } else if short_size == 0 {
            ((end - cursor) as u64, 8)
        } else {
            (short_size as u64, 8)
        };
        let box_end = cursor
            .checked_add(
                usize::try_from(size)
                    .map_err(|_| MediaError::invalid_media("MP4 child box is too large"))?,
            )
            .ok_or_else(|| MediaError::invalid_media("MP4 child box offset overflow"))?;
        if size < header_size || box_end > end {
            return Err(MediaError::invalid_media("invalid MP4 child box size"));
        }
        boxes.push(TopLevelBox {
            start: cursor as u64,
            size,
            header_size,
            kind,
        });
        cursor = box_end;
    }
    Ok(boxes)
}

fn full_box_header(bytes: &[u8], entry: TopLevelBox) -> Result<(u8, u32, usize), MediaError> {
    let payload = entry.start as usize + entry.header_size as usize;
    if payload + 4 > (entry.start + entry.size) as usize {
        return Err(MediaError::invalid_media("truncated MP4 full box header"));
    }
    Ok((
        bytes[payload],
        u32::from_be_bytes([
            0,
            bytes[payload + 1],
            bytes[payload + 2],
            bytes[payload + 3],
        ]),
        payload + 4,
    ))
}

fn read_u32_at(bytes: &[u8], cursor: &mut usize, end: usize) -> Result<u32, MediaError> {
    if *cursor + 4 > end {
        return Err(MediaError::invalid_media("truncated MP4 integer"));
    }
    let value = u32::from_be_bytes(bytes[*cursor..*cursor + 4].try_into().unwrap());
    *cursor += 4;
    Ok(value)
}

fn read_i32_at(bytes: &[u8], cursor: &mut usize, end: usize) -> Result<i32, MediaError> {
    Ok(read_u32_at(bytes, cursor, end)? as i32)
}

fn read_u64_at(bytes: &[u8], cursor: &mut usize, end: usize) -> Result<u64, MediaError> {
    if *cursor + 8 > end {
        return Err(MediaError::invalid_media("truncated MP4 integer"));
    }
    let value = u64::from_be_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    Ok(value)
}

fn parse_tfhd(bytes: &[u8], entry: TopLevelBox) -> Result<FragmentTrackHeader, MediaError> {
    let (_version, flags, mut cursor) = full_box_header(bytes, entry)?;
    let end = (entry.start + entry.size) as usize;
    let track_id = read_u32_at(bytes, &mut cursor, end)?;
    let base_data_offset = (flags & 0x01 != 0)
        .then(|| read_u64_at(bytes, &mut cursor, end))
        .transpose()?;
    if flags & 0x02 != 0 {
        read_u32_at(bytes, &mut cursor, end)?;
    }
    let default_sample_duration = (flags & 0x08 != 0)
        .then(|| read_u32_at(bytes, &mut cursor, end))
        .transpose()?;
    let default_sample_size = (flags & 0x10 != 0)
        .then(|| read_u32_at(bytes, &mut cursor, end))
        .transpose()?;
    let default_sample_flags = (flags & 0x20 != 0)
        .then(|| read_u32_at(bytes, &mut cursor, end))
        .transpose()?;
    Ok(FragmentTrackHeader {
        track_id,
        base_data_offset,
        default_sample_duration,
        default_sample_size,
        default_sample_flags,
    })
}

fn parse_tfdt(bytes: &[u8], entry: TopLevelBox) -> Result<u64, MediaError> {
    let (version, _flags, mut cursor) = full_box_header(bytes, entry)?;
    let end = (entry.start + entry.size) as usize;
    match version {
        0 => Ok(read_u32_at(bytes, &mut cursor, end)? as u64),
        1 => read_u64_at(bytes, &mut cursor, end),
        _ => Err(MediaError::invalid_media("unsupported tfdt version")),
    }
}

fn parse_trun(bytes: &[u8], entry: TopLevelBox) -> Result<FragmentRun, MediaError> {
    let (version, flags, mut cursor) = full_box_header(bytes, entry)?;
    let end = (entry.start + entry.size) as usize;
    let sample_count = read_u32_at(bytes, &mut cursor, end)?;
    let data_offset = (flags & 0x01 != 0)
        .then(|| read_i32_at(bytes, &mut cursor, end))
        .transpose()?;
    let first_sample_flags = (flags & 0x04 != 0)
        .then(|| read_u32_at(bytes, &mut cursor, end))
        .transpose()?;
    let mut run = FragmentRun {
        sample_count,
        data_offset,
        first_sample_flags,
        ..FragmentRun::default()
    };
    for _ in 0..sample_count {
        if flags & 0x100 != 0 {
            run.sample_durations
                .push(read_u32_at(bytes, &mut cursor, end)?);
        }
        if flags & 0x200 != 0 {
            run.sample_sizes.push(read_u32_at(bytes, &mut cursor, end)?);
        }
        if flags & 0x400 != 0 {
            run.sample_flags.push(read_u32_at(bytes, &mut cursor, end)?);
        }
        if flags & 0x800 != 0 {
            let value = read_u32_at(bytes, &mut cursor, end)?;
            run.sample_cts.push(if version == 1 {
                value as i32
            } else {
                i32::try_from(value)
                    .map_err(|_| MediaError::invalid_media("composition offset overflow"))?
            });
        }
    }
    Ok(run)
}

fn checked_signed_offset(base: u64, offset: i32) -> Result<u64, MediaError> {
    if offset >= 0 {
        base.checked_add(offset as u64)
    } else {
        base.checked_sub(offset.unsigned_abs() as u64)
    }
    .ok_or_else(|| MediaError::invalid_media("fragment data offset overflow"))
}

fn following_mdat_payload(boxes: &[TopLevelBox], after: u64) -> Result<u64, MediaError> {
    boxes
        .iter()
        .find(|entry| entry.kind == *b"mdat" && entry.start >= after)
        .map(|entry| entry.start + entry.header_size)
        .ok_or_else(|| MediaError::invalid_media("fragment mdat box is missing"))
}

#[derive(Debug, Clone, Copy)]
struct TopLevelBox {
    start: u64,
    size: u64,
    header_size: u64,
    kind: [u8; 4],
}

fn read_box_header(reader: &mut File, limit: u64) -> Result<TopLevelBox, MediaError> {
    let start = reader
        .stream_position()
        .map_err(|_| MediaError::io("failed to inspect MP4 box"))?;
    let mut header = [0_u8; 8];
    reader
        .read_exact(&mut header)
        .map_err(|_| MediaError::invalid_media("truncated MP4 box header"))?;
    let short_size = u32::from_be_bytes(header[..4].try_into().unwrap());
    let kind = header[4..8].try_into().unwrap();
    let (size, header_size) = if short_size == 1 {
        let mut extended = [0_u8; 8];
        reader
            .read_exact(&mut extended)
            .map_err(|_| MediaError::invalid_media("truncated extended MP4 box header"))?;
        (u64::from_be_bytes(extended), 16)
    } else if short_size == 0 {
        (limit.saturating_sub(start), 8)
    } else {
        (short_size as u64, 8)
    };
    if size < header_size || start.saturating_add(size) > limit {
        return Err(MediaError::invalid_media("invalid MP4 box size"));
    }
    Ok(TopLevelBox {
        start,
        size,
        header_size,
        kind,
    })
}

fn top_level_boxes(path: &Path) -> Result<Vec<TopLevelBox>, MediaError> {
    let mut file = File::open(path).map_err(|_| MediaError::io("failed to open MP4"))?;
    let size = file
        .metadata()
        .map_err(|_| MediaError::io("failed to stat MP4"))?
        .len();
    let mut boxes = Vec::new();
    while file
        .stream_position()
        .map_err(|_| MediaError::io("failed to inspect MP4"))?
        < size
    {
        let entry = read_box_header(&mut file, size)?;
        file.seek(SeekFrom::Start(entry.start + entry.size))
            .map_err(|_| MediaError::io("failed to seek through MP4"))?;
        boxes.push(entry);
    }
    Ok(boxes)
}

fn flac_stream_info(path: &Path) -> Result<Option<[u8; 34]>, MediaError> {
    let moov = top_level_boxes(path)?
        .into_iter()
        .find(|entry| entry.kind == *b"moov")
        .ok_or_else(|| MediaError::invalid_media("MP4 moov box is missing"))?;
    let mut file = File::open(path).map_err(|_| MediaError::io("failed to open MP4"))?;
    let mut bytes = vec![
        0_u8;
        usize::try_from(moov.size)
            .map_err(|_| MediaError::invalid_media("MP4 moov box is too large"))?
    ];
    file.seek(SeekFrom::Start(moov.start))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|_| MediaError::io("failed to read MP4 moov box"))?;

    let children = child_boxes(&bytes, moov.header_size as usize, bytes.len())?;
    for trak in children.into_iter().filter(|entry| entry.kind == *b"trak") {
        let trak_children = child_boxes(
            &bytes,
            (trak.start + trak.header_size) as usize,
            (trak.start + trak.size) as usize,
        )?;
        let Some(mdia) = trak_children
            .into_iter()
            .find(|entry| entry.kind == *b"mdia")
        else {
            continue;
        };
        let mdia_children = child_boxes(
            &bytes,
            (mdia.start + mdia.header_size) as usize,
            (mdia.start + mdia.size) as usize,
        )?;
        let Some(minf) = mdia_children
            .into_iter()
            .find(|entry| entry.kind == *b"minf")
        else {
            continue;
        };
        let minf_children = child_boxes(
            &bytes,
            (minf.start + minf.header_size) as usize,
            (minf.start + minf.size) as usize,
        )?;
        let Some(stbl) = minf_children
            .into_iter()
            .find(|entry| entry.kind == *b"stbl")
        else {
            continue;
        };
        let stbl_children = child_boxes(
            &bytes,
            (stbl.start + stbl.header_size) as usize,
            (stbl.start + stbl.size) as usize,
        )?;
        let Some(stsd) = stbl_children
            .into_iter()
            .find(|entry| entry.kind == *b"stsd")
        else {
            continue;
        };
        let entries_start = stsd.start + stsd.header_size + 8;
        if entries_start > stsd.start + stsd.size {
            return Err(MediaError::invalid_media("truncated MP4 stsd box"));
        }
        let entries = child_boxes(
            &bytes,
            entries_start as usize,
            (stsd.start + stsd.size) as usize,
        )?;
        for entry in entries.into_iter().filter(|entry| entry.kind == *b"fLaC") {
            let config_start = entry.start + entry.header_size + 28;
            if config_start > entry.start + entry.size {
                return Err(MediaError::invalid_media("truncated MP4 FLAC sample entry"));
            }
            let configs = child_boxes(
                &bytes,
                config_start as usize,
                (entry.start + entry.size) as usize,
            )?;
            if let Some(config) = configs.into_iter().find(|config| config.kind == *b"dfLa") {
                let payload = usize::try_from(config.start + config.header_size + 4)
                    .map_err(|_| MediaError::invalid_media("MP4 FLAC config is too large"))?;
                let config_end = usize::try_from(config.start + config.size)
                    .map_err(|_| MediaError::invalid_media("MP4 FLAC config is too large"))?;
                if payload + 4 > config_end || config_end > bytes.len() {
                    return Err(MediaError::invalid_media("truncated MP4 FLAC config"));
                }
                let metadata_type = bytes[payload] & 0x7f;
                let metadata_size = ((bytes[payload + 1] as usize) << 16)
                    | ((bytes[payload + 2] as usize) << 8)
                    | bytes[payload + 3] as usize;
                if metadata_type != 0 || metadata_size != 34 || payload + 4 + 34 > config_end {
                    return Err(MediaError::invalid_media("MP4 FLAC STREAMINFO is invalid"));
                }
                let mut stream_info = [0_u8; 34];
                stream_info.copy_from_slice(&bytes[payload + 4..payload + 4 + 34]);
                return Ok(Some(stream_info));
            }
        }
    }
    Ok(None)
}

fn normalize_flac_mp4(
    source: &Path,
    destination: &Path,
    source_probe: MediaProbe,
) -> Result<MediaNormalizeResult, MediaError> {
    let stream_info = flac_stream_info(source)?
        .ok_or_else(|| MediaError::invalid_media("MP4 FLAC STREAMINFO is missing"))?;
    let mut reader = open_reader(source)?;
    let track_id = selected_track_id(&reader, ExpectedMediaKind::Audio)?;
    let samples = source_samples(source, &mut reader, track_id)?;
    let raw_path = temporary_path(destination, "flac");
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&raw_path)
            .map_err(|_| MediaError::io("failed to create normalized FLAC"))?;
        output
            .write_all(b"fLaC")
            .and_then(|_| output.write_all(&[0x80, 0x00, 0x00, 0x22]))
            .and_then(|_| output.write_all(&stream_info))
            .map_err(|_| MediaError::io("failed to write FLAC STREAMINFO"))?;
        let mut written_sample_bytes = 0_u64;
        for sample in &samples {
            output
                .write_all(&sample.bytes)
                .map_err(|_| MediaError::io("failed to write FLAC frame"))?;
            written_sample_bytes = written_sample_bytes.saturating_add(sample.bytes.len() as u64);
        }
        output
            .sync_all()
            .map_err(|_| MediaError::io("failed to flush normalized FLAC"))?;
        if written_sample_bytes != source_probe.sample_bytes {
            return Err(MediaError::invalid_media(
                "normalized FLAC sample inventory does not match its source",
            ));
        }
        let file_bytes = output
            .metadata()
            .map_err(|_| MediaError::io("failed to stat normalized FLAC"))?
            .len();
        if file_bytes != 42_u64.saturating_add(written_sample_bytes) {
            return Err(MediaError::invalid_media("normalized FLAC size is invalid"));
        }
        drop(output);
        publish_no_replace(&raw_path, destination)?;
        Ok(MediaNormalizeResult {
            source: source_probe.clone(),
            output: MediaProbe {
                path: destination.to_path_buf(),
                kind: ExpectedMediaKind::Audio,
                codec: "flac".to_string(),
                duration_seconds: source_probe.duration_seconds,
                sample_count: source_probe.sample_count,
                sample_bytes: written_sample_bytes,
                file_bytes,
                fragmented: false,
                fast_start: true,
            },
        })
    })();
    let _ = fs::remove_file(&raw_path);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn has_leading_moov(path: &Path) -> Result<bool, MediaError> {
    let boxes = top_level_boxes(path)?;
    let moov = boxes.iter().position(|entry| entry.kind == *b"moov");
    let mdat = boxes.iter().position(|entry| entry.kind == *b"mdat");
    Ok(matches!((moov, mdat), (Some(moov), Some(mdat)) if moov < mdat))
}

fn relocate_moov_to_front(source: &Path, destination: &Path) -> Result<(), MediaError> {
    let boxes = top_level_boxes(source)?;
    let ftyp = boxes
        .iter()
        .find(|entry| entry.kind == *b"ftyp")
        .copied()
        .ok_or_else(|| MediaError::invalid_media("MP4 ftyp box is missing"))?;
    let moov = boxes
        .iter()
        .find(|entry| entry.kind == *b"moov")
        .copied()
        .ok_or_else(|| MediaError::invalid_media("MP4 moov box is missing"))?;
    let mdat = boxes
        .iter()
        .find(|entry| entry.kind == *b"mdat")
        .copied()
        .ok_or_else(|| MediaError::invalid_media("MP4 mdat box is missing"))?;
    if ftyp.start != 0 || !(ftyp.start < mdat.start && mdat.start < moov.start) {
        return Err(MediaError::invalid_media(
            "normalized MP4 has an unsupported top-level box order",
        ));
    }

    let mut input = File::open(source).map_err(|_| MediaError::io("failed to open MP4"))?;
    let mut moov_bytes = vec![
        0_u8;
        usize::try_from(moov.size).map_err(|_| MediaError::invalid_media(
            "MP4 moov box is too large"
        ))?
    ];
    input
        .seek(SeekFrom::Start(moov.start))
        .and_then(|_| input.read_exact(&mut moov_bytes))
        .map_err(|_| MediaError::io("failed to read MP4 moov box"))?;
    patch_chunk_offsets(
        &mut moov_bytes,
        moov.header_size as usize,
        moov.size as usize,
        moov.size,
    )?;

    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| MediaError::io("failed to create fast-start MP4"))?;
    copy_range(&mut input, &mut output, ftyp.start, ftyp.size)?;
    output
        .write_all(&moov_bytes)
        .map_err(|_| MediaError::io("failed to write MP4 moov box"))?;
    copy_range(
        &mut input,
        &mut output,
        ftyp.start + ftyp.size,
        moov.start - (ftyp.start + ftyp.size),
    )?;
    output
        .sync_all()
        .map_err(|_| MediaError::io("failed to flush fast-start MP4"))
}

fn patch_chunk_offsets(
    bytes: &mut [u8],
    mut cursor: usize,
    end: usize,
    delta: u64,
) -> Result<(), MediaError> {
    while cursor < end {
        if end - cursor < 8 {
            return Err(MediaError::invalid_media("truncated MP4 child box"));
        }
        let short_size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap());
        let kind: [u8; 4] = bytes[cursor + 4..cursor + 8].try_into().unwrap();
        let (size, header_size) = if short_size == 1 {
            if end - cursor < 16 {
                return Err(MediaError::invalid_media(
                    "truncated extended MP4 child box",
                ));
            }
            (
                usize::try_from(u64::from_be_bytes(
                    bytes[cursor + 8..cursor + 16].try_into().unwrap(),
                ))
                .map_err(|_| MediaError::invalid_media("MP4 child box is too large"))?,
                16,
            )
        } else {
            (short_size as usize, 8)
        };
        if size < header_size || cursor.saturating_add(size) > end {
            return Err(MediaError::invalid_media("invalid MP4 child box size"));
        }
        let payload = cursor + header_size;
        let box_end = cursor + size;
        match &kind {
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => {
                patch_chunk_offsets(bytes, payload, box_end, delta)?;
            }
            b"stco" => patch_stco(bytes, payload, box_end, delta)?,
            b"co64" => patch_co64(bytes, payload, box_end, delta)?,
            _ => {}
        }
        cursor = box_end;
    }
    Ok(())
}

fn patch_stco(bytes: &mut [u8], payload: usize, end: usize, delta: u64) -> Result<(), MediaError> {
    if end.saturating_sub(payload) < 8 {
        return Err(MediaError::invalid_media("truncated stco box"));
    }
    let count = u32::from_be_bytes(bytes[payload + 4..payload + 8].try_into().unwrap()) as usize;
    if payload + 8 + count.saturating_mul(4) > end {
        return Err(MediaError::invalid_media("invalid stco entry count"));
    }
    for index in 0..count {
        let offset = payload + 8 + index * 4;
        let value = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as u64;
        let patched = value
            .checked_add(delta)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| MediaError::invalid_media("stco offset overflow"))?;
        bytes[offset..offset + 4].copy_from_slice(&patched.to_be_bytes());
    }
    Ok(())
}

fn patch_co64(bytes: &mut [u8], payload: usize, end: usize, delta: u64) -> Result<(), MediaError> {
    if end.saturating_sub(payload) < 8 {
        return Err(MediaError::invalid_media("truncated co64 box"));
    }
    let count = u32::from_be_bytes(bytes[payload + 4..payload + 8].try_into().unwrap()) as usize;
    if payload + 8 + count.saturating_mul(8) > end {
        return Err(MediaError::invalid_media("invalid co64 entry count"));
    }
    for index in 0..count {
        let offset = payload + 8 + index * 8;
        let value = u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap());
        let patched = value
            .checked_add(delta)
            .ok_or_else(|| MediaError::invalid_media("co64 offset overflow"))?;
        bytes[offset..offset + 8].copy_from_slice(&patched.to_be_bytes());
    }
    Ok(())
}

fn copy_range(
    input: &mut File,
    output: &mut File,
    start: u64,
    length: u64,
) -> Result<(), MediaError> {
    input
        .seek(SeekFrom::Start(start))
        .map_err(|_| MediaError::io("failed to seek MP4 source"))?;
    let mut remaining = length;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
        input
            .read_exact(&mut buffer[..count])
            .map_err(|_| MediaError::io("failed to read MP4 source"))?;
        output
            .write_all(&buffer[..count])
            .map_err(|_| MediaError::io("failed to write MP4 destination"))?;
        remaining -= count as u64;
    }
    Ok(())
}

fn publish_no_replace(source: &Path, destination: &Path) -> Result<(), MediaError> {
    fs::hard_link(source, destination).map_err(|_| {
        if destination.exists() {
            MediaError::new(
                MediaErrorKind::DestinationExists,
                "media destination appeared during normalization",
            )
        } else {
            MediaError::io("failed to publish normalized media")
        }
    })
}

fn temporary_path(destination: &Path, stage: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("media");
    destination.with_file_name(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        sequence,
        stage
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use claxon::FlacReader;
    use mp4::{AudioObjectType, ChannelConfig, Mp4Sample, SampleFreqIndex};

    const REAL_FLAC_FIXTURE_BASE64: &str =
        "ZkxhQ4AAACISABIAAAANAAANC7gA8AAAA8A9oVgtoi71SQek9M1tXRpg//h6CAADv8wAAAADsg==";

    fn test_dir(label: &str) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-output")
            .join(format!("media-{label}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    fn write_audio_fixture(path: &Path, samples: &[Vec<u8>]) {
        let file = File::create(path).expect("create fixture");
        let config = Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap(), "mp41".parse().unwrap()],
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(file, &config).expect("start fixture");
        writer
            .add_track(&TrackConfig {
                track_type: TrackType::Audio,
                timescale: 48_000,
                language: "und".to_string(),
                media_conf: MediaConfig::AacConfig(AacConfig {
                    bitrate: 128_000,
                    profile: AudioObjectType::AacLowComplexity,
                    freq_index: SampleFreqIndex::Freq48000,
                    chan_conf: ChannelConfig::Stereo,
                }),
            })
            .expect("add track");
        for (index, sample) in samples.iter().enumerate() {
            writer
                .write_sample(
                    1,
                    &Mp4Sample {
                        start_time: index as u64 * 1024,
                        duration: 1024,
                        rendering_offset: 0,
                        is_sync: true,
                        bytes: sample.clone().into(),
                    },
                )
                .expect("write sample");
        }
        writer.write_end().expect("end fixture");
        writer.into_writer().sync_all().expect("flush fixture");
    }

    fn write_aac_fixture(path: &Path) {
        let samples = (0..4)
            .map(|index| vec![index as u8 + 1; 16])
            .collect::<Vec<_>>();
        write_audio_fixture(path, &samples);
    }

    fn real_flac_parts() -> ([u8; 34], Vec<u8>) {
        let bytes = BASE64
            .decode(REAL_FLAC_FIXTURE_BASE64)
            .expect("decode real FLAC fixture");
        assert_eq!(&bytes[..4], b"fLaC");
        assert_eq!(bytes[4] & 0x7f, 0);
        assert_ne!(bytes[4] & 0x80, 0);
        let metadata_size =
            ((bytes[5] as usize) << 16) | ((bytes[6] as usize) << 8) | bytes[7] as usize;
        assert_eq!(metadata_size, 34);
        let stream_info = bytes[8..42].try_into().expect("FLAC STREAMINFO");
        (stream_info, bytes[42..].to_vec())
    }

    fn write_flac_mp4_fixture(path: &Path) {
        let (stream_info, flac_frame) = real_flac_parts();
        let raw_path = path.with_file_name("source-before-faststart.m4a");
        write_audio_fixture(&raw_path, &[flac_frame]);
        normalize_media(&MediaNormalizeRequest {
            schema_version: 1,
            source: raw_path.clone(),
            destination: path.to_path_buf(),
            expected_kind: ExpectedMediaKind::Audio,
        })
        .expect("normalize fixture before FLAC conversion");
        fs::remove_file(raw_path).expect("remove raw fixture");
        let mut bytes = fs::read(path).expect("read fixture");
        let sample_entry = bytes
            .windows(4)
            .position(|value| value == b"mp4a")
            .expect("mp4a sample entry");
        bytes[sample_entry..sample_entry + 4].copy_from_slice(b"fLaC");
        let codec_config = bytes[sample_entry + 4..]
            .windows(4)
            .position(|value| value == b"esds")
            .map(|position| sample_entry + 4 + position)
            .expect("esds codec configuration");
        bytes[codec_config..codec_config + 4].copy_from_slice(b"dfLa");
        let config_start = codec_config - 4;
        let config_size =
            u32::from_be_bytes(bytes[config_start..config_start + 4].try_into().unwrap()) as usize;
        let mut config_payload = vec![0_u8; 4];
        config_payload.extend_from_slice(&[0x80, 0x00, 0x00, 0x22]);
        config_payload.extend_from_slice(&stream_info);
        bytes.splice(config_start + 8..config_start + config_size, config_payload);
        let delta = 50_u32 - config_size as u32;
        bytes[config_start..config_start + 4].copy_from_slice(&50_u32.to_be_bytes());
        for kind in [
            b"fLaC", b"stsd", b"stbl", b"minf", b"mdia", b"trak", b"moov",
        ] {
            let position = bytes
                .windows(4)
                .position(|value| value == kind)
                .expect("fixture parent box");
            let size = u32::from_be_bytes(bytes[position - 4..position].try_into().unwrap());
            bytes[position - 4..position].copy_from_slice(&(size + delta).to_be_bytes());
        }
        let stco = bytes
            .windows(4)
            .position(|value| value == b"stco")
            .expect("stco box");
        let entry_count =
            u32::from_be_bytes(bytes[stco + 8..stco + 12].try_into().unwrap()) as usize;
        for index in 0..entry_count {
            let offset = stco + 12 + index * 4;
            let value = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
            bytes[offset..offset + 4].copy_from_slice(&(value + delta).to_be_bytes());
        }
        fs::write(path, bytes).expect("write FLAC fixture");
    }

    #[test]
    fn normalizes_and_validates_a_single_track_mp4() {
        let root = test_dir("normalize");
        let source = root.join("source.m4a");
        let destination = root.join("output.m4a");
        write_aac_fixture(&source);

        let result = normalize_media(&MediaNormalizeRequest {
            schema_version: 1,
            source,
            destination: destination.clone(),
            expected_kind: ExpectedMediaKind::Audio,
        })
        .expect("normalize media");

        assert_eq!(result.source.sample_count, 4);
        assert_eq!(result.output.sample_count, 4);
        assert_eq!(result.output.sample_bytes, 64);
        assert!(result.output.fast_start);
        assert!(destination.is_file());
    }

    #[test]
    fn normalizes_fast_start_flac_mp4_without_transcoding() {
        let root = test_dir("normalize-flac");
        let source = root.join("source.m4a");
        let destination = root.join("output.flac");
        write_flac_mp4_fixture(&source);

        let result = normalize_media(&MediaNormalizeRequest {
            schema_version: 1,
            source,
            destination: destination.clone(),
            expected_kind: ExpectedMediaKind::Audio,
        })
        .expect("normalize FLAC media");

        assert_eq!(result.source.codec, "flac");
        assert_eq!(result.output.codec, "flac");
        assert_eq!(result.source.sample_count, result.output.sample_count);
        assert_eq!(result.source.sample_bytes, result.output.sample_bytes);
        assert!(result.output.fast_start);
        assert!(!result.output.fragmented);
        let output = fs::read(&destination).expect("read output");
        assert_eq!(&output[..4], b"fLaC");
        assert_eq!(output.len() as u64, result.output.sample_bytes + 42);

        let mut decoder = FlacReader::open(destination).expect("open normalized FLAC in decoder");
        assert_eq!(decoder.streaminfo().sample_rate, 48_000);
        assert_eq!(decoder.streaminfo().channels, 1);
        let samples = decoder
            .samples()
            .collect::<Result<Vec<_>, _>>()
            .expect("decode normalized FLAC samples");
        assert_eq!(samples.len(), 960);
        assert!(samples.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn rejects_a_track_kind_mismatch() {
        let root = test_dir("kind");
        let source = root.join("source.m4a");
        write_aac_fixture(&source);
        let error = probe_media(&MediaPathRequest {
            schema_version: 1,
            source,
            expected_kind: ExpectedMediaKind::Video,
        })
        .expect_err("kind mismatch should fail");
        assert_eq!(error.kind, MediaErrorKind::InvalidMedia);
    }
}
