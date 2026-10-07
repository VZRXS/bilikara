//! Foreign command/PE fixtures are separate from real platform qualification.
use crate::{
    config::{Config, Environment, Os, Platform},
    files, libav_cache as cache, libav_prepare as prepare,
};
use serde_json::{Value, json};
use std::{ffi::OsString, fs, path::Path};

fn config(root: &Path, os: &str, arch: &str) -> Config {
    Config {
        root: root.into(),
        platform: Platform::new(os, arch).unwrap(),
        env: Environment::default(),
        target: None,
        development: false,
    }
}

#[test]
fn upstream_key_is_recipe_toolchain_scoped_not_application_scoped() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("media-libav")).unwrap();
    fs::create_dir(root.path().join("xtask")).unwrap();
    fs::write(
        root.path().join("media-libav/build-posix-libraries.sh"),
        "9.0.1 disable-network signer",
    )
    .unwrap();
    let platform = Platform::new("linux", "x86_64").unwrap();
    // Only the compiler probe is injected; recipe selection and environment
    // filtering are the same implementation used by the production command.
    let mut environment = Environment::default();
    environment.0.insert("CC".into(), "selected-cc".into());
    environment.0.insert(
        "BILIKARA_LIBAV_PREFIX".into(),
        "/private prefix 中文".into(),
    );
    let compiler = vec!["selected C compiler / SDK".to_owned()];
    let original =
        cache::key_with_compiler(root.path(), platform, &environment, &compiler).unwrap();
    for name in [
        "xtask/Cargo.lock",
        "xtask/src/unrelated.rs",
        "media-libav/probe.c",
        "rust-runtime/src/lib.rs",
        "rust-runtime/src/bin/bilikara-updater.rs",
        "static/host.js",
    ] {
        fs::create_dir_all(root.path().join(name).parent().unwrap()).unwrap();
        fs::write(root.path().join(name), "changed source").unwrap();
        assert_eq!(
            original,
            cache::key_with_compiler(root.path(), platform, &environment, &compiler).unwrap()
        );
    }
    environment
        .0
        .insert("BILIKARA_VERSION".into(), "unrelated-release".into());
    environment
        .0
        .insert("GITHUB_SHA".into(), "application-commit".into());
    assert_eq!(
        original,
        cache::key_with_compiler(root.path(), platform, &environment, &compiler).unwrap()
    );
    fs::write(
        root.path().join("media-libav/build-posix-libraries.sh"),
        "changed recipe",
    )
    .unwrap();
    assert_ne!(
        original,
        cache::key_with_compiler(root.path(), platform, &environment, &compiler).unwrap()
    );
    fs::write(
        root.path().join("media-libav/build-posix-libraries.sh"),
        "9.0.1 disable-network signer",
    )
    .unwrap();
    assert_ne!(
        original,
        cache::key_with_compiler(
            root.path(),
            Platform::new("linux", "aarch64").unwrap(),
            &environment,
            &compiler
        )
        .unwrap()
    );
    assert_ne!(
        original,
        cache::key_with_compiler(
            root.path(),
            Platform::new("macos", "x86_64").unwrap(),
            &environment,
            &compiler
        )
        .unwrap()
    );
    assert_ne!(
        original,
        cache::key_with_compiler(
            root.path(),
            platform,
            &environment,
            &["changed compiler/SDK".into()]
        )
        .unwrap()
    );
    environment.0.insert("CC".into(), "new-cc".into());
    assert_ne!(
        original,
        cache::key_with_compiler(root.path(), platform, &environment, &compiler).unwrap()
    );
    assert_eq!(platform.target(), "x86_64-unknown-linux-gnu");
}

