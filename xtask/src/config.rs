use crate::Result;
use regex::Regex;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Environment(pub BTreeMap<OsString, OsString>);
impl Environment {
    pub fn current() -> Self {
        Self(env::vars_os().collect())
    }
    pub fn get(&self, key: &str) -> Option<&OsStr> {
        if let Some(value) = self.0.get(OsStr::new(key)) {
            return Some(value.as_os_str());
        }
        // Windows preserves names such as Path when enumerating the process
        // environment, but native lookup is case-insensitive. Keep values and
        // POSIX name semantics unchanged when taking our immutable snapshot.
        #[cfg(windows)]
        {
            self.0.iter().find_map(|(name, value)| {
                name.to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(key))
                    .then_some(value.as_os_str())
            })
        }
        #[cfg(not(windows))]
        None
    }
    pub fn text(&self, key: &str) -> String {
        self.get(key)
            .unwrap_or_default()
            .to_string_lossy()
            .trim()
            .to_owned()
    }
    pub fn mobile(&self) -> bool {
        matches!(
            self.get("TAURI_ENV_PLATFORM").and_then(OsStr::to_str),
            Some("android" | "ios")
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Os {
    Windows,
    Macos,
    Linux,
}
#[derive(Clone, Copy, Debug)]
pub struct Platform {
    pub os: Os,
    pub arm: bool,
}
impl Platform {
    pub fn current() -> Result<Self> {
        Self::new(env::consts::OS, env::consts::ARCH)
    }
    pub fn new(os: &str, arch: &str) -> Result<Self> {
        let os = match os {
            "windows" => Os::Windows,
            "macos" => Os::Macos,
            "linux" => Os::Linux,
            _ => return Err("Unsupported native libav bundle target".into()),
        };
        let arm = match arch.to_ascii_lowercase().as_str() {
            "arm64" | "aarch64" => true,
            "amd64" | "x86_64" => false,
            _ => return Err("Unsupported native libav bundle target".into()),
        };
        Ok(Self { os, arm })
    }
    pub fn target(self) -> String {
        format!(
            "{}-{}",
            if self.arm { "aarch64" } else { "x86_64" },
            match self.os {
                Os::Windows => "pc-windows-msvc",
                Os::Macos => "apple-darwin",
                Os::Linux => "unknown-linux-gnu",
            }
        )
    }
    pub fn name(self) -> &'static str {
        match self.os {
            Os::Windows => "windows",
            Os::Macos => "macos",
            Os::Linux => "linux",
        }
    }
    pub fn arch(self) -> &'static str {
        if self.arm { "arm64" } else { "x64" }
    }
    pub fn executable(self, name: &str) -> String {
        format!("{name}{}", if self.os == Os::Windows { ".exe" } else { "" })
    }
    pub fn companion(self) -> &'static str {
        match self.os {
            Os::Windows => "bilikara_media_libav.dll",
            Os::Macos => "libbilikara_media_libav.dylib",
            Os::Linux => "libbilikara_media_libav.so",
        }
    }
}

