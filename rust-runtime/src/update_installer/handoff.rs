//! Private, bounded startup handshake in the existing update workspace.
//! The updater cannot install until the Host acknowledges readiness. A slow
//! or abandoned launch therefore cannot unexpectedly install on a later quit.
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(super) const START_TIMEOUT: Duration = Duration::from_secs(10);
const ACK_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST: &str = "handoff-request";
const READY: &str = "handoff-ready";
const ACK: &str = "handoff-ack";
const ERROR: &str = "handoff-error";

pub(super) struct Handoff {
    workspace: PathBuf,
    nonce: String,
}

fn read(path: &Path) -> io::Result<Option<String>> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut text = String::new();
    (&mut file).take(4097).read_to_string(&mut text)?;
    if text.len() > 4096 {
        return Err(io::Error::other("oversized updater handshake"));
    }
    Ok(Some(text))
}

impl Handoff {
    pub(super) fn begin(workspace: &Path) -> io::Result<Self> {
        for name in [READY, ACK, ERROR] {
            match fs::symlink_metadata(workspace.join(name)) {
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "stale updater handshake",
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
        let mut nonce = [0_u8; 32];
        getrandom::fill(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        // A second launch must not reuse an earlier acknowledgement.
        let mut request = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(workspace.join(REQUEST))?;
        request.write_all(nonce.as_bytes())?;
        request.sync_all()?;
        Ok(Self {
            workspace: workspace.into(),
            nonce,
        })
    }

    pub(super) fn receive(workspace: &Path) -> io::Result<Option<Self>> {
        let Some(nonce) = read(&workspace.join(REQUEST))? else {
            // Preserve direct --plan launches and the published plan schema.
            return Ok(None);
        };
        if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(io::Error::other("invalid updater handshake"));
        }
        Ok(Some(Self {
            workspace: workspace.into(),
            nonce,
        }))
    }

    fn publish(&self, name: &str, value: &str) -> io::Result<()> {
        let partial = self.workspace.join(format!("{name}.partial"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(partial, self.workspace.join(name))
    }

    /// Host side. Only an exact reply for this attempt allows application exit.
    pub(super) fn wait_ready(
        &self,
        timeout: Duration,
        mut exited: impl FnMut() -> io::Result<bool>,
    ) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(error) = read(&self.workspace.join(ERROR))? {
                return Err(io::Error::other(format!("updater startup failed: {error}")));
            }
            if exited()? {
                return Err(io::Error::other(
                    "updater exited before accepting the update",
                ));
            }
            if let Some(ready) = read(&self.workspace.join(READY))? {
                if ready != self.nonce {
                    return Err(io::Error::other(
                        "updater readiness does not match this launch",
                    ));
                }
                return self.publish(ACK, &self.nonce);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "updater did not become ready; application remains running",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Updater side, after validating the plan, opening its log and pinning owners.
    pub(super) fn ready(&self) -> io::Result<()> {
        self.publish(READY, &self.nonce)?;
        let deadline = Instant::now() + ACK_TIMEOUT;
        loop {
            if let Some(ack) = read(&self.workspace.join(ACK))? {
                if ack == self.nonce {
                    return Ok(());
                }
                return Err(io::Error::other("updater acknowledgement does not match"));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Host did not acknowledge updater readiness; nothing changed",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub(super) fn reject(&self, error: &io::Error) {
        let message: String = error.to_string().chars().take(1000).collect();
        let _ = self.publish(ERROR, &message);
    }
}
