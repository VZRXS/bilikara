//! Final native macOS bundle orchestration. Platform tools retain responsibility
//! for Mach-O metadata, link-preserving copies and code signatures.
use crate::{Result, config::Config, libav};
use regex::Regex;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

pub fn write_backend_plist(config: &Config, app: &Path, version: &str) -> Result<()> {
    let release = Regex::new(r"(?i)^v?\d+\.\d+\.\d+(?:-preview\.\d+)?$")?;
    let package = if release.is_match(version) {
        version.into()
    } else {
        fs::read(config.root.join("package.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
            .and_then(|data| data["version"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "0.0.0".into())
    };
    let digits = Regex::new(r"\d+")?;
    let mut parts: Vec<_> = digits
        .find_iter(&package)
        .take(3)
        .map(|p| {
            p.as_str()
                .parse::<u64>()
                .unwrap_or(u64::MAX)
                .min(65535)
                .to_string()
        })
        .collect();
    parts.resize(3, "0".into());
    let numeric = parts.join(".");
    fs::write(
        app.join("Contents/Info.plist"),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n\
\t<key>CFBundleExecutable</key>\n\t<string>bilikara-desktop-host</string>\n\
\t<key>CFBundleIdentifier</key>\n\t<string>com.bilikara.backend</string>\n\
\t<key>CFBundleName</key>\n\t<string>bilikara backend</string>\n\
\t<key>CFBundlePackageType</key>\n\t<string>APPL</string>\n\
\t<key>CFBundleShortVersionString</key>\n\t<string>{numeric}</string>\n\
\t<key>CFBundleVersion</key>\n\t<string>{numeric}</string>\n\
\t<key>LSUIElement</key>\n\t<true/>\n</dict>\n</plist>\n"
        ),
    )?;
    Ok(())
}

type ToolRunner<'a> = dyn FnMut(&str, &[&std::ffi::OsStr]) -> Result<String> + 'a;

fn run(name: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    let output = Command::new(Path::new("/usr/bin").join(name))
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "{name} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

pub fn copy_app(source: &Path, destination: &Path) -> Result<()> {
    run("ditto", &[source.as_os_str(), destination.as_os_str()])?;
    Ok(())
}
fn verify(app: &Path, runner: &mut ToolRunner<'_>) -> Result<()> {
    runner(
        "codesign",
        &[
            "--verify".as_ref(),
            "--deep".as_ref(),
            "--strict".as_ref(),
            "--verbose=4".as_ref(),
            app.as_os_str(),
        ],
    )?;
    Ok(())
}
fn sign(path: &Path, preserve: bool, runner: &mut ToolRunner<'_>) -> Result<()> {
    let mut args: Vec<&std::ffi::OsStr> = vec![
        "--force".as_ref(),
        "--sign".as_ref(),
        "-".as_ref(),
        "--timestamp=none".as_ref(),
    ];
    if preserve {
        args.push("--preserve-metadata=identifier,entitlements,requirements,flags".as_ref());
    }
    args.push(path.as_os_str());
    runner("codesign", &args)?;
    Ok(())
}
fn require_app(app: &Path, name: &str) -> Result<PathBuf> {
    if !app.join("Contents/Info.plist").is_file() {
        return Err(format!("macOS application is missing Info.plist: {}", app.display()).into());
    }
    let executable = app.join("Contents/MacOS").join(name);
    if !executable.is_file() {
        return Err(format!(
            "macOS application is missing its executable: {}",
            executable.display()
        )
        .into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&executable)?.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "macOS application executable is not executable: {}",
                executable.display()
            )
            .into());
        }
    }
    Ok(executable)
}
fn architectures(executable: &Path, runner: &mut ToolRunner<'_>) -> Result<BTreeSet<String>> {
    let value = runner("lipo", &["-archs".as_ref(), executable.as_os_str()])?;
    let result: BTreeSet<_> = value.split_whitespace().map(str::to_owned).collect();
    if result.is_empty() {
        return Err("Could not determine Mach-O architecture".into());
    }
    Ok(result)
}
fn nested_code(directory: &Path, main: &Path, objects: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            nested_code(&path, main, objects)?;
        } else if path != main && path.is_file() {
            let mut magic = [0; 4];
            if fs::File::open(&path)?.read_exact(&mut magic).is_ok()
                && matches!(
                    &magic,
                    b"\xcf\xfa\xed\xfe"
                        | b"\xfe\xed\xfa\xcf"
                        | b"\xce\xfa\xed\xfe"
                        | b"\xfe\xed\xfa\xce"
                        | b"\xca\xfe\xba\xbe"
                        | b"\xbe\xba\xfe\xca"
                )
            {
                objects.push(path);
            }
        }
    }
    Ok(())
}
pub fn finalize_backend(config: &Config, app: &Path) -> Result<()> {
    finalize_with(app, &mut run, &mut |path| {
        libav::binary_imports(path, config.platform).map(|_| ())
    })
}

