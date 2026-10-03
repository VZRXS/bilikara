//! Compiled native test double for Cargo/BBDown. Never part of the build path.
//! Staged binaries are real native executables so the normal import inspection
//! runs, but this does not prove a product Host launch or a foreign OS build.
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}
fn main() {
    let executable = env::current_exe().unwrap();
    // Private test-only deadlock fixture: the Node driver must terminate the
    // supplied xtask and this blocked descendant, never a user's installation.
    if let Some(record) = env::var_os("XTASK_FIXTURE_BLOCK_PID") {
        fs::write(record, std::process::id().to_string()).unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    if let Some(log) = env::var_os("XTASK_WRAPPER_LOG") {
        let args: Vec<_> = env::args().skip(1).collect();
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .unwrap();
        writeln!(
            log,
            "{{\"cwd\":{},\"args\":[{}]}}",
            quote(env::current_dir().unwrap().to_str().unwrap()),
            args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(",")
        )
        .unwrap();
        if args == ["ci"] && env::var_os("XTASK_WRAPPER_FAIL_INSTALL").is_some() {
            std::process::exit(7);
        }
        assert!(args == ["ci"] || args == ["run", "build"]);
        return;
    }
    if executable
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .eq_ignore_ascii_case("bbdown")
    {
        println!(
            "{}",
            env::var("XTASK_FIXTURE_TOOL_VERSION").unwrap_or("BBDown 1.6.3".into())
        );
        return;
    }
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "exec") {
        log(&args);
        assert_eq!(&args[..4], ["exec", "--", "tauri", "build"]);
        assert!(args.ends_with(&["--".into(), "--locked".into()]));
        let target = args
            .iter()
            .position(|a| a == "--target")
            .map(|i| &args[i + 1]);
        let output = output("src-tauri");
        let output = target
            .map_or(output.clone(), |target| output.join(target))
            .join("release");
        let path = if cfg!(target_os = "macos") {
            let app = output.join("bundle/macos/bilikara.app");
            fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            fs::write(app.join("Contents/Info.plist"),
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>bilikara</string><key>CFBundleIdentifier</key><string>com.bilikara.app</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>").unwrap();
            app.join("Contents/MacOS/bilikara")
        } else {
            output.join(format!("bilikara{}", env::consts::EXE_SUFFIX))
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::copy(&executable, &path).unwrap();
        if cfg!(target_os = "macos") {
            assert!(
                std::process::Command::new("codesign")
                    .args(["--force", "--sign", "-", "--timestamp=none"])
                    .arg(path.parent().unwrap().parent().unwrap().parent().unwrap())
                    .status()
                    .unwrap()
                    .success()
            );
        }
        return;
    }
    let get = |name| {
        args.iter()
            .position(|a| a == name)
            .map(|i| args[i + 1].clone())
    };
    let manifest = get("--manifest-path").unwrap();
    let crate_name = Path::new(&manifest).parent().unwrap().file_name().unwrap();
    let output = output(crate_name.to_str().unwrap());
    log(&args);
    if args[0] == "metadata" {
        println!(
            "{{\"target_directory\":{}}}",
            quote(output.to_str().unwrap())
        );
    } else if args[0] == "build" {
        let output = if let Some(target) = get("--target") {
            output.join(target)
        } else {
            output
        };
        let output = output.join(if args.iter().any(|a| a == "--release") {
            "release"
        } else {
            "debug"
        });
        fs::create_dir_all(&output).unwrap();
        for name in ["bilikara-desktop-host", "bilikara-updater"] {
            fs::copy(
                &executable,
                output.join(format!("{name}{}", env::consts::EXE_SUFFIX)),
            )
            .unwrap();
        }
    } else {
        panic!("unexpected Cargo fixture invocation");
    }
}
fn output(crate_name: &str) -> PathBuf {
    env::var_os("CARGO_TARGET_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("XTASK_FIXTURE_OUTPUT").unwrap()).join(crate_name)
        })
}
fn log(args: &[String]) {
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(env::var_os("XTASK_FIXTURE_LOG").unwrap())
        .unwrap();
    writeln!(
        log,
        "[{}]",
        args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(",")
    )
    .unwrap();
}
