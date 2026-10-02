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
    let get = |name| {
        args.iter()
            .position(|a| a == name)
            .map(|i| args[i + 1].clone())
    };
    let manifest = get("--manifest-path").unwrap();
    let crate_name = Path::new(&manifest).parent().unwrap().file_name().unwrap();
    let output = env::var_os("CARGO_TARGET_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("XTASK_FIXTURE_OUTPUT").unwrap()).join(crate_name)
        });
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
