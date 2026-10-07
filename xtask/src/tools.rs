use crate::{
    Result,
    config::{Config, Os, timed_output},
    files,
    libav::command_output,
};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn bbdown(config: &Config) -> Result<Option<PathBuf>> {
    let tool = bbdown_path(config)?;
    if let Some(path) = &tool
        && !config.development
    {
        let (success, output) = help(path)?;
        if !success || output.trim().is_empty() {
            return Err(format!(
                "BBDown failed its release build execution check: {}",
                output.trim()
            )
            .into());
        }
        let expected = config.env.text("BILIKARA_BBDOWN_VERSION");
        if !expected.is_empty() && !output.contains(&expected) {
            return Err(format!(
                "BBDown release build version does not match pinned {expected}: {}",
                output.trim()
            )
            .into());
        }
        if config.platform.os == Os::Macos {
            let command = if Path::new("/usr/bin/otool").is_file() {
                "/usr/bin/otool"
            } else {
                "otool"
            };
            let output = command_output(command, &["-L".as_ref(), path.as_os_str()])?;
            for line in output.lines().skip(1) {
                let dependency = line
                    .trim()
                    .split(" (compatibility version")
                    .next()
                    .unwrap_or("")
                    .trim();
                if !dependency.is_empty()
                    && !dependency.starts_with("/usr/lib/")
                    && !dependency.starts_with("/System/Library/")
                {
                    return Err(format!(
                        "macOS release tool {} has non-portable dynamic dependencies: {dependency}",
                        path.display()
                    )
                    .into());
                }
            }
        }
    }
    Ok(tool)
}

pub fn help(path: &Path) -> Result<(bool, String)> {
    let mut command = Command::new(path);
    command.arg("--help");
    let result = timed_output(command, Duration::from_secs(30))?;
    Ok((
        result.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        )
        .replace("\r\n", "\n")
        .replace('\r', "\n"), // Python's retained text pipe used universal newlines.
    ))
}

pub fn bbdown_path(config: &Config) -> Result<Option<PathBuf>> {
    let mut paths: Vec<_> = env::split_paths(config.env.get("PATH").unwrap_or_default()).collect();
    let extensions: Vec<_> = if config.platform.os == Os::Windows {
        paths.insert(0, env::current_dir()?);
        config
            .env
            .get("PATHEXT")
            .filter(|v| !v.is_empty())
            .unwrap_or(".COM;.EXE;.BAT;.CMD".as_ref())
            .to_string_lossy()
            .split(';')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    let candidate = paths
        .iter()
        .flat_map(|path| {
            extensions
                .iter()
                .map(move |ext| path.join(format!("BBDown{ext}")))
        })
        .find(|p| executable(p));
    Ok(if config.platform.os == Os::Windows {
        candidate.and_then(|p| windows_tool(&p))
    } else {
        candidate
    })
}

fn windows_tool(candidate: &Path) -> Option<PathBuf> {
    let normalized = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let root = candidate.parent()?.parent()?;
    if normalized.contains("\\chocolatey\\bin\\") {
        for middle in ["tools/{package}/bin", "tools/bin"] {
            for package in ["ffmpeg", "BBDown"] {
                let path = root
                    .join("lib")
                    .join(package)
                    .join(middle.replace("{package}", package))
                    .join("BBDown.exe");
                if path.exists() {
                    return Some(path);
                }
            }
        }
        return None;
    }
    if normalized.contains("\\scoop\\shims\\") {
        for package in ["ffmpeg", "BBDown"] {
            let path = root
                .join("apps")
                .join(package)
                .join("current/bin/BBDown.exe");
            if path.exists() {
                return Some(path);
            }
        }
        return None;
    }
    Some(candidate.into())
}

pub fn aria2_metadata(config: &Config, vendor: &Path) -> Result<()> {
    let override_path = config.env.text("BILIKARA_ARIA2_MACOS_METADATA_FILE");
    let path = if override_path.is_empty() {
        config
            .root
            .join(format!("tools/aria2/macos-{}.json", config.platform.arch()))
    } else {
        expand_metadata_path(config, &override_path)?
    };
    if !path.is_file() {
        return Err(format!(
            "Configured macOS aria2c metadata not found: {}",
            path.display()
        )
        .into());
    }
    let payload: Value = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|e| format!("Invalid macOS aria2c metadata: {e}"))?;
    validate_aria2(&payload, config.platform.arch())?;
    let intermediate = config.root.join("build/aria2-macos.json");
    files::copy(&path.canonicalize()?, &intermediate)?;
    files::copy(&intermediate, &vendor.join("aria2-macos.json"))
}

