//! Explicit experimental file operation. Rust owns staging/checks/no-replace
//! publication; C owns only libav resources. No application/cache state effects.
use super::{LibavMetadataProbe, Metadata, PacketScan, ProbeError};
use crate::ExpectedMediaKind;
use serde::Serialize;
use std::{path::Path, sync::atomic::AtomicBool};

pub struct CopyRemuxRequest<'a> {
    pub source: &'a Path,
    pub destination: &'a Path,
    pub expected_kind: ExpectedMediaKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyProfile {
    Mp4,
    Flac,
}
impl CopyProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4_single_h264_or_aac_faststart_v1",
            Self::Flac => "mp4_single_flac_to_native_flac_v1",
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Flac => "flac",
        }
    }
}

/// Narrow normal-header/STREAMINFO check, not a frame/CRC/MD5 validator.
/// Only public numerical facts leave this helper; no tags or MD5 bytes.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct FlacStreamInfo {
    pub sample_rate_hz: u32,
    pub channel_count: u32,
    pub bits_per_sample: u32,
    pub total_samples: Option<u64>,
    pub md5_present: bool,
}
impl FlacStreamInfo {
    pub fn read(reader: &mut impl std::io::Read) -> std::io::Result<Self> {
        let mut header = [0; 42];
        reader.read_exact(&mut header)?;
        let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidData);
        if &header[..4] != b"fLaC" || header[4] & 0x7f != 0 || header[5..8] != [0, 0, 34] {
            return Err(invalid());
        }
        let v = &header[8..];
        let packed = u64::from_be_bytes(v[10..18].try_into().unwrap());
        let total = packed & ((1 << 36) - 1);
        let info = Self {
            sample_rate_hz: (packed >> 44) as u32,
            channel_count: ((packed >> 41) & 7) as u32 + 1,
            bits_per_sample: ((packed >> 36) & 31) as u32 + 1,
            total_samples: (total != 0).then_some(total),
            md5_present: v[18..34].iter().any(|b| *b != 0),
        };
        let min = u16::from_be_bytes(v[..2].try_into().unwrap());
        let max = u16::from_be_bytes(v[2..4].try_into().unwrap());
        if min < 16 || max < min || info.sample_rate_hz == 0 || info.bits_per_sample < 4 {
            return Err(invalid());
        }
        Ok(info)
    }
}

#[derive(Debug, Serialize)]
pub struct CopyRemuxResult {
    pub operation: &'static str,
    pub profile: &'static str,
    pub checking_depth: &'static str,
    pub input: PacketScan,
    pub input_metadata: Metadata,
    pub output: Metadata,
    pub output_scan: PacketScan,
    pub decoder_configuration_preserved: bool,
    pub leading_moov: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flac_streaminfo: Option<FlacStreamInfo>,
    pub finalized_and_published: bool,
    pub output_bytes: u64,
    pub cleanup_warning: Option<&'static str>,
}

impl LibavMetadataProbe {
    pub fn copy_remux_available(&self) -> bool {
        self.copy_profile_available(CopyProfile::Mp4)
    }

