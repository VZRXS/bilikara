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

#[derive(Debug, Serialize)]
pub struct CopyRemuxResult {
    pub operation: &'static str,
    pub profile: &'static str,
    pub checking_depth: &'static str,
    pub input: PacketScan,
    pub output: Metadata,
    pub output_scan: PacketScan,
    pub decoder_configuration_preserved: bool,
    pub leading_moov: bool,
    pub finalized_and_published: bool,
    pub output_bytes: u64,
    pub cleanup_warning: Option<&'static str>,
}

impl LibavMetadataProbe {
    pub fn copy_remux_available(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.remux.is_some() && self.packet_scan_available()
        }
        #[cfg(not(target_os = "linux"))]
        {
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
        #[cfg(target_os = "linux")]
        {
            self.remux_impl(
                request,
                &super::Callback::new(cancelled),
                &mut || {},
                &mut || {},
            )
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (request, cancelled);
            Err(ProbeError::Unavailable(
                "copy-remux requires the optional Linux companion".into(),
            ))
        }
    }
}

#[cfg(target_os = "linux")]
use super::{backend_error, media_error, wire};
#[cfg(target_os = "linux")]
use crate::MediaErrorKind;
#[cfg(target_os = "linux")]
use std::{
    fs,
    io::{Seek, SeekFrom},
    path::PathBuf,
    sync::atomic::Ordering,
};

#[cfg(target_os = "linux")]
pub(super) struct Capability {
    remux: wire::Remux,
    release: wire::RemuxRelease,
}
#[cfg(target_os = "linux")]
impl Capability {
    pub(super) fn load(library: &wire::linux::Library) -> Result<Self, ProbeError> {
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

#[cfg(target_os = "linux")]
struct OwnedResult<'a> {
    pointer: *mut wire::RemuxResult,
    capability: &'a Capability,
}
#[cfg(target_os = "linux")]
impl Drop for OwnedResult<'_> {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: allocating module is still borrowed/loaded.
            unsafe { (self.capability.release)(self.pointer) };
        }
    }
}

#[cfg(target_os = "linux")]
fn io_error(_: std::io::Error) -> ProbeError {
    media_error(MediaErrorKind::Io, "experimental output I/O failed")
}

#[cfg(target_os = "linux")]
struct Scratch {
    directory: PathBuf,
    file: PathBuf,
}
#[cfg(target_os = "linux")]
impl Scratch {
    fn new(parent: &Path) -> Result<Self, ProbeError> {
        use std::os::unix::fs::DirBuilderExt;
        for _ in 0..16 {
            let mut nonce = [0; 16];
            getrandom::fill(&mut nonce).map_err(|_| backend_error("scratch name unavailable"))?;
            let directory = parent.join(format!(
                ".bilikara-remux-{:032x}",
                u128::from_ne_bytes(nonce)
            ));
            match fs::DirBuilder::new().mode(0o700).create(&directory) {
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
#[cfg(target_os = "linux")]
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

/// Reuse S3's box-header reader without collecting the file or a new MP4
/// parser. Bounded envelope only: not sample-offset or full decode validation.
#[cfg(target_os = "linux")]
fn layout(file: &mut fs::File, output: bool, flag: &AtomicBool) -> Result<bool, ProbeError> {
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
    Ok(leading)
}

#[cfg(target_os = "linux")]
fn contract(metadata: &Metadata, kind: ExpectedMediaKind) -> Result<(), ProbeError> {
    use super::StreamType;
    if metadata.container != "mov,mp4,m4a,3gp,3g2,mj2" {
        return Err(ProbeError::UnsupportedFormat(
            "copy-remux requires MP4-family input".into(),
        ));
    }
    let (ty, codec) = match kind {
        ExpectedMediaKind::Audio => (StreamType::Audio, "aac"),
        ExpectedMediaKind::Video => (StreamType::Video, "h264"),
    };
    if metadata.streams.len() != 1 || metadata.streams[0].media_type != ty {
        return Err(media_error(
            MediaErrorKind::MediaContractViolation,
            "copy-remux requires exactly one stream of the expected kind",
        ));
    }
    if metadata.streams[0].codec_name.as_deref() != Some(codec) {
        return Err(media_error(
            MediaErrorKind::UnsupportedCodec,
            "copy-remux profile supports H.264 video or AAC audio",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
impl LibavMetadataProbe {
    // The two local hooks are private deterministic test checkpoints. Public
    // calls always supply no-ops; no scheduler/attempt identities are involved.
    fn remux_impl(
        &self,
        q: &CopyRemuxRequest<'_>,
        callback: &super::Callback<'_>,
        before_publish: &mut dyn FnMut(),
        after_publish: &mut dyn FnMut(),
    ) -> Result<CopyRemuxResult, ProbeError> {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let capability = self
            .remux
            .as_ref()
            .filter(|_| self.packet_scan_available())
            .ok_or_else(|| {
                ProbeError::Unavailable("companion copy-remux schema v1 unavailable".into())
            })?;
        let check_cancel = || {
            if callback.flag.load(Ordering::Relaxed) {
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
        contract(&metadata, q.expected_kind)?;
        layout(&mut input_file, false, callback.flag)?;
        let scratch = Scratch::new(q.destination.parent().unwrap())?;
        let path = CString::new(scratch.file.as_os_str().as_bytes())
            .map_err(|_| media_error(MediaErrorKind::InvalidRequest, "destination contains NUL"))?;
        let request = wire::RemuxRequest {
            input: wire::Request {
                fd: input_file.as_raw_fd(),
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
        let status = unsafe { (capability.remux)(&request, &mut pointer) };
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
        let leading_moov = layout(&mut output_file, true, callback.flag)?;
        let output_bytes = output_file.metadata().map_err(io_error)?.len();
        let output = self.probe_with_callback(&scratch.file, callback)?;
        contract(&output, q.expected_kind)?;
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
        if a.packet_count != b.packet_count
            || a.payload_bytes != b.payload_bytes
            || a.codec_name != b.codec_name
            || !same_bounds(a, b)
        {
            return Err(backend_error(
                "finalized packet inventory or timing bounds changed",
            ));
        }
        let mut result = CopyRemuxResult {
            operation: "copy_remux",
            profile: "mp4_single_h264_or_aac_faststart_v1",
            checking_depth: "streamcopy; exact decoder config, packet traversal, single-stream reopen, moov/mdat envelope; no full decode, playback certificate or cache-ready authority",
            input,
            output,
            output_scan,
            decoder_configuration_preserved: true,
            leading_moov,
            finalized_and_published: true,
            output_bytes,
            cleanup_warning: None,
        };
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