pub fn expand_metadata_path(config: &Config, value: &str) -> Result<PathBuf> {
    let Some(rest) = value.strip_prefix('~') else {
        return Ok(value.into());
    };
    let (user, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    if user.is_empty()
        && let Some(home) = config.env.get("HOME")
    {
        return Ok(PathBuf::from(home).join(suffix));
    }
    #[cfg(unix)]
    {
        use std::ffi::{CStr, CString, OsStr};
        use std::os::unix::ffi::OsStrExt;
        let user = CString::new(user)?;
        let mut size = 16384;
        loop {
            let mut buffer = vec![0u8; size];
            let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
            let mut found = std::ptr::null_mut();
            // Reentrant OS lookup; returned strings stay in `buffer` until copied.
            let code = unsafe {
                if user.as_bytes().is_empty() {
                    libc::getpwuid_r(
                        libc::getuid(),
                        entry.as_mut_ptr(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                        &mut found,
                    )
                } else {
                    libc::getpwnam_r(
                        user.as_ptr(),
                        entry.as_mut_ptr(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                        &mut found,
                    )
                }
            };
            if code == libc::ERANGE && size < 1024 * 1024 {
                size *= 2;
                continue;
            }
            if code != 0 || found.is_null() {
                return Err("Cannot expand metadata home directory".into());
            }
            // A successful passwd lookup initializes entry and its pw_dir.
            let directory = unsafe { CStr::from_ptr((*found).pw_dir) };
            return Ok(Path::new(OsStr::from_bytes(directory.to_bytes())).join(suffix));
        }
    }
    #[cfg(not(unix))]
    Err("Cannot expand metadata home directory".into())
}

fn quote(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn validate_aria2(payload: &Value, arch: &str) -> Result<()> {
    let identity = json!({"schema_version":2,"tool":"aria2c","provider":"bilikara-r2","platform":"darwin","version":"1.37.0",
        "source_url":"https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz",
        "source_sha256":"60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"});
    if identity
        .as_object()
        .unwrap()
        .iter()
        .any(|(k, v)| payload.get(k) != Some(v))
    {
        return Err("Unexpected macOS aria2c metadata identity".into());
    }
    if payload["arch"] != arch {
        return Err(format!(
            "macOS aria2c metadata targets {}, but the bundle target is {arch}",
            payload["arch"]
        )
        .into());
    }
    let get = |key: &str| payload[key].as_str().unwrap_or("");
    if !Regex::new(r"^[0-9a-f]{64}$")
        .unwrap()
        .is_match(get("sha256"))
    {
        return Err("Invalid macOS aria2c asset SHA-256".into());
    }
    let name = get("name");
    if name.is_empty()
        || Path::new(name).file_name().is_none_or(|n| n != name)
        || !name.ends_with(".tar.gz")
    {
        return Err("Invalid macOS aria2c asset name".into());
    }
    let recipe = get("recipe_revision");
    if !Regex::new(r"^[A-Za-z0-9._:-]{1,128}$")
        .unwrap()
        .is_match(recipe)
    {
        return Err("Invalid macOS aria2c recipe revision".into());
    }
    // Match urllib.urlsplit's scheme/authority/path/query/fragment contract;
    // compare the encoded path without URL parser path normalization.
    let pattern = Regex::new(r"(?i)^https://([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$").unwrap();
    let valid = pattern.captures(get("url")).is_some_and(|parts| {
        &parts[1] == "download.kevinx96.icu"
            && parts[2].starts_with("/bilikara/tools/aria2/1.37.0/")
            && parts[2].contains(&format!("/{}/", quote(recipe)))
            && parts[2].ends_with(&format!("/{}", quote(name)))
            && [3, 4]
                .iter()
                .all(|i| parts.get(*i).is_none_or(|m| m.as_str().is_empty()))
    });
    if !valid {
        return Err("macOS aria2c asset URL must use HTTPS".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Environment, Platform};

    #[test]
    fn explicit_metadata_home_override_and_windows_shim_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config::new(
            temp.path(),
            Platform::new("macos", "x86_64").unwrap(),
            Environment([("HOME".into(), temp.path().as_os_str().to_owned())].into()),
            None,
        )
        .unwrap();
        assert_eq!(
            expand_metadata_path(&config, "~/配置 file.json").unwrap(),
            temp.path().join("配置 file.json")
        );
        for manager in ["chocolatey", "scoop"] {
            let root = temp.path().join(manager);
            let shim = root.join(if manager == "scoop" {
                "shims/BBDown.exe"
            } else {
                "bin/BBDown.exe"
            });
            assert!(windows_tool(&shim).is_none());
            let actual = root.join(if manager == "scoop" {
                "apps/BBDown/current/bin/BBDown.exe"
            } else {
                "lib/BBDown/tools/BBDown/bin/BBDown.exe"
            });
            fs::create_dir_all(actual.parent().unwrap()).unwrap();
            fs::write(&actual, b"fixture").unwrap();
            assert_eq!(windows_tool(&shim).unwrap(), actual);
        }
    }

    #[cfg(unix)]
    #[test]
    fn named_home_expansion_uses_os_records_without_a_shell() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config::new(
            temp.path(),
            Platform::current().unwrap(),
            Environment::default(),
            None,
        )
        .unwrap();
        let home = expand_metadata_path(&config, "~/file.json").unwrap();
        assert!(home.is_absolute());
        assert_eq!(home.file_name().unwrap(), "file.json");
        assert!(expand_metadata_path(&config, "~bilikara-no-such-fixture-user/file.json").is_err());
    }
}