fn cache_fixture(root: &Path) -> Value {
    for (name, bytes) in [
        ("lib/libavcodec.so.63", b"upstream C".as_slice()),
        ("source/ffmpeg-9.0.1.tar.xz", b"verified source"),
        ("records/signature.log", b"signer"),
        ("licenses/COPYING.LGPLv2.1", b"license"),
    ] {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let entries = cache::inventory(root, false).unwrap();
    let data = json!({"schema_version":3,"key":"selected-key","target":"x86_64-unknown-linux-gnu","entries":entries});
    files::write_json(&root.join("cache-manifest.json"), &data).unwrap();
    data
}

#[test]
fn cache_rejects_corruption_target_schema_missing_and_unlisted_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let original = cache_fixture(root);
    assert!(cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu").is_ok());
    for (field, value) in [
        ("key", json!("wrong-toolchain")),
        ("target", json!("aarch64-unknown-linux-gnu")),
        ("schema_version", json!(2)),
        ("entries", json!(null)),
    ] {
        let mut data = original.clone();
        data[field] = value;
        files::write_json(&root.join("cache-manifest.json"), &data).unwrap();
        assert!(cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu").is_err());
    }
    files::write_json(&root.join("cache-manifest.json"), &original).unwrap();
    fs::write(root.join("lib/libavcodec.so.63"), "corrupt").unwrap();
    assert!(cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu").is_err());
    fs::write(root.join("lib/libavcodec.so.63"), "upstream C").unwrap();
    fs::write(root.join("lib/libavformat.so.63"), "unlisted binary").unwrap();
    assert!(cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu").is_err());
    fs::remove_file(root.join("lib/libavformat.so.63")).unwrap();
    fs::remove_file(root.join("source/ffmpeg-9.0.1.tar.xz")).unwrap();
    assert!(cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu").is_err());
}

#[test]
fn cache_rejects_traversal_and_app_objects_even_with_a_manifest_entry() {
    for name in [
        "",
        "../outside",
        "/absolute",
        "\\rooted",
        "\\\\server\\share\\file",
        "//server/share/file",
        "\\\\?\\C:\\device",
        "\\\\.\\device",
        "C:/windows",
        "C:relative",
        "lib/header:stream",
        "lib\\escape",
        "lib/../outside",
        "driver/tests",
        "bin/bilikara-desktop-host.exe",
        "bin/bilikara_media_libav.dll",
        "records/build-info.json",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut data = cache_fixture(root);
        data["entries"][name] = json!({"kind":"file","sha256":"made-up","size":1,"mode":420});
        files::write_json(&root.join("cache-manifest.json"), &data).unwrap();
        assert!(
            cache::validated(root, "selected-key", "x86_64-unknown-linux-gnu")
                .unwrap_err()
                .to_string()
                .contains("Invalid libav cache path"),
            "{name}"
        );
    }
}

#[cfg(unix)]
#[test]
fn cache_links_modes_and_downstream_exclusion_are_enforced() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    cache_fixture(root);
    fs::set_permissions(
        root.join("lib/libavcodec.so.63"),
        fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    symlink("libavcodec.so.63", root.join("lib/libavcodec.so")).unwrap();
    for name in [
        "bin/bilikara_media_libav.dll",
        "bin/test_shim",
        "driver/libav-runtime-tests",
        "records/companion.log",
        "records/runtime-test-build.jsonl",
        "build-info.json",
    ] {
        let file = root.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "application output").unwrap();
    }
    let entries = cache::inventory(root, true).unwrap();
    assert_eq!(entries["lib/libavcodec.so"]["target"], "libavcodec.so.63");
    assert_eq!(entries["lib/libavcodec.so.63"]["mode"], 0o751);
    assert!(!entries.keys().any(|name| name.contains("bilikara")
        || name.starts_with("driver")
        || name.contains("build-info")));
    fs::remove_file(root.join("lib/libavcodec.so")).unwrap();
    symlink("/etc/passwd", root.join("lib/libavcodec.so")).unwrap();
    assert!(cache::inventory(root, true).is_err());
}

#[test]
fn path_checks_protect_sources_user_data_and_overlapping_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("checkout")).unwrap();
    let checkout = root.join("checkout");
    assert!(prepare::check_prefix(&checkout, root).is_err());
    assert!(prepare::check_prefix(&checkout, &checkout).is_err());
    assert!(prepare::disjoint(&root.join("prefix"), &root.join("prefix/cache")).is_err());
    assert!(prepare::absolute(&root.join("prefix/../user-data")).is_err());
    let prefix = root.join("user-prefix");
    fs::create_dir(&prefix).unwrap();
    fs::create_dir(prefix.join("runtime")).unwrap();
    assert!(prepare::check_prefix(&checkout, &prefix).is_err());
    assert!(prefix.join("runtime").is_dir());
    for path in [
        checkout.clone(),
        checkout.join("media-libav/source"),
        checkout.join("xtask/target"),
    ] {
        assert!(cache::cache_location(&checkout, &path).is_err());
    }
}

#[test]
fn all_native_companion_commands_preserve_flags_paths_and_private_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let prefix = root.join("prefix 中文 $() ;");
    let out = root.join("output 中文 $() ;");
    for os in ["linux", "macos", "windows"] {
        for arch in ["x86_64", "aarch64"] {
            let c = config(root, os, arch);
            let commands = prepare::companion_commands(&c, &prefix, &out, true, false).unwrap();
            assert_eq!(commands.len(), 4);
            assert!(
                commands[0]
                    .iter()
                    .any(|arg| arg == c.root.join("media-libav").join("probe.c").as_os_str())
            );
            assert!(
                commands[1]
                    .iter()
                    .any(|arg| arg == c.root.join("media-libav").join("test_shim.c").as_os_str())
            );
            assert_eq!(
                commands[2],
                [out.join(c.platform.executable("test_shim"))
                    .into_os_string()]
            );
            assert!(commands[3].iter().any(|arg| {
                arg.to_string_lossy()
                    .contains(&prepare::test_companion(c.platform))
            }));
            assert!(
                !commands
                    .iter()
                    .flatten()
                    .any(|arg| arg.to_string_lossy().contains("python"))
            );
            if os == "windows" {
                assert!(commands[0].contains(&OsString::from("/I.")));
                assert!(commands[0].contains(&OsString::from("/Fo.\\")));
                assert!(commands[0].contains(&OsString::from("/OUT:bilikara_media_libav.dll")));
                assert!(commands[1].contains(&OsString::from("/OUT:test_shim.exe")));
                assert!(
                    commands[3].contains(&OsString::from("/OUT:bilikara_media_libav_test.dll"))
                );
                assert!(commands[0].contains(&OsString::from("/MD")));
                assert!(commands[0].contains(&OsString::from(if arch == "aarch64" {
                    "/MACHINE:ARM64"
                } else {
                    "/MACHINE:X64"
                })));
                assert!(prepare::companion_commands(&c, &prefix, &out, false, true).is_err());
            } else {
                let sanitizers =
                    prepare::companion_commands(&c, &prefix, &out, false, true).unwrap();
                assert!(sanitizers[0].contains(&OsString::from("-fsanitize=address,undefined")));
                if os == "macos" {
                    assert!(
                        commands[0].contains(&OsString::from("-Wl,-headerpad_max_install_names"))
                    );
                } else {
                    assert!(commands[0].contains(&OsString::from("-Wl,-z,defs")));
                }
            }
        }
    }
}

#[test]
fn compiler_side_effects_and_failures_stay_in_owned_output_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let out = root.join("compiler 产物 $() ;");
    fs::create_dir(&out).unwrap();
    let source = root.join("compiler.rs");
    fs::write(
        &source,
        r#"
        use std::{env, fs};
        fn main() {
            let args: Vec<_> = env::args().skip(1).collect();
            if args[0] == "fail" { std::process::exit(7); }
            assert_eq!(args[1], "literal 中文 $() ;");
            fs::write(format!("{}.lib", args[0]), b"implicit MSVC output").unwrap();
            fs::write(format!("{}.exp", args[0]), b"implicit MSVC output").unwrap();
        }
    "#,
    )
    .unwrap();
    let executable = root.join(format!("compiler{}", std::env::consts::EXE_SUFFIX));
    assert!(
        std::process::Command::new("rustc")
            .args(["--edition=2024", "--crate-name", "compiler_fixture"])
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    let command = |name: &str| {
        vec![
            executable.clone().into_os_string(),
            name.into(),
            "literal 中文 $() ;".into(),
        ]
    };
    prepare::run_companion_commands(&out, &[command("probe"), command("test_shim")]).unwrap();
    for name in ["probe.lib", "probe.exp", "test_shim.lib", "test_shim.exp"] {
        assert_eq!(fs::read(out.join(name)).unwrap(), b"implicit MSVC output");
        assert!(!root.join(name).exists());
    }
    assert!(
        prepare::run_companion_commands(&out, &[command("fail"), command("must_not_run")]).is_err()
    );
    assert!(!out.join("must_not_run.lib").exists());
}

#[cfg(windows)]
#[test]
#[ignore = "Requires selected native MSVC environment; bundle CI executes it explicitly"]
fn windows_msvc_companion_paths_compile_generated_header() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("source 中文 $() ;");
    let prefix = dir.path().join("prefix 中文 $() ;");
    let out = dir.path().join("output 中文 $() ;");
    for path in [
        root.join("media-libav"),
        prefix.join("include"),
        prefix.join("lib"),
        prefix.join("bin"),
        out.clone(),
    ] {
        fs::create_dir_all(path).unwrap();
    }
    fs::write(out.join("build_config.h"), "#define GENERATED_VALUE 23\n").unwrap();
    fs::write(
        prefix.join("include/selected_prefix.h"),
        "#define PREFIX_VALUE 19\n",
    )
    .unwrap();
    fs::write(
        root.join("media-libav/test_shim.c"),
        "#include \"build_config.h\"\n#include <selected_prefix.h>\n\
         _Static_assert(GENERATED_VALUE + PREFIX_VALUE == 42, \"wrong selected headers\");\n\
         int main(void) { return GENERATED_VALUE + PREFIX_VALUE != 42; }\n",
    )
    .unwrap();
    let platform = Platform::current().unwrap();
    let c = Config {
        root,
        platform,
        env: Environment::current(),
        target: None,
        development: false,
    };
    prepare::require_target(platform, &c.env).unwrap();
    // Exercise the real canonical Windows path, not a descriptor on POSIX.
    let out = out.canonicalize().unwrap();
    assert!(out.as_os_str().to_string_lossy().starts_with(r"\\?\"));
    let commands = prepare::companion_commands(&c, &prefix, &out, true, false).unwrap();
    let mut compiler = commands[1].clone();
    // This is a compiler/path probe without FFmpeg prerequisites. The later
    // bundle recipe still builds and executes the actual libav C companion.
    compiler.retain(|arg| {
        !["avformat.lib", "avcodec.lib", "avutil.lib"]
            .iter()
            .any(|library| arg == library)
    });
    prepare::run_companion_commands(&out, &[compiler, commands[2].clone()]).unwrap();
    assert!(out.join("test_shim.exe").is_file());
    assert!(out.join("test_shim.obj").is_file());
    assert!(!dir.path().join("test_shim.obj").exists());
}

#[test]
fn posix_relocation_keeps_loader_paths_and_signs_after_all_mutations() {
    let path = Path::new("/isolated prefix 中文 $();/bin/libavcodec.63.dylib");
    let fact = json!({"imports":["@rpath/libavutil.61.dylib", "/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/Security.framework/Versions/A/Security"]});
    for arch in ["x86_64", "aarch64"] {
        let platform = Platform::new("macos", arch).unwrap();
        let commands =
            prepare::relocation_commands(path, "libavcodec.63.dylib", &fact, platform).unwrap();
        let expected: Vec<Vec<OsString>> = vec![
            vec![
                "install_name_tool".into(),
                "-change".into(),
                "@rpath/libavutil.61.dylib".into(),
                "@loader_path/libavutil.61.dylib".into(),
                path.into(),
            ],
            vec![
                "install_name_tool".into(),
                "-id".into(),
                "@loader_path/libavcodec.63.dylib".into(),
                path.into(),
            ],
            vec![
                "codesign".into(),
                "--force".into(),
                "--sign".into(),
                "-".into(),
                path.into(),
            ],
        ];
        assert_eq!(commands, expected);
    }
    let linux = Platform::new("linux", "x86_64").unwrap();
    assert_eq!(
        prepare::relocation_commands(path, "libavcodec.so.63", &fact, linux).unwrap(),
        vec![vec![
            OsString::from("patchelf"),
            "--set-rpath".into(),
            "$ORIGIN".into(),
            path.into()
        ]]
    );
}

#[test]
fn macho_system_boundary_keeps_selected_private_and_external_toolchains_distinct() {
    let platform = Platform::new("macos", "arm64").unwrap();
    for path in [
        "/usr/lib/libSystem.B.dylib",
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    ] {
        assert!(prepare::system_import(path, platform));
    }
    for path in [
        "/opt/homebrew/lib/libavformat.dylib",
        "/usr/local/lib/libavcodec.dylib",
        "@rpath/libavcodec.63.dylib",
        "@loader_path/libavutil.61.dylib",
    ] {
        assert!(!prepare::system_import(path, platform));
    }
}

#[cfg(unix)]
#[test]
fn atomic_completion_and_headers_keep_regular_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let reference = dir.path().join("regular-create");
    let output = dir.path().join("build-info.json");
    fs::write(&reference, b"reference").unwrap();
    prepare::atomic_bytes(&output, b"complete").unwrap();
    assert_eq!(
        fs::metadata(reference).unwrap().permissions().mode(),
        fs::metadata(output).unwrap().permissions().mode()
    );
}

#[test]
fn selected_library_abi_configuration_and_cargo_artifacts_fail_closed() {
    let facts = json!({"program_version":{"version":"9.0.1","configuration":"--disable-network --enable-shared"},"library_versions":[{"name":"libavutil","version":3998053},{"name":"libavcodec","version":4129125},{"name":"libavformat","version":4129125}]});
    assert!(prepare::validate_facts(&facts).is_ok());
    for (pointer, value) in [
        ("/program_version/version", json!("8.1.2")),
        (
            "/program_version/configuration",
            json!("--enable-network --enable-shared"),
        ),
        ("/program_version/configuration", json!("x".repeat(2049))),
        ("/library_versions/0/version", json!(1)),
    ] {
        let mut invalid = facts.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(prepare::validate_facts(&invalid).is_err());
    }
    let artifact = json!({"reason":"compiler-artifact","target":{"name":"bilikara_runtime"},"profile":{"test":true},"executable":"/selected Cargo target 中文/release/deps/current-tests"});
    let line = serde_json::to_vec(&artifact).unwrap();
    assert_eq!(
        prepare::compiler_artifact(&line, "bilikara_runtime", true).unwrap(),
        Path::new("/selected Cargo target 中文/release/deps/current-tests")
    );
    assert!(prepare::compiler_artifact(b"malformed", "bilikara_runtime", true).is_err());
    assert!(prepare::compiler_artifact(&line, "bilikara_runtime", false).is_err());
    assert!(
        prepare::compiler_artifact(
            format!("{artifact}\n{artifact}").as_bytes(),
            "bilikara_runtime",
            true
        )
        .is_err()
    );
    let mut other = artifact.clone();
    other["executable"] = json!("/stale/another");
    assert!(
        prepare::compiler_artifact(
            format!("{}\n{}", artifact, other).as_bytes(),
            "bilikara_runtime",
            true
        )
        .is_err()
    );
}

#[test]
fn implicit_cargo_target_accepts_only_native_current_profile_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let platform = Platform::new("linux", "x86_64").unwrap();
    let expected = dir.path().join("Cargo target 中文/release");
    let executable = dir
        .path()
        .join("Cargo target 中文")
        .join(platform.target())
        .join("release/deps/current-tests");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"current compiler artifact").unwrap();
    assert!(prepare::artifact_matches_output(&executable, &expected, platform, true).unwrap());
    assert!(!prepare::artifact_matches_output(&executable, &expected, platform, false).unwrap());
    for path in [
        "Cargo target 中文/foreign/release/current",
        "Cargo target 中文/debug/current",
        "stale target/release/current",
    ] {
        let artifact = dir.path().join(path);
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, b"stale").unwrap();
        assert!(!prepare::artifact_matches_output(&artifact, &expected, platform, true).unwrap());
    }
}

