//! Adjacent desktop development preparation only. Release assembly remains in
//! build_bundle.py until its independent cutover is qualified.
mod config;
mod files;
mod libav;
#[cfg(test)]
mod tests;
mod tools;

use config::{Config, Environment, Platform};
use std::{env, path::Path, process::Command};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("Desktop preparation failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("prepare-desktop")) {
        return Err("usage: cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- prepare-desktop [--target TRIPLE]".into());
    }
    let mut target = None;
    while let Some(arg) = args.next() {
        if arg == "--target" {
            target = Some(args.next().ok_or("--target requires a triple")?);
        } else if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--target=")) {
            target = Some(value.into());
        } else {
            return Err(format!(
                "unsupported preparation argument: {}",
                arg.to_string_lossy()
            )
            .into());
        }
    }
    let environment = Environment::current();
    if environment.mobile() {
        return Ok(());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let config = Config::new(root, Platform::current()?, environment, target)?;
    let prefix = libav::prefix(&config)?;
    if !config.development && prefix.is_none() {
        return Err("BILIKARA_LIBAV_PREFIX is required for a complete native bundle".into());
    }
    let mut command = Command::new("cargo");
    command
        .current_dir(root)
        .args(["build", "--manifest-path"])
        .arg(root.join("rust-runtime/Cargo.toml"))
        .args([
            "--locked",
            "--features",
            "native-host",
            "--bin",
            "bilikara-desktop-host",
            "--bin",
            "bilikara-updater",
        ]);
    if !config.development {
        command.arg("--release");
    }
    if let Some(target) = &config.target {
        command.arg("--target").arg(target);
    }
    if !command.status()?.success() {
        return Err("native backend/updater build failed".into());
    }
    let executable = config
        .target_output("rust-runtime")?
        .join(config.platform.executable("bilikara-desktop-host"));
    let destination = config.target_output("src-tauri")?;
    files::stage(&config, &destination, &executable, prefix.as_deref())?;
    println!("Native build complete: {}", destination.display());
    Ok(())
}
