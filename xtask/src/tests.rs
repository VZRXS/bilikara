use crate::{
    config::{Config, Environment, Os, Platform},
    files, libav, tools,
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
        ] {
            let original = data[key].clone();
            data[key] = json!(value);
            files::write_json(&temp.path().join(&relative), &data).unwrap();
            assert!(tools::aria2_metadata(&c, &vendor).is_err());
            data[key] = original;
        }
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
