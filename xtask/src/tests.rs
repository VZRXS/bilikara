use crate::{
    compliance,
    config::{Config, Environment, Os, Platform},
    files, libav, macos, release, tools,
};
use serde_json::json;
use std::{ffi::OsString, fs, path::Path, process::Command};

fn config(root: &Path, values: &[(&str, &str)]) -> Config {
    let env = Environment(
        values
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect(),
    );
    Config::new(root, Platform::new("linux", "x86_64").unwrap(), env, None).unwrap()
}

#[test]
fn environment_preserves_native_variable_name_case_rules() {
    let env = Environment(
        [
            ("Path".into(), "native 工具 path".into()),
            ("PathExt".into(), ".EXE;.COM".into()),
        ]
        .into(),
    );
    assert_eq!(env.text("Path"), "native 工具 path");
    if cfg!(windows) {
        assert_eq!(env.text("PATH"), "native 工具 path");
        assert_eq!(env.text("path"), "native 工具 path");
        assert_eq!(env.text("PATHEXT"), ".EXE;.COM");
    } else {
        assert!(env.get("PATH").is_none());
        assert!(env.get("path").is_none());
        assert!(env.get("PATHEXT").is_none());
    }
    let current = Environment::current();
    assert_eq!(current.get("PATH"), std::env::var_os("PATH").as_deref());
    assert_eq!(
        current.get("PATHEXT"),
        std::env::var_os("PATHEXT").as_deref()
    );
}