    pub fn copy_profile_available(&self, profile: CopyProfile) -> bool {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            self.remux
                .as_ref()
                .is_ok_and(|c| c.function(profile).is_ok())
                && self.packet_scan_available()
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = profile;
            false
        }
    }

    /// Trusted, stable, self-contained MP4; exactly one H.264 video or AAC audio
    /// stream. Preserve the media timeline, with no timestamp synthesis. Native
    /// cancellation is cooperative, including during finalization, not a hard
    /// deadline. Only a successful no-replace link commits this developer file.
    pub fn copy_remux_mp4(
        &self,
        request: &CopyRemuxRequest<'_>,
        cancelled: &AtomicBool,
    ) -> Result<CopyRemuxResult, ProbeError> {
        self.copy_profile(request, CopyProfile::Mp4, cancelled)
    }

    /// Explicit experimental profile. FLAC retains the complete encoded sample
    /// sequence at its original precision/rate/channels. Visible MP4 offsets,
    /// gaps, trims and configuration changes are unsupported; no sample repair.
    pub fn copy_profile(
        &self,
        request: &CopyRemuxRequest<'_>,
        profile: CopyProfile,
        cancelled: &AtomicBool,
    ) -> Result<CopyRemuxResult, ProbeError> {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        {
            self.remux_impl(
                request,
                profile,
                &super::Callback::new(cancelled),
                &mut || {},
                &mut || {},
            )
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = (request, profile, cancelled);
            Err(ProbeError::Unavailable(
                "copy-remux requires the optional Linux/Windows companion".into(),
            ))
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
use super::{backend_error, media_error, wire};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use crate::MediaErrorKind;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::{
    fs,
    io::{Seek, SeekFrom},
    path::PathBuf,
    sync::atomic::Ordering,
};

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(super) struct Capability {
    remux: wire::Remux,
    flac: Result<wire::Remux, ProbeError>,
    release: wire::RemuxRelease,
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Capability {
    fn function(&self, profile: CopyProfile) -> Result<wire::Remux, ProbeError> {
        match profile {
            CopyProfile::Mp4 => Ok(self.remux),
            CopyProfile::Flac => self.flac.clone(),
        }
    }
    pub(super) fn load(library: &wire::Library) -> Result<Self, ProbeError> {
        use std::mem::{MaybeUninit, size_of, transmute};
        // SAFETY: M1 has negotiated the trusted build. This reads only the
        // independent M5 schema; missing/shorter capabilities stay unavailable.
        unsafe {
            let info: wire::GetRemuxInfo = transmute(library.symbol(c"bm_remux_info_v1")?);
            let mut raw = MaybeUninit::<wire::RemuxInfo>::zeroed();
            if info(size_of::<wire::RemuxInfo>() as u32, raw.as_mut_ptr()) != 0 {
                return Err(backend_error("remux negotiation unavailable"));
            }
            let raw = raw.assume_init();
            if raw.schema != 1
                || raw.request_size as usize != size_of::<wire::RemuxRequest>()
                || raw.result_size as usize != size_of::<wire::RemuxResult>()
                || raw.scan_size as usize != size_of::<wire::ScanResult>()
            {
                return Err(backend_error("incompatible remux schema/layout"));
            }
            Ok(Self {
                // Same M5 layout, independently advertised optional profile.
                // An older companion keeps MP4/probe/scan without FLAC.
                flac: (|| -> Result<wire::Remux, ProbeError> {
                    let info: wire::GetRemuxInfo = transmute(library.symbol(c"bm_flac_info_v1")?);
                    let mut flac = MaybeUninit::<wire::RemuxInfo>::zeroed();
                    if info(size_of::<wire::RemuxInfo>() as u32, flac.as_mut_ptr()) != 0 {
                        return Err(backend_error("FLAC capability unavailable"));
                    }
                    let flac = flac.assume_init();
                    if flac.schema != raw.schema
                        || flac.request_size != raw.request_size
                        || flac.result_size != raw.result_size
                        || flac.scan_size != raw.scan_size
                    {
                        return Err(backend_error("incompatible FLAC schema/layout"));
                    }
                    Ok(transmute::<*mut std::ffi::c_void, wire::Remux>(
                        library.symbol(c"bm_copy_flac_v1")?,
                    ))
                })(),
                remux: transmute::<*mut std::ffi::c_void, wire::Remux>(
                    library.symbol(c"bm_copy_remux_mp4_v1")?,
                ),
                release: transmute::<*mut std::ffi::c_void, wire::RemuxRelease>(
                    library.symbol(c"bm_remux_release_v1")?,
                ),
            })
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
struct OwnedResult<'a> {
    pointer: *mut wire::RemuxResult,
    capability: &'a Capability,
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Drop for OwnedResult<'_> {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: allocating module is still borrowed/loaded.
            unsafe { (self.capability.release)(self.pointer) };
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn io_error(_: std::io::Error) -> ProbeError {
    media_error(MediaErrorKind::Io, "experimental output I/O failed")
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
struct Scratch {
    directory: PathBuf,
    file: PathBuf,
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Scratch {
    fn new(parent: &Path) -> Result<Self, ProbeError> {
        #[cfg(target_os = "linux")]
        use std::os::unix::fs::DirBuilderExt;
        for _ in 0..16 {
            let mut nonce = [0; 16];
            getrandom::fill(&mut nonce).map_err(|_| backend_error("scratch name unavailable"))?;
            let directory = parent.join(format!(
                ".bilikara-remux-{:032x}",
                u128::from_ne_bytes(nonce)
            ));
            let builder = fs::DirBuilder::new();
            #[cfg(target_os = "linux")]
            let mut builder = builder;
            #[cfg(target_os = "linux")]
            builder.mode(0o700);
            match builder.create(&directory) {
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_error(e)),
                Ok(()) => {
                    let scratch = Self {
                        file: directory.join("output.mp4"),
                        directory,
                    };
                    // C may truncate only this empty, exclusively owned file.
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&scratch.file)
                        .map_err(io_error)?;
                    return Ok(scratch);
                }
            }
        }
        Err(backend_error("scratch allocation exhausted"))
    }
    fn cleanup(&self) -> std::io::Result<()> {
        match fs::remove_file(&self.file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        match fs::remove_dir(&self.directory) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

/// Reuse S3's box-header reader without collecting the file or a new MP4
/// parser. Bounded envelope only: not sample-offset or full decode validation.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn layout(
    file: &mut fs::File,
    output: bool,
    flag: &AtomicBool,
) -> Result<bool, ProbeError> {
    layout_facts(file, output, flag).map(|(leading, _)| leading)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn layout_facts(
    file: &mut fs::File,
    output: bool,
    flag: &AtomicBool,
) -> Result<(bool, bool), ProbeError> {
    let size = file.metadata().map_err(io_error)?.len();
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let (mut ftyp, mut moov, mut mdat, mut fragmented) = (false, None, None, false);
    let mut offset = 0;
    let mut boxes = 0;
    while offset < size {
        if flag.load(Ordering::Relaxed) {
            return Err(ProbeError::Cancelled);
        }
        if boxes == 4096 {
            return Err(media_error(
                MediaErrorKind::UnsupportedContainerLayout,
                "MP4 top-level box bound exceeded",
            ));
        }
        let entry = crate::media_backend::read_box_header(file, size).map_err(ProbeError::Media)?;
        match &entry.kind {
            b"ftyp" => ftyp = true,
            b"moov" => {
                moov.get_or_insert(entry.start);
            }
            b"mdat" => {
                mdat.get_or_insert(entry.start);
            }
            b"moof" => fragmented = true,
            _ => {}
        }
        offset = entry.start + entry.size;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        boxes += 1;
    }
    if moov.is_none() || mdat.is_none() {
        return Err(media_error(
            MediaErrorKind::InvalidMedia,
            "self-contained MP4 requires moov and mdat",
        ));
    }
    if !ftyp {
        return Err(media_error(
            MediaErrorKind::UnsupportedContainerLayout,
            "copy-remux requires an MP4-family ftyp",
        ));
    }
    let leading = moov < mdat;
    if output && (fragmented || !leading) {
        return Err(backend_error(
            "remux output is not ordinary leading-moov MP4",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok((leading, fragmented))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn contract(
    metadata: &Metadata,
    kind: ExpectedMediaKind,
    profile: CopyProfile,
    output: bool,
) -> Result<(), ProbeError> {
    use super::StreamType;
    let flac = profile == CopyProfile::Flac;
    if metadata.container
        != if flac && output {
            "flac"
        } else {
            "mov,mp4,m4a,3gp,3g2,mj2"
        }
    {
        return Err(ProbeError::UnsupportedFormat(
            "copy-remux requires MP4-family input".into(),
        ));
    }
    let (ty, codec) = match kind {
        ExpectedMediaKind::Audio => (StreamType::Audio, if flac { "flac" } else { "aac" }),
        ExpectedMediaKind::Video => (StreamType::Video, "h264"),
    };
    if metadata.streams.len() != 1
        || metadata.streams[0].media_type != ty
        || (flac && kind != ExpectedMediaKind::Audio)
    {
        return Err(media_error(
            MediaErrorKind::MediaContractViolation,
            "copy-remux requires exactly one stream of the expected kind",
        ));
    }
    if metadata.streams[0].codec_name.as_deref() != Some(codec) {
        return Err(media_error(
            MediaErrorKind::UnsupportedCodec,
            "codec is outside the requested copy profile",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn same_bounds(a: &super::PacketSummary, b: &super::PacketSummary) -> bool {
    let (Some(ab), Some(bb)) = (a.time_base, b.time_base) else {
        return false;
    };
    let rescale = |v: i64| {
        let n = i128::from(v) * i128::from(ab.numerator) * i128::from(bb.denominator);
        let d = i128::from(ab.denominator) * i128::from(bb.numerator);
        (n + if n < 0 { -d / 2 } else { d / 2 }) / d
    };
    [(a.pts_ticks, b.pts_ticks), (a.dts_ticks, b.dts_ticks)].iter().all(|(a, b)| {
        matches!((a, b), (Some(a), Some(b)) if rescale(a.min) == i128::from(b.min) && rescale(a.max) == i128::from(b.max))
    })
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
impl LibavMetadataProbe {
    // The two local hooks are private deterministic test checkpoints. Public
    // calls always supply no-ops; no scheduler/attempt identities are involved.
    pub(crate) fn remux_impl(
        &self,
        q: &CopyRemuxRequest<'_>,
        profile: CopyProfile,
        callback: &super::Callback<'_>,
        before_publish: &mut dyn FnMut(),
        after_publish: &mut dyn FnMut(),
    ) -> Result<CopyRemuxResult, ProbeError> {
        use std::ffi::CString;
        #[cfg(target_os = "linux")]
        use std::os::unix::ffi::OsStrExt;
        let capability = self.remux.as_ref().map_err(Clone::clone)?;
        self.scan.as_ref().map_err(Clone::clone)?;
        let transform = capability.function(profile)?;
        let check_cancel = || {
            if callback.is_cancelled() {
                Err(ProbeError::Cancelled)
            } else {
                Ok(())
            }
        };
        check_cancel()?;
        if !q.destination.is_absolute() || q.destination.file_name().is_none() {
            return Err(media_error(
                MediaErrorKind::InvalidRequest,
                "destination must be an absolute file path",
            ));
        }
        #[cfg(target_os = "windows")]
        wire::Library::check_local_path(q.destination)?;
        let reject_exists = || {
            media_error(
                MediaErrorKind::DestinationExists,
                "experimental destination already exists",
            )
        };
        match fs::symlink_metadata(q.destination) {
            Ok(_) => return Err(reject_exists()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(e)),
        }
        let mut input_file = super::open_input(q.source)?;
        let metadata = self.probe_with_callback(q.source, callback)?;
        contract(&metadata, q.expected_kind, profile, false)?;
        layout(&mut input_file, false, callback.flag)?;
        let scratch = Scratch::new(q.destination.parent().unwrap())?;
        #[cfg(target_os = "linux")]
        let path = CString::new(scratch.file.as_os_str().as_bytes())
            .map_err(|_| media_error(MediaErrorKind::InvalidRequest, "destination contains NUL"))?;
        #[cfg(target_os = "windows")]
        let path = CString::new(scratch.file.to_str().ok_or_else(|| {
            media_error(
                MediaErrorKind::InvalidRequest,
                "destination is not valid Unicode",
            )
        })?)
        .map_err(|_| media_error(MediaErrorKind::InvalidRequest, "destination contains NUL"))?;
        let descriptor = self._library.descriptor(&input_file)?;
        let request = wire::RemuxRequest {
            input: wire::Request {
                fd: descriptor.fd,
                cancelled: super::cancellation_callback,
                opaque: (callback as *const super::Callback<'_>).cast_mut().cast(),
            },
            media_type: match q.expected_kind {
                ExpectedMediaKind::Video => 1,
                ExpectedMediaKind::Audio => 2,
            },
            staging_path: path.as_ptr(),
        };
        let mut pointer = std::ptr::null_mut();
        // SAFETY: separately negotiated ABI; fd/callback/string/library live
        // through this synchronous call and its allocating-module release.
        let status = unsafe { transform(&request, &mut pointer) };
        let owned = OwnedResult {
            pointer,
            capability,
        };
        if status != 0 {
            return Err(super::status_error(status, "copy-remux call failed".into()));
        }
        if owned.pointer.is_null() {
            return Err(backend_error("null copy-remux result"));
        }
        let raw = unsafe { &*owned.pointer };
        if raw.status != 0 {
            let cause = if raw.input_scan.selected.corrupt_packets > 0 {
                "observed corrupt packet"
            } else if raw.stage == 3
                && raw.input_scan.terminal == 1
                && raw.input_scan.selected.packet_count == 0
            {
                "observed empty EOF"
            } else if raw.status == 11 {
                "unsupported timing or changing configuration"
            } else {
                "failed"
            };
            return Err(super::status_error(
                raw.status,
                format!("copy-remux {cause} at stage {}", raw.stage),
            ));
        }
        if raw.finalized != 1 || raw.configuration_preserved != 1 || raw.stage != 7 {
            return Err(backend_error(
                "remux claimed success without finalization/configuration checks",
            ));
        }
        let selection = super::ScanSelection {
            stream_index: metadata.streams[0].index,
            expected_kind: q.expected_kind,
        };
        let input = super::scan::convert(&raw.input_scan, selection)?;
        if !input.clean_eof() {
            return Err(backend_error(
                "remux claimed success without clean input EOF",
            ));
        }
        check_cancel()?;
        let mut output_file = super::open_input(&scratch.file)?;
        let (leading_moov, flac_streaminfo) = match profile {
            CopyProfile::Mp4 => (layout(&mut output_file, true, callback.flag)?, None),
            CopyProfile::Flac => (
                false,
                Some(
                    FlacStreamInfo::read(&mut output_file)
                        .map_err(|_| backend_error("finalized native FLAC header invalid"))?,
                ),
            ),
        };
        let output_bytes = output_file.metadata().map_err(io_error)?.len();
        let output = self.probe_with_callback(&scratch.file, callback)?;
        contract(&output, q.expected_kind, profile, true)?;
        let output_scan = self.scan_with_callback(
            &scratch.file,
            super::ScanSelection {
                stream_index: 0,
                ..selection
            },
            callback,
        )?;
        if !output_scan.clean_eof() {
            return Err(output_scan
                .error
                .unwrap_or_else(|| backend_error("output scan incomplete")));
        }
        let a = input
            .selected
            .as_ref()
            .ok_or_else(|| backend_error("input summary absent"))?;
        let b = output_scan.selected.as_ref().unwrap();
        if a.payload_bytes != b.payload_bytes
            || a.codec_name != b.codec_name
            || (profile == CopyProfile::Mp4
                && (a.packet_count != b.packet_count || !same_bounds(a, b)))
        {
            return Err(backend_error(
                "finalized packet inventory or timing bounds changed",
            ));
        }
        if let Some(info) = &flac_streaminfo {
            for stream in [&metadata.streams[0], &output.streams[0]] {
                if stream.sample_rate_hz != Some(info.sample_rate_hz)
                    || stream.channel_count != Some(info.channel_count)
                    || stream.raw_bit_depth != Some(info.bits_per_sample)
                {
                    return Err(backend_error("FLAC sample configuration changed"));
                }
            }
        }
        let mut result = CopyRemuxResult {
            operation: "copy_remux",
            profile: profile.name(),
            checking_depth: if profile == CopyProfile::Mp4 {
                "streamcopy; exact decoder config, packet traversal, single-stream reopen, moov/mdat envelope; no full decode, playback certificate or cache-ready authority"
            } else {
                "streamcopy; complete STREAMINFO preserved; demux-visible continuous untrimmed sequence; packet traversal/payload length/reopen/header; no full decode, exhaustive edit-list or codec-corruption validation, playback certificate or cache-ready authority"
            },
            input,
            input_metadata: metadata,
            output,
            output_scan,
            decoder_configuration_preserved: true,
            leading_moov,
            flac_streaminfo,
            finalized_and_published: true,
            output_bytes,
            cleanup_warning: None,
        };
        drop(owned);
        #[cfg(target_os = "windows")]
        drop(descriptor);
        drop(output_file);
        drop(input_file);
        before_publish();
        check_cancel()?;
        // S2's same-filesystem no-replace primitive, kept local to avoid its
        // normalization-specific test hook/error policy. Never unlink target.
        fs::hard_link(&scratch.file, q.destination).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                reject_exists()
            } else {
                io_error(e)
            }
        })?;
        after_publish();
        // Committed: a late cancellation or scratch failure cannot invite a
        // destructive retry. There are no further fallible output operations.
        if scratch.cleanup().is_err() {
            result.cleanup_warning = Some("owned_scratch_cleanup_incomplete");
        }
        Ok(result)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "remux/windows_tests.rs"]
mod windows_tests;