pub struct Config {
    pub root: PathBuf,
    pub platform: Platform,
    pub env: Environment,
    pub target: Option<OsString>,
    pub development: bool,
}
impl Config {
    pub fn new(
        root: &Path,
        platform: Platform,
        env: Environment,
        explicit: Option<OsString>,
    ) -> Result<Self> {
        let mut target = explicit.filter(|s| !s.is_empty()).or_else(|| {
            env.get("CARGO_BUILD_TARGET")
                .filter(|s| !s.is_empty())
                .map(OsStr::to_owned)
        });
        if target.is_none() {
            target = env
                .get("TAURI_ENV_TARGET_TRIPLE")
                .filter(|s| !s.is_empty() && *s != OsStr::new(&platform.target()))
                .map(OsStr::to_owned);
        }
        if target
            .as_deref()
            .is_some_and(|t| t != OsStr::new(&platform.target()))
        {
            return Err("Build desktop bundles on a matching target/architecture runner".into());
        }
        let development = !matches!(
            env.get("TAURI_ENV_DEBUG").and_then(OsStr::to_str),
            Some("false" | "0")
        );
        Ok(Self {
            root: root.into(),
            platform,
            env,
            target,
            development,
        })
    }
    pub fn profile(&self) -> &'static str {
        if self.development { "debug" } else { "release" }
    }
    pub fn target_output(&self, crate_name: &str) -> Result<PathBuf> {
        let output = Command::new("cargo")
            .current_dir(&self.root)
            .args(["metadata", "--manifest-path"])
            .arg(self.root.join(crate_name).join("Cargo.toml"))
            .args(["--format-version", "1", "--no-deps", "--locked"])
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "cargo metadata failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
        let data: Value = serde_json::from_slice(&output.stdout)?;
        let mut root = PathBuf::from(
            data["target_directory"]
                .as_str()
                .ok_or("cargo metadata omitted target_directory")?,
        );
        if let Some(target) = &self.target {
            root.push(target);
        }
        Ok(root.join(self.profile()))
    }
    fn git(&self, args: &[&str]) -> Option<String> {
        let mut command = Command::new("git");
        command.args(args).current_dir(&self.root);
        let output = timed_output(command, Duration::from_secs(5)).ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
    pub fn version(&self) -> Result<String> {
        let explicit = self.env.text("BILIKARA_VERSION");
        let version = if !explicit.is_empty() {
            explicit
        } else {
            let commit = self.git(&["rev-parse", "--verify", "HEAD"]);
            let branch = self.git(&["symbolic-ref", "--quiet", "--short", "HEAD"]);
            let changes = self.git(&["status", "--porcelain", "--untracked-files=normal"]);
            let mut tag = self.git(&["describe", "--exact-match", "--tags", "HEAD"]);
            let ref_type = self.env.text("GITHUB_REF_TYPE");
            let ref_name = self.env.text("GITHUB_REF_NAME");
            let tag_checkout = ref_type == "tag"
                || (ref_type.is_empty() && branch.as_deref().unwrap_or("").is_empty());
            if ref_type == "tag" && !ref_name.is_empty() {
                tag = (commit.is_some()
                    && self.git(&[
                        "rev-parse",
                        "--verify",
                        &format!("refs/tags/{ref_name}^{{commit}}"),
                    ]) == commit)
                    .then(|| ref_name.clone());
            }
            if tag_checkout
                && changes.as_deref() == Some("")
                && tag.as_deref().is_some_and(|s| {
                    Regex::new(r"(?i)^v?\d+\.\d+\.\d+(?:-preview\.\d+)?$")
                        .unwrap()
                        .is_match(s)
                })
            {
                tag.unwrap()
            } else {
                let label = if !ref_type.is_empty() {
                    let head = self.env.text("GITHUB_HEAD_REF");
                    if head.is_empty() { ref_name } else { head }
                } else {
                    branch.or(tag).unwrap_or_default()
                };
                let label = Regex::new(r"[^A-Za-z0-9./+_-]+")
                    .unwrap()
                    .replace_all(&label, "-");
                let label = label.trim_matches(['-', '.', '/']);
                let label = if label.is_empty() { "dev" } else { label };
                let commit = commit.unwrap_or_else(|| self.env.text("GITHUB_SHA"));
                let short = if Regex::new(r"^[0-9a-fA-F]{7,64}$")
                    .unwrap()
                    .is_match(&commit)
                {
                    &commit[..commit.len().min(12)]
                } else {
                    "unknown"
                };
                let suffix = format!(
                    "-g{short}{}",
                    if changes.is_some_and(|s| !s.is_empty()) {
                        "-dirty"
                    } else {
                        ""
                    }
                );
                format!("{}{suffix}", &label[..label.len().min(80 - suffix.len())])
            }
        };
        if !Regex::new(r"^[A-Za-z0-9./+_-]{1,80}$")
            .unwrap()
            .is_match(&version)
        {
            return Err("Invalid trusted build version".into());
        }
        Ok(version)
    }
}

// Drain both pipes while waiting, so verbose tools cannot deadlock the timeout.
pub fn timed_output(mut command: Command, timeout: Duration) -> Result<Output> {
    use std::io::Read;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut b = Vec::new();
        stdout.read_to_end(&mut b).map(|_| b)
    });
    let err = thread::spawn(move || {
        let mut b = Vec::new();
        stderr.read_to_end(&mut b).map(|_| b)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("build tool execution timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        status,
        stdout: out.join().map_err(|_| "stdout reader failed")??,
        stderr: err.join().map_err(|_| "stderr reader failed")??,
    })
}