fn finalize_with(
    app: &Path,
    runner: &mut ToolRunner<'_>,
    inspect: &mut dyn FnMut(&Path) -> Result<()>,
) -> Result<()> {
    let main = require_app(app, "bilikara-desktop-host")?;
    runner(
        "plutil",
        &[
            "-lint".as_ref(),
            app.join("Contents/Info.plist").as_os_str(),
        ],
    )?;
    let mut objects = Vec::new();
    nested_code(&app.join("Contents"), &main, &mut objects)?;
    objects.sort();
    // Inspect every actual code object, including Host/updater/BBDown, before
    // signing helpers and libraries, then sealing the backend envelope.
    for object in std::iter::once(&main).chain(objects.iter()) {
        inspect(object)?;
    }
    for object in objects {
        sign(&object, false, runner)?;
    }
    sign(app, false, runner)?;
    verify(app, runner)?;
    runner(
        "codesign",
        &["-dv".as_ref(), "--verbose=4".as_ref(), app.as_os_str()],
    )?;
    Ok(())
}

pub fn embed_backend(backend: &Path, desktop: &Path) -> Result<PathBuf> {
    embed_with(backend, desktop, &mut run)
}

fn embed_with(backend: &Path, desktop: &Path, runner: &mut ToolRunner<'_>) -> Result<PathBuf> {
    let backend_executable = require_app(backend, "bilikara-desktop-host")?;
    let desktop_executable = require_app(desktop, "bilikara")?;
    verify(backend, runner)?;
    verify(desktop, runner)?;
    let backend_arch = architectures(&backend_executable, runner)?;
    if !architectures(&desktop_executable, runner)?.is_subset(&backend_arch) {
        return Err("Embedded backend architecture does not match the Desktop application".into());
    }
    let destination = desktop.join("Contents/Frameworks/bilikara-backend.app");
    for parent in destination.ancestors().take_while(|path| *path != desktop) {
        if parent.is_symlink() {
            return Err("embedded backend destination is a symlink".into());
        }
    }
    // desktop is a newly copied generated tree; installed apps cannot reach here.
    if destination.exists() || destination.is_symlink() {
        if destination.is_symlink() {
            return Err("embedded backend destination is a symlink".into());
        }
        fs::remove_dir_all(&destination)?;
    }
    fs::create_dir_all(destination.parent().unwrap())?;
    runner("ditto", &[backend.as_os_str(), destination.as_os_str()])?;
    let embedded = require_app(&destination, "bilikara-desktop-host")?;
    if architectures(&embedded, runner)? != backend_arch {
        return Err("Embedded backend architecture changed while copying the bundle".into());
    }
    sign(&destination, true, runner)?;
    verify(&destination, runner)?;
    sign(desktop, true, runner)?;
    verify(desktop, runner)?;
    // No writes into either bundle after its final seal.
    Ok(embedded)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn app(root: &Path, name: &str) {
        fs::create_dir_all(root.join("Contents/MacOS")).unwrap();
        fs::write(root.join("Contents/Info.plist"), "plist fixture").unwrap();
        let code = root.join("Contents/MacOS").join(name);
        fs::write(&code, b"\xcf\xfa\xed\xfecode fixture").unwrap();
        fs::set_permissions(code, fs::Permissions::from_mode(0o751)).unwrap();
    }

    // Only a foreign-platform command-sequence double. Production uses ditto.
    fn copy_links(source: &Path, destination: &Path) -> Result<()> {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let from = entry.path();
            let to = destination.join(entry.file_name());
            if from.is_symlink() {
                symlink(fs::read_link(from)?, to)?;
            } else if from.is_dir() {
                copy_links(&from, &to)?;
            } else {
                fs::copy(from, to)?;
            }
        }
        fs::set_permissions(destination, fs::metadata(source)?.permissions())?;
        Ok(())
    }

    #[test]
    fn backend_signs_all_nested_code_before_envelope_and_strict_verification() {
        let temp = tempfile::tempdir().unwrap();
        let backend = temp.path().join("backend 空 $().app");
        app(&backend, "bilikara-desktop-host");
        for name in [
            "Contents/MacOS/bilikara-updater",
            "Contents/Frameworks/BBDown",
            "Contents/Frameworks/libavcodec.63.dylib",
        ] {
            let path = backend.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"\xcf\xfa\xed\xfefixture").unwrap();
        }
        fs::create_dir_all(backend.join("Contents/Resources/vendor")).unwrap();
        symlink(
            "../../Frameworks/BBDown",
            backend.join("Contents/Resources/vendor/BBDown"),
        )
        .unwrap();
        let mut calls = Vec::new();
        let mut inspected = Vec::new();
        finalize_with(
            &backend,
            &mut |name, args| {
                calls.push((
                    name.to_owned(),
                    args.iter().map(|a| a.to_os_string()).collect::<Vec<_>>(),
                ));
                Ok(String::new())
            },
            &mut |path| {
                inspected.push(path.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(inspected.len(), 4);
        assert_eq!(calls[0].0, "plutil");
        let signs: Vec<_> = calls
            .iter()
            .filter(|(n, a)| n == "codesign" && a[0] == "--force")
            .collect();
        assert_eq!(signs.len(), 4);
        assert_eq!(signs.last().unwrap().1.last().unwrap(), backend.as_os_str());
        for (_, args) in signs {
            assert_eq!(
                &args[..4],
                ["--force", "--sign", "-", "--timestamp=none"].map(std::ffi::OsString::from)
            );
            assert!(
                !args
                    .iter()
                    .any(|a| a.to_string_lossy().contains("preserve-metadata"))
            );
        }
        assert_eq!(calls[calls.len() - 2].1[0], "--verify");
        assert_eq!(calls.last().unwrap().1[0], "-dv");
        let mut signed = false;
        let failure = finalize_with(
            &backend,
            &mut |name, args| {
                signed |= name == "codesign" && args[0] == "--force";
                Ok(String::new())
            },
            &mut |_| Err("Non-native Mach-O fixture".into()),
        );
        assert!(failure.is_err());
        assert!(!signed);
    }

    #[test]
    fn finalization_rejects_missing_plist_executable_modes_and_platform_tool_failures() {
        for missing in ["plist", "executable", "mode"] {
            let temp = tempfile::tempdir().unwrap();
            let backend = temp.path().join("backend.app");
            app(&backend, "bilikara-desktop-host");
            match missing {
                "plist" => fs::remove_file(backend.join("Contents/Info.plist")).unwrap(),
                "executable" => {
                    fs::remove_file(backend.join("Contents/MacOS/bilikara-desktop-host")).unwrap()
                }
                _ => fs::set_permissions(
                    backend.join("Contents/MacOS/bilikara-desktop-host"),
                    fs::Permissions::from_mode(0o644),
                )
                .unwrap(),
            }
            let mut invoked = false;
            assert!(
                finalize_with(
                    &backend,
                    &mut |_, _| {
                        invoked = true;
                        Ok(String::new())
                    },
                    &mut |_| Ok(())
                )
                .is_err()
            );
            assert!(!invoked, "{missing}");
        }
        for failure in ["plutil", "sign", "verify"] {
            let temp = tempfile::tempdir().unwrap();
            let backend = temp.path().join("backend.app");
            app(&backend, "bilikara-desktop-host");
            let mut calls = Vec::new();
            let result = finalize_with(
                &backend,
                &mut |name, args| {
                    calls.push((name.to_owned(), args[0].to_owned()));
                    if (failure == "plutil" && name == "plutil")
                        || (failure == "sign" && args[0] == "--force")
                        || (failure == "verify" && args[0] == "--verify")
                    {
                        Err(format!("{failure} fixture failure").into())
                    } else {
                        Ok(String::new())
                    }
                },
                &mut |_| Ok(()),
            );
            assert!(result.unwrap_err().to_string().contains(failure));
            assert_eq!(
                calls.last().unwrap().1,
                match failure {
                    "plutil" => "-lint",
                    "sign" => "--force",
                    _ => "--verify",
                }
            );
        }
    }

    #[test]
    fn embedding_keeps_links_modes_and_preserves_signature_metadata_in_seal_order() {
        let temp = tempfile::tempdir().unwrap();
        let backend = temp.path().join("bilikara.app");
        let desktop = temp.path().join("bilikara-desktop 空 $().app");
        app(&backend, "bilikara-desktop-host");
        app(&desktop, "bilikara");
        fs::create_dir_all(backend.join("Contents/Frameworks")).unwrap();
        fs::create_dir_all(backend.join("Contents/Resources/vendor")).unwrap();
        fs::write(backend.join("Contents/Frameworks/BBDown"), b"code fixture").unwrap();
        symlink(
            "../../Frameworks/BBDown",
            backend.join("Contents/Resources/vendor/BBDown"),
        )
        .unwrap();
        let mut calls = Vec::new();
        let embedded = embed_with(&backend, &desktop, &mut |name, args| {
            calls.push((
                name.to_owned(),
                args.iter().map(|a| a.to_os_string()).collect::<Vec<_>>(),
            ));
            if name == "ditto" {
                copy_links(Path::new(args[0]), Path::new(args[1]))?;
            }
            Ok(if name == "lipo" {
                "arm64\n".into()
            } else {
                String::new()
            })
        })
        .unwrap();
        assert_eq!(
            embedded,
            desktop.join(
                "Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host"
            )
        );
        assert_eq!(
            fs::metadata(&embedded).unwrap().permissions().mode() & 0o777,
            0o751
        );
        let link = desktop
            .join("Contents/Frameworks/bilikara-backend.app/Contents/Resources/vendor/BBDown");
        assert_eq!(
            fs::read_link(link).unwrap(),
            Path::new("../../Frameworks/BBDown")
        );
        assert_eq!(
            calls
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            [
                "codesign", "codesign", "lipo", "lipo", "ditto", "lipo", "codesign", "codesign",
                "codesign", "codesign"
            ]
        );
        for index in [0, 1, 7, 9] {
            assert_eq!(
                &calls[index].1[..4],
                ["--verify", "--deep", "--strict", "--verbose=4"].map(std::ffi::OsString::from)
            );
        }
        for index in [6, 8] {
            assert_eq!(
                &calls[index].1[..5],
                [
                    "--force",
                    "--sign",
                    "-",
                    "--timestamp=none",
                    "--preserve-metadata=identifier,entitlements,requirements,flags"
                ]
                .map(std::ffi::OsString::from)
            );
        }
        assert_eq!(
            calls[6].1.last().unwrap(),
            desktop
                .join("Contents/Frameworks/bilikara-backend.app")
                .as_os_str()
        );
        assert_eq!(calls[8].1.last().unwrap(), desktop.as_os_str());
    }

    #[test]
    fn embedding_rejects_signature_architecture_and_copy_changes_before_sealing() {
        for failure in ["signature", "architecture", "copy"] {
            let temp = tempfile::tempdir().unwrap();
            let backend = temp.path().join("backend.app");
            let desktop = temp.path().join("desktop.app");
            app(&backend, "bilikara-desktop-host");
            app(&desktop, "bilikara");
            let mut sealed = false;
            let result = embed_with(&backend, &desktop, &mut |name, args| {
                if name == "codesign" {
                    sealed |= args[0] == "--force";
                    if failure == "signature" {
                        return Err("Strict codesign verification failed".into());
                    }
                }
                if name == "ditto" {
                    copy_links(Path::new(args[0]), Path::new(args[1]))?;
                }
                let mismatch = (failure == "architecture"
                    && Path::new(args.last().unwrap()) == desktop.join("Contents/MacOS/bilikara"))
                    || (failure == "copy"
                        && Path::new(args.last().unwrap())
                            .starts_with(desktop.join("Contents/Frameworks")));
                Ok(if name != "lipo" {
                    String::new()
                } else if mismatch {
                    "x86_64\n".into()
                } else {
                    "arm64\n".into()
                })
            });
            assert!(result.is_err(), "{failure}");
            assert!(!sealed, "{failure}");
        }
    }

    #[test]
    fn embedding_does_not_write_through_framework_directory_links() {
        let temp = tempfile::tempdir().unwrap();
        let backend = temp.path().join("backend.app");
        let desktop = temp.path().join("desktop.app");
        let external = temp.path().join("external/bilikara-backend.app");
        app(&backend, "bilikara-desktop-host");
        app(&desktop, "bilikara");
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("sentinel"), b"preserve").unwrap();
        symlink(
            external.parent().unwrap(),
            desktop.join("Contents/Frameworks"),
        )
        .unwrap();
        let error = embed_with(&backend, &desktop, &mut |name, args| {
            assert_ne!(name, "ditto");
            assert_ne!(args[0], "--force");
            Ok(if name == "lipo" {
                "arm64\n".into()
            } else {
                String::new()
            })
        })
        .unwrap_err();
        assert!(error.to_string().contains("destination is a symlink"));
        assert_eq!(fs::read(external.join("sentinel")).unwrap(), b"preserve");
    }
}