#[test]
fn target_profile_precedence_and_mobile_decisions() {
    for os in ["windows", "macos", "linux"] {
        for arch in ["AMD64", "x86_64", "arm64", "aarch64"] {
            let platform = Platform::new(os, arch).unwrap();
            let native = platform.target();
            let env =
                Environment([("TAURI_ENV_TARGET_TRIPLE".into(), native.clone().into())].into());
            let c = Config::new(Path::new("."), platform, env.clone(), None).unwrap();
            assert!(c.target.is_none());
            assert_eq!(
                Config::new(Path::new("."), platform, env, Some(native.clone().into()))
                    .unwrap()
                    .target,
                Some(native.into())
            );
            let env = Environment([("CARGO_BUILD_TARGET".into(), "foreign".into())].into());
            assert!(Config::new(Path::new("."), platform, env.clone(), None).is_err());
            assert!(
                Config::new(
                    Path::new("."),
                    platform,
                    env,
                    Some(platform.target().into())
                )
                .is_ok()
            );
        }
    }
    for value in ["true", "1", "FALSE", " false", "", "false", "0"] {
        assert_eq!(
            config(Path::new("."), &[("TAURI_ENV_DEBUG", value)]).profile(),
            if matches!(value, "false" | "0") {
                "release"
            } else {
                "debug"
            }
        );
    }
    for platform in ["android", "ios", "linux", "Android"] {
        assert_eq!(
            config(Path::new("."), &[("TAURI_ENV_PLATFORM", platform)])
                .env
                .mobile(),
            matches!(platform, "android" | "ios")
        );
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn version_provenance_never_uses_crate_or_package_numeric_version() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let c = config(root, &[]);
    assert_eq!(c.version().unwrap(), "dev-gunknown");
    git(root, &["init", "-q", "-b", "work/v0.8.0"]);
    fs::write(root.join("package.json"), "{\"version\":\"9.9.9\"}").unwrap();
    git(root, &["add", "package.json"]);
    git(
        root,
        &[
            "-c",
            "user.name=Build test",
            "-c",
            "user.email=build@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    let commit = git(root, &["rev-parse", "HEAD"]);
    let branch = format!("work/v0.8.0-g{}", &commit[..12]);
    git(root, &["tag", "v0.8.0-preview.2"]);
    assert_eq!(c.version().unwrap(), branch);
    git(root, &["checkout", "-q", "--detach", "HEAD"]);
    assert_eq!(c.version().unwrap(), "v0.8.0-preview.2");
    assert_eq!(
        config(
            root,
            &[
                ("GITHUB_REF_TYPE", "branch"),
                ("GITHUB_REF_NAME", "work/v0.8.0")
            ]
        )
        .version()
        .unwrap(),
        branch
    );
    assert_eq!(
        config(
            root,
            &[("GITHUB_REF_TYPE", "tag"), ("GITHUB_REF_NAME", "v9.9.9")]
        )
        .version()
        .unwrap(),
        format!("v9.9.9-g{}", &commit[..12])
    );
    fs::write(root.join("untracked"), "changed").unwrap();
    assert_eq!(
        c.version().unwrap(),
        format!("v0.8.0-preview.2-g{}-dirty", &commit[..12])
    );
    assert_eq!(
        config(root, &[("BILIKARA_VERSION", "  v0.8.0-preview.3  ")])
            .version()
            .unwrap(),
        "v0.8.0-preview.3"
    );
    assert!(
        config(root, &[("BILIKARA_VERSION", "bad\nversion")])
            .version()
            .is_err()
    );
    let long = "中文 work/".to_owned() + &"x".repeat(100);
    let version = config(
        root,
        &[("GITHUB_REF_TYPE", "branch"), ("GITHUB_HEAD_REF", &long)],
    )
    .version()
    .unwrap();
    assert_eq!(version.len(), 80);
    assert!(version.starts_with("work/"));
    assert!(version.ends_with("-dirty"));
}

#[test]
fn manifest_and_provenance_checks_cover_all_six_target_descriptors() {
    for os in ["windows", "macos", "linux"] {
        for arch in ["x86_64", "aarch64"] {
            let temp = tempfile::tempdir().unwrap();
            let platform = Platform::new(os, arch).unwrap();
            let mut c = config(
                temp.path(),
                &[("BILIKARA_LIBAV_PREFIX", temp.path().to_str().unwrap())],
            );
            c.platform = platform;
            let vendor = temp.path().join("bin");
            fs::create_dir(&vendor).unwrap();
            let dependency = match platform.os {
                Os::Windows => "avcodec-63.dll",
                Os::Macos => "libavcodec.63.dylib",
                Os::Linux => "libavcodec.so.63",
            };
            let manifest = json!({"schema_version":1,"kind":"libav","version":"9.0.1","target":platform.target(),"runtime_files":[platform.companion(),dependency]});
            for name in [platform.companion(), dependency] {
                fs::write(
                    vendor.join(name),
                    "descriptor fixture, not native acceptance",
                )
                .unwrap();
            }
            for name in [
                "source/ffmpeg-9.0.1.tar.xz",
                "licenses/COPYING.LGPLv2.1",
                "build-info.json",
            ] {
                let path = temp.path().join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, "fixture").unwrap();
            }
            let path = vendor.join("ffmpeg-runtime.json");
            files::write_json(&path, &manifest).unwrap();
            assert_eq!(libav::prefix(&c).unwrap().unwrap(), temp.path());
            for (field, value) in [
                ("version", json!("8.1.2")),
                ("schema_version", json!(2)),
                ("target", json!("wrong-arch")),
                (
                    "runtime_files",
                    json!([platform.companion(), dependency, dependency]),
                ),
                (
                    "runtime_files",
                    json!([platform.companion(), dependency, "../outside.dll"]),
                ),
            ] {
                let mut invalid = manifest.clone();
                invalid[field] = value;
                files::write_json(&path, &invalid).unwrap();
                assert!(libav::prefix(&c).is_err());
            }
            files::write_json(&path, &manifest).unwrap();
            fs::remove_file(vendor.join(dependency)).unwrap();
            assert!(libav::prefix(&c).is_err());
            fs::write(vendor.join(dependency), "fixture").unwrap();
            fs::remove_file(temp.path().join("build-info.json")).unwrap();
            assert!(libav::prefix(&c).is_err());
        }
    }
}

#[test]
fn release_tags_and_tracked_dirty_provenance_keep_independent_expected_versions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-q", "-b", "work/v0.8.0"]);
    fs::write(root.join("package.json"), "{\"version\":\"0.8.0\"}\n").unwrap();
    git(root, &["add", "package.json"]);
    git(
        root,
        &[
            "-c",
            "user.name=Build test",
            "-c",
            "user.email=build@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    let commit = git(root, &["rev-parse", "HEAD"]);
    for tag in ["v0.8.0", "v0.8.0-preview.1"] {
        git(root, &["tag", tag]);
        git(root, &["checkout", "-q", "--detach", "HEAD"]);
        let c = config(
            root,
            &[("GITHUB_REF_TYPE", "tag"), ("GITHUB_REF_NAME", tag)],
        );
        assert_eq!(c.version().unwrap(), tag);
        git(root, &["tag", "-d", tag]);
    }
    git(root, &["tag", "v0.8.0"]);
    let c = config(root, &[]);
    assert_eq!(c.version().unwrap(), "v0.8.0");
    fs::write(root.join("package.json"), "{\"version\":\"0.8.1\"}\n").unwrap();
    let expected = format!("v0.8.0-g{}-dirty", &commit[..12]);
    assert_eq!(c.version().unwrap(), expected);
    git(root, &["add", "package.json"]);
    assert_eq!(c.version().unwrap(), expected);
    assert_eq!(
        config(
            root,
            &[("GITHUB_REF_TYPE", "tag"), ("GITHUB_REF_NAME", "v0.8.0")]
        )
        .version()
        .unwrap(),
        expected
    );
}

#[test]
fn actual_binary_inspection_rejects_mislabeled_architecture() {
    let platform = Platform::current().unwrap();
    let executable = std::env::current_exe().unwrap();
    assert!(libav::binary_imports(&executable, platform).is_ok());
    assert!(
        libav::binary_imports(
            &executable,
            Platform {
                arm: !platform.arm,
                ..platform
            }
        )
        .is_err()
    );
}

#[test]
fn pe_inspection_includes_delayed_imports_without_running_foreign_code() {
    // Minimal PE64 descriptor fixture. Parsing it is not Windows execution.
    let mut bytes = vec![0u8; 0x600];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    bytes[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes());
    bytes[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
    bytes[0x94..0x96].copy_from_slice(&0xf0u16.to_le_bytes());
    bytes[0x98..0x9a].copy_from_slice(&0x20bu16.to_le_bytes());
    bytes[0x104..0x108].copy_from_slice(&16u32.to_le_bytes());
    for (index, rva, size) in [(1, 0x1000u32, 40u32), (13, 0x1040, 64)] {
        let offset = 0x108 + index * 8;
        bytes[offset..offset + 4].copy_from_slice(&rva.to_le_bytes());
        bytes[offset + 4..offset + 8].copy_from_slice(&size.to_le_bytes());
    }
    for (offset, value) in [
        (0x190, 0x400u32),
        (0x194, 0x1000),
        (0x198, 0x400),
        (0x19c, 0x200),
        (0x20c, 0x1100),
        (0x240, 1),
        (0x244, 0x1120),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[0x300..0x30d].copy_from_slice(b"KERNEL32.dll\0");
    bytes[0x320..0x32f].copy_from_slice(b"AVCODEC-63.dll\0");
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host.exe");
    fs::write(&path, bytes).unwrap();
    let platform = Platform::new("windows", "x86_64").unwrap();
    assert_eq!(
        libav::binary_imports(&path, platform).unwrap(),
        ["kernel32.dll", "avcodec-63.dll"]
    );
    assert!(
        libav::binary_imports(
            &path,
            Platform {
                arm: true,
                ..platform
            }
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn prefix_links_cannot_escape_the_declared_flat_closure() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let c = config(
        temp.path(),
        &[("BILIKARA_LIBAV_PREFIX", temp.path().to_str().unwrap())],
    );
    fs::create_dir(temp.path().join("bin")).unwrap();
    fs::write(temp.path().join("outside"), "outside").unwrap();
    fs::write(
        temp.path().join("bin/libbilikara_media_libav.so"),
        "companion",
    )
    .unwrap();
    symlink("../outside", temp.path().join("bin/libavcodec.so.63")).unwrap();
    files::write_json(&temp.path().join("bin/ffmpeg-runtime.json"), &json!({"schema_version":1,"kind":"libav","version":"9.0.1","target":"x86_64-unknown-linux-gnu","runtime_files":["libbilikara_media_libav.so","libavcodec.so.63"]})).unwrap();
    assert!(
        libav::prefix(&c)
            .unwrap_err()
            .to_string()
            .contains("dependency is missing")
    );
}

#[test]
fn committed_macos_metadata_is_validated_for_both_architectures() {
    for arch in ["x86_64", "aarch64"] {
        let temp = tempfile::tempdir().unwrap();
        let mut c = config(temp.path(), &[]);
        c.platform = Platform::new("macos", arch).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(format!("tools/aria2/macos-{}.json", c.platform.arch()));
        let relative = format!("tools/aria2/macos-{}.json", c.platform.arch());
        files::copy(&source, &temp.path().join(&relative)).unwrap();
        let vendor = temp.path().join("vendor");
        tools::aria2_metadata(&c, &vendor).unwrap();
        assert_eq!(
            fs::read(&source).unwrap(),
            fs::read(vendor.join("aria2-macos.json")).unwrap()
        );
        let mut data: serde_json::Value =
            serde_json::from_slice(&fs::read(source).unwrap()).unwrap();
        for (key, value) in [
            ("arch", "foreign"),
            ("sha256", "bad"),
            ("url", "https://evil.invalid/a.tar.gz"),
            ("recipe_revision", "../escape"),
            ("source_sha256", "changed"),
            ("version", "1.37.1"),
            ("source_url", "https://evil.invalid/source.tar.xz"),
        ] {
            let original = data[key].clone();
            data[key] = json!(value);
            files::write_json(&temp.path().join(&relative), &data).unwrap();
            assert!(tools::aria2_metadata(&c, &vendor).is_err());
            data[key] = original;
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_bbdown_shims_require_the_selected_real_tool_and_preserve_alias_paths() {
    for package_manager in ["chocolatey", "scoop"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tool 空 installation");
        let shims = root
            .join(package_manager)
            .join(if package_manager == "scoop" {
                "shims"
            } else {
                "bin"
            });
        fs::create_dir_all(&shims).unwrap();
        fs::write(shims.join("BBDown.exe"), b"shim").unwrap();
        let mut c = config(
            temp.path(),
            &[("PATH", shims.to_str().unwrap()), ("PATHEXT", ".EXE")],
        );
        c.platform = Platform::new("windows", "x86_64").unwrap();
        assert!(tools::bbdown_path(&c).unwrap().is_none());
        let executable = root
            .join(package_manager)
            .join(if package_manager == "scoop" {
                "apps/BBDown/current/bin/BBDown.exe"
            } else {
                "lib/BBDown/tools/bin/BBDown.exe"
            });
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"selected native tool fixture").unwrap();
        assert_eq!(tools::bbdown_path(&c).unwrap().unwrap(), executable);
    }
}

#[cfg(unix)]
#[test]
fn copy_preserves_link_content_and_modes_without_truncating_same_files() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::write(&source, b"executable content").unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o751)).unwrap();
    let link = temp.path().join("relative-link");
    symlink("source", &link).unwrap();
    let destination = temp.path().join("copy");
    files::copy(&link, &destination).unwrap();
    assert!(!destination.is_symlink());
    assert_eq!(fs::read(&destination).unwrap(), fs::read(&source).unwrap());
    assert_eq!(
        fs::metadata(destination).unwrap().permissions().mode() & 0o777,
        0o751
    );
    assert!(files::copy(&source, &link).is_err());
    let hardlink = temp.path().join("hardlink");
    fs::hard_link(&source, &hardlink).unwrap();
    assert!(files::copy(&source, &hardlink).is_err());
    assert_eq!(fs::read(source).unwrap(), b"executable content");
}

#[test]
fn release_cleanup_is_scoped_and_preserves_data_and_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let c = config(temp.path(), &[]);
    for path in [
        ".",
        "target",
        "src-tauri/target",
        ".tmp",
        "runtime",
        "dist/../../outside",
    ] {
        assert!(
            release::dist_directory(&c, Some(Path::new(path))).is_err(),
            "{path}"
        );
    }
    let dist = release::dist_directory(&c, Some(Path::new(".tmp/release 空 $()"))).unwrap();
    fs::create_dir_all(dist.join("bilikara/runtime/data")).unwrap();
    let data = dist.join("bilikara/runtime/data/sentinel");
    fs::write(&data, b"user records").unwrap();
    assert!(release::clean_product(&c, &dist, "bilikara", &[]).is_err());
    assert_eq!(fs::read(&data).unwrap(), b"user records");
    fs::remove_dir_all(dist.join("bilikara/runtime")).unwrap();
    let input = dist.join("bilikara/input");
    fs::write(&input, b"prepared input").unwrap();
    assert!(release::clean_product(&c, &dist, "bilikara", &[&input]).is_err());
    assert_eq!(fs::read(&input).unwrap(), b"prepared input");
    fs::write(dist.join("unrelated"), b"keep").unwrap();
    assert!(release::clean_product(&c, &dist, "target", &[]).is_err());
    release::clean_product(&c, &dist, "bilikara", &[]).unwrap();
    assert!(!input.exists());
    assert_eq!(fs::read(dist.join("unrelated")).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn release_output_and_product_symlinks_are_rejected_before_cleanup() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let c = config(temp.path(), &[]);
    let installed = temp.path().join("installed application");
    fs::create_dir_all(&installed).unwrap();
    fs::write(installed.join("sentinel"), b"installed").unwrap();
    symlink(&installed, temp.path().join("dist")).unwrap();
    assert!(release::dist_directory(&c, None).is_err());
    let dist = temp.path().join(".tmp/generated");
    fs::create_dir_all(&dist).unwrap();
    symlink(&installed, dist.join("bilikara")).unwrap();
    assert!(release::clean_product(&c, &dist, "bilikara", &[]).is_err());
    assert_eq!(fs::read(installed.join("sentinel")).unwrap(), b"installed");
    // A trusted checkout may have a system/link ancestor (macOS /var, /tmp).
    let real = temp.path().join("real checkout");
    fs::create_dir(&real).unwrap();
    let alias = temp.path().join("checkout alias");
    symlink(&real, &alias).unwrap();
    let c = config(&alias, &[]);
    let dist = release::dist_directory(&c, None).unwrap();
    release::clean_product(&c, &dist, "bilikara", &[]).unwrap();
    assert!(real.join("dist").is_dir());
}

#[test]
fn release_compliance_enforces_configured_source_digest_and_license() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("exact source 空.tar.xz");
    fs::write(&archive, b"abc").unwrap();
    let license = temp.path().join("third_party/BBDown-LICENSE.txt");
    fs::create_dir_all(license.parent().unwrap()).unwrap();
    fs::write(&license, b"MIT").unwrap();
    let loudness_license = temp.path().join("third_party/ebur128-LICENSE.txt");
    fs::write(&loudness_license, b"MIT").unwrap();
    let mut c = config(
        temp.path(),
        &[
            ("BILIKARA_FFMPEG_SOURCE_ARCHIVE", archive.to_str().unwrap()),
            (
                "BILIKARA_FFMPEG_SOURCE_SHA256",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ],
    );
    assert_eq!(
        compliance::input_files(&c).unwrap(),
        [license.clone(), loudness_license, archive.clone()]
    );
    c.env.0.insert(
        "BILIKARA_FFMPEG_SOURCE_SHA256".into(),
        "0".repeat(64).into(),
    );
    assert!(
        compliance::input_files(&c)
            .unwrap_err()
            .to_string()
            .contains("SHA-256 mismatch")
    );
    c.env
        .0
        .remove(std::ffi::OsStr::new("BILIKARA_FFMPEG_SOURCE_SHA256"));
    fs::remove_file(archive).unwrap();
    assert!(
        compliance::input_files(&c)
            .unwrap_err()
            .to_string()
            .contains("source archive not found")
    );
    c.env
        .0
        .remove(std::ffi::OsStr::new("BILIKARA_FFMPEG_SOURCE_ARCHIVE"));
    fs::remove_file(license).unwrap();
    assert!(
        compliance::input_files(&c)
            .unwrap_err()
            .to_string()
            .contains("BBDown license file not found")
    );
}

#[test]
fn final_layout_and_plist_preserve_platform_resource_roles_and_numeric_version() {
    let temp = tempfile::tempdir().unwrap();
    let c = config(temp.path(), &[]);
    fs::write(temp.path().join("package.json"), r#"{"version":"0.8.0"}"#).unwrap();
    let app = temp.path().join("bilikara.app");
    fs::create_dir_all(app.join("Contents")).unwrap();
    let layout = files::Layout::new(&app, true);
    assert_eq!(layout.code, app.join("Contents/MacOS"));
    assert_eq!(layout.vendor, app.join("Contents/Frameworks"));
    assert_eq!(layout.docs, app.join("Contents/Resources/license"));
    for (label, numeric) in [
        ("work/v0.8.0-gabcdef-dirty", "0.8.0"),
        ("v7.6.5-preview.99", "7.6.5"),
        ("v999999.1.2", "65535.1.2"),
    ] {
        macos::write_backend_plist(&c, &app, label).unwrap();
        let plist = fs::read_to_string(app.join("Contents/Info.plist")).unwrap();
        assert_eq!(
            plist
                .matches(&format!("<string>{numeric}</string>"))
                .count(),
            2
        );
        assert!(plist.contains("<key>LSUIElement</key>\n\t<true/>"));
        assert!(plist.contains("com.bilikara.backend"));
    }
    let development = files::Layout::new(&app, false);
    assert_eq!(development.vendor, app.join("_internal/vendor"));
    assert_eq!(development.code, app.join("_internal"));
}