#[test]
fn companion_output_rejects_checkout_installation_and_unrelated_data() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("checkout");
    let prefix = dir.path().join("prefix");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&prefix).unwrap();
    let c = config(&root, "linux", "x86_64");
    for out in [&root, dir.path(), &prefix, &prefix.join("licenses")] {
        assert!(prepare::companion_output(&c, &prefix, out).is_err());
    }
    let installed = dir.path().join("installed");
    fs::create_dir(&installed).unwrap();
    fs::write(installed.join("credentials.json"), "leave intact").unwrap();
    assert!(prepare::companion_output(&c, &prefix, &installed).is_err());
    assert_eq!(
        fs::read_to_string(installed.join("credentials.json")).unwrap(),
        "leave intact"
    );
    assert!(prepare::companion_output(&c, &prefix, &prefix.join("bin")).is_ok());
}

fn pe(imports: &[&str], arm: bool) -> Vec<u8> {
    let mut bytes = vec![0u8; 0x1800];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    bytes[0x84..0x86].copy_from_slice(&(if arm { 0xaa64u16 } else { 0x8664 }).to_le_bytes());
    bytes[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
    bytes[0x94..0x96].copy_from_slice(&0xf0u16.to_le_bytes());
    bytes[0x98..0x9a].copy_from_slice(&0x20bu16.to_le_bytes());
    bytes[0x104..0x108].copy_from_slice(&16u32.to_le_bytes());
    for (offset, value) in [
        (0x110, 0x1000u32),
        (0x114, ((imports.len() + 1) * 20) as u32),
        (0x190, 0x1600),
        (0x194, 0x1000),
        (0x198, 0x1600),
        (0x19c, 0x200),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (index, name) in imports.iter().enumerate() {
        let offset = 0x900 + index * 128;
        let rva = (offset - 0x200 + 0x1000) as u32;
        let descriptor = 0x200 + index * 20;
        bytes[descriptor + 12..descriptor + 16].copy_from_slice(&rva.to_le_bytes());
        bytes[offset..offset + name.len()].copy_from_slice(name.as_bytes());
    }
    bytes
}

#[test]
fn windows_collection_preserves_ucrt_private_closure_redist_and_driver_separation() {
    for arm in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let prefix = dir.path().join("prefix");
        let redist = dir.path().join("selected redist");
        let system = dir.path().join("system");
        for directory in [
            prefix.join("bin"),
            prefix.join("driver"),
            redist.clone(),
            system.clone(),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        let crt = "api-ms-win-crt-runtime-l1-1-0.dll";
        for (name, imports) in [
            ("bilikara_media_libav.dll", vec!["avformat-63.dll", crt]),
            (
                "bilikara_media_libav_test.dll",
                vec!["avformat-63.dll", crt],
            ),
            (
                "avformat-63.dll",
                vec!["avcodec-63.dll", "avutil-61.dll", crt],
            ),
            (
                "avcodec-63.dll",
                vec!["swresample-7.dll", "avutil-61.dll", crt],
            ),
            ("avutil-61.dll", vec!["vcruntime140.dll", crt]),
            ("swresample-7.dll", vec![crt]),
        ] {
            fs::write(prefix.join("bin").join(name), pe(&imports, arm)).unwrap();
        }
        fs::write(redist.join("vcruntime140.dll"), pe(&[crt], arm)).unwrap();
        fs::write(
            prefix.join("driver/libav_metadata.exe"),
            pe(&["vcruntime140.dll", crt], arm),
        )
        .unwrap();
        let platform = Platform {
            os: Os::Windows,
            arm,
        };
        prepare::collect(
            &prefix,
            platform,
            &Environment::default(),
            Some(&redist),
            Some(&system),
        )
        .unwrap();
        let data: Value =
            serde_json::from_slice(&fs::read(prefix.join("bin/ffmpeg-runtime.json")).unwrap())
                .unwrap();
        assert!(
            data["runtime_files"]
                .as_array()
                .unwrap()
                .contains(&json!("swresample-7.dll"))
        );
        assert!(
            data["runtime_files"]
                .as_array()
                .unwrap()
                .contains(&json!("vcruntime140.dll"))
        );
        assert!(
            !data["runtime_files"]
                .as_array()
                .unwrap()
                .contains(&json!("bilikara_media_libav_test.dll"))
        );
        assert!(data["driver_pe"].get("libav_metadata.exe").is_some());
        assert!(data["pe"].get("libav_metadata.exe").is_none());
        // Repeated collection refreshes CRTs from the selected toolchain and
        // retains their provenance rather than trusting a stale local DLL.
        fs::write(prefix.join("bin/vcruntime140.dll"), b"stale local CRT").unwrap();
        prepare::collect(
            &prefix,
            platform,
            &Environment::default(),
            Some(&redist),
            Some(&system),
        )
        .unwrap();
        assert_eq!(
            fs::read(prefix.join("bin/vcruntime140.dll")).unwrap(),
            fs::read(redist.join("vcruntime140.dll")).unwrap()
        );
        let repeated: Value =
            serde_json::from_slice(&fs::read(prefix.join("bin/ffmpeg-runtime.json")).unwrap())
                .unwrap();
        assert_eq!(data, repeated);
        fs::write(
            prefix.join("bin/avcodec-63.dll"),
            pe(&["unselected.dll", crt], arm),
        )
        .unwrap();
        fs::write(prefix.join("bin/unselected.dll"), pe(&[crt], arm)).unwrap();
        assert!(
            prepare::collect(
                &prefix,
                platform,
                &Environment::default(),
                Some(&redist),
                Some(&system)
            )
            .is_err()
        );
        fs::write(
            prefix.join("bin/avcodec-63.dll"),
            pe(&["msys-2.0.dll", crt], arm),
        )
        .unwrap();
        assert!(
            prepare::collect(
                &prefix,
                platform,
                &Environment::default(),
                Some(&redist),
                Some(&system)
            )
            .is_err()
        );
        assert!(!prefix.join("bin/ffmpeg-runtime.json").exists());
        fs::write(
            prefix.join("bin/avcodec-63.dll"),
            pe(&["avcodec-old.dll", crt], arm),
        )
        .unwrap();
        fs::write(system.join("avcodec-old.dll"), pe(&[crt], arm)).unwrap();
        assert!(
            prepare::collect(
                &prefix,
                platform,
                &Environment::default(),
                Some(&redist),
                Some(&system)
            )
            .is_err()
        );
        fs::write(prefix.join("bin/avcodec-63.dll"), pe(&[], arm)).unwrap();
        assert!(
            prepare::collect(
                &prefix,
                platform,
                &Environment::default(),
                Some(&redist),
                Some(&system)
            )
            .is_err()
        );
        fs::write(prefix.join("bin/avcodec-63.dll"), pe(&[crt], !arm)).unwrap();
        assert!(
            prepare::collect(
                &prefix,
                platform,
                &Environment::default(),
                Some(&redist),
                Some(&system)
            )
            .is_err()
        );
    }
}
