//! Windows x64 preview loader. No process-global DLL search mutations.
use crate::MediaErrorKind;
use crate::experimental_libav::{ProbeError, input_error, media_error};
use std::ffi::{CStr, OsString, c_void};
use std::os::windows::{
    ffi::{OsStrExt, OsStringExt},
    io::AsRawHandle,
};
use std::path::{Component, Path, PathBuf, Prefix};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FreeLibrary, HMODULE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW,
            TH32CS_SNAPMODULE,
        },
        LibraryLoader::{
            GetModuleFileNameW, GetProcAddress, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
        },
        Threading::GetCurrentProcessId,
    },
};

type OpenFd = unsafe extern "C" fn(*mut c_void) -> i32;
type CloseFd = unsafe extern "C" fn(i32);
pub(in crate::experimental_libav) struct Library {
    handle: HMODULE,
}

fn unavailable() -> ProbeError {
    ProbeError::Unavailable(
        "optional Windows companion/dependency unavailable or outside vendor directory".into(),
    )
}

impl Library {
    pub(in crate::experimental_libav) fn check_local_path(path: &Path) -> Result<(), ProbeError> {
        // Reject UNC/device paths, ADS and drive-relative names before opening:
        // no named-pipe wait, remote share, or Win32 device fallback.
        let mut parts = path.components();
        if !matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
            || !matches!(parts.next(), Some(Component::RootDir))
            || path
                .to_str()
                .is_none_or(|p| p[2..].contains(':') || p.contains('\0'))
        {
            return Err(media_error(
                MediaErrorKind::InvalidRequest,
                "expected an absolute local drive path",
            ));
        }
        Ok(())
    }

    pub(in crate::experimental_libav) unsafe fn open(path: &Path) -> Result<Self, ProbeError> {
        Self::check_local_path(path).map_err(|_| unavailable())?;
        let directory = path
            .parent()
            .ok_or_else(unavailable)?
            .canonicalize()
            .map_err(|_| unavailable())?;
        // Refuse already-loaded foreign FFmpeg modules. Windows checks the loaded
        // module list before directories even with restricted search flags.
        verify_modules(&directory)?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if handle.is_null() {
            return Err(unavailable());
        }
        let library = Self { handle };
        verify_modules(&directory)?;
        library.symbol(c"bm_fd_from_handle_v1")?;
        library.symbol(c"bm_fd_close_v1")?;
        Ok(library)
    }

    pub(in crate::experimental_libav) fn symbol(
        &self,
        name: &CStr,
    ) -> Result<*mut c_void, ProbeError> {
        unsafe { GetProcAddress(self.handle, name.as_ptr().cast()) }
            .map(|f| f as *mut c_void)
            .ok_or_else(unavailable)
    }

    pub(in crate::experimental_libav) fn descriptor<'a>(
        &'a self,
        file: &std::fs::File,
    ) -> Result<Descriptor<'a>, ProbeError> {
        // The companion duplicates the borrowed OS handle and creates the fd in
        // the shared /MD UCRT used by FFmpeg. No Rust CRT descriptor crosses ABI.
        let open: OpenFd = unsafe { std::mem::transmute(self.symbol(c"bm_fd_from_handle_v1")?) };
        let close: CloseFd = unsafe { std::mem::transmute(self.symbol(c"bm_fd_close_v1")?) };
        let fd = unsafe { open(file.as_raw_handle()) };
        if fd < 0 {
            return Err(input_error(std::io::Error::other(
                "companion could not duplicate local file handle",
            )));
        }
        Ok(Descriptor {
            fd,
            close,
            _owner: self,
        })
    }
}

pub(in crate::experimental_libav) struct Descriptor<'a> {
    pub fd: i32,
    close: CloseFd,
    _owner: &'a Library,
}
impl Drop for Descriptor<'_> {
    fn drop(&mut self) {
        unsafe { (self.close)(self.fd) };
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.handle) };
    }
}

fn loaded_module_path(handle: HMODULE) -> Result<PathBuf, ProbeError> {
    // Query the loaded module directly. The snapshot's filename field can lose
    // non-ASCII path characters and cannot represent full-length Win32 paths.
    let mut filename = vec![0_u16; 32768];
    let length =
        unsafe { GetModuleFileNameW(handle, filename.as_mut_ptr(), filename.len() as u32) };
    if length == 0 || length as usize >= filename.len() {
        return Err(unavailable());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &filename[..length as usize],
    )))
}

fn verify_modules(directory: &Path) -> Result<(), ProbeError> {
    // A per-load snapshot, not a registry. FFmpeg and companion modules must
    // originate in the selected vendor directory. The shared Microsoft CRT can
    // already be loaded by the embedding application; package smoke records it.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId()) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(unavailable());
    }
    let result = (|| {
        let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        let mut more = unsafe { Module32FirstW(snapshot, &mut entry) };
        if more == 0 {
            return Err(unavailable());
        }
        while more != 0 {
            let name = String::from_utf16_lossy(
                &entry.szModule[..entry
                    .szModule
                    .iter()
                    .position(|v| *v == 0)
                    .ok_or_else(unavailable)?],
            )
            .to_lowercase();
            let ffmpeg = [
                "avcodec-",
                "avformat-",
                "avutil-",
                "avfilter-",
                "avdevice-",
                "swresample-",
                "swscale-",
            ]
            .iter()
            .any(|p| name.starts_with(p))
                && name.ends_with(".dll");
            if ffmpeg || name.starts_with("bilikara_media_libav") {
                let path = loaded_module_path(entry.hModule)?;
                let actual = path.canonicalize().map_err(|_| unavailable())?;
                if actual.parent() != Some(directory) {
                    return Err(unavailable());
                }
            }
            more = unsafe { Module32NextW(snapshot, &mut entry) };
        }
        Ok(())
    })();
    unsafe { CloseHandle(snapshot) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_module_path_preserves_vendor_boundary() {
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("Bilikara module 空 {} {nonce}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let _cleanup = Cleanup(directory.clone());
        let source =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/version.dll");
        let copied = directory.join("avcodec-module-fixture.dll");
        std::fs::copy(source, &copied).unwrap();
        let wide: Vec<u16> = copied.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        assert!(!handle.is_null());
        let library = Library { handle };
        assert_eq!(
            loaded_module_path(library.handle)
                .unwrap()
                .canonicalize()
                .unwrap(),
            copied.canonicalize().unwrap()
        );
        verify_modules(&directory.canonicalize().unwrap()).unwrap();
        let foreign = directory.join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        assert!(matches!(
            verify_modules(&foreign.canonicalize().unwrap()),
            Err(ProbeError::Unavailable(_))
        ));
    }
}
