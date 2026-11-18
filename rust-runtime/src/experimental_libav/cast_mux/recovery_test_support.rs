//! Real filesystem obstructions shared by cast recovery integration tests.
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Obstruction {
    LeaseDirectory,
    #[cfg(windows)]
    SharingViolation,
    #[cfg(windows)]
    PermissionDenied,
}
pub(crate) fn cases() -> Vec<Obstruction> {
    vec![
        Obstruction::LeaseDirectory,
        #[cfg(windows)]
        Obstruction::SharingViolation,
        #[cfg(windows)]
        Obstruction::PermissionDenied,
    ]
}
pub(crate) fn orphan(root: &Path, id: u128) -> PathBuf {
    let path = root.join(".cast").join(format!("{id:032x}"));
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("crashed.part"), b"unfinished").unwrap();
    path
}
pub(crate) struct BlockedOrphan {
    pub path: PathBuf,
    pub reason: &'static str,
    #[cfg(windows)]
    _handle: Option<fs::File>,
    #[cfg(windows)]
    denied: Option<PathBuf>,
}
impl BlockedOrphan {
    pub fn new(root: &Path, obstruction: Obstruction) -> Self {
        let path = orphan(root, 1);
        let lease = path.join(".lease");
        #[allow(unused_mut)] // only Windows fixtures need handles/ACL restoration
        let mut guard = Self {
            path,
            reason: "lease:invalid_layout",
            #[cfg(windows)]
            _handle: None,
            #[cfg(windows)]
            denied: None,
        };
        match obstruction {
            Obstruction::LeaseDirectory => fs::create_dir(lease).unwrap(),
            #[cfg(windows)]
            Obstruction::SharingViolation => {
                use std::os::windows::fs::OpenOptionsExt;
                guard._handle = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .share_mode(1 | 2) // FILE_SHARE_READ | WRITE, deliberately no DELETE
                        .open(guard.path.join("crashed.part"))
                        .unwrap(),
                );
                guard.reason = "remove:sharing_violation";
            }
            #[cfg(windows)]
            Obstruction::PermissionDenied => {
                fs::write(&lease, b"").unwrap();
                guard.denied = Some(lease.clone()); // restore even if the assertion panics
                acl(&lease, &["/deny", "*S-1-1-0:(RD,WD)"]);
                assert_eq!(
                    fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&lease)
                        .unwrap_err()
                        .kind(),
                    std::io::ErrorKind::PermissionDenied
                );
                guard.reason = "lease:permission_denied";
            }
        }
        guard
    }
}
#[cfg(windows)]
fn acl(path: &Path, arguments: &[&str]) {
    let output = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "test ACL operation failed: {:?}",
        output.status
    );
}
#[cfg(windows)]
impl Drop for BlockedOrphan {
    fn drop(&mut self) {
        if let Some(path) = self.denied.take() {
            acl(&path, &["/remove:d", "*S-1-1-0"]);
        }
    }
}
