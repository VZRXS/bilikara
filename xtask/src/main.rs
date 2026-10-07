//! Independent desktop construction and prerequisite tool;
//! neither links the application Runtime nor executes project Python.
mod bbdown;
mod compliance;
mod config;
mod files;
mod libav;
mod libav_cache;
mod libav_prepare;
#[cfg(test)]
mod libav_prerequisite_tests;
mod macos;
mod native_package;
mod release;
#[cfg(test)]
mod tests;
mod tools;

use config::{Config, Environment, Platform};
use std::{env, path::Path, process::Command};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("Desktop task failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let action = args
        .next()
        .ok_or("expected prepare-desktop, build-backend, build-desktop or assemble-desktop")?;
    let action = action.to_str().ok_or("invalid desktop command")?;
    if action == "verify-native-desktop" {
        let executable = args
            .next()
            .ok_or("verify-native-desktop requires a compiled Host path")?;
        if args.next().is_some() {
            return Err("verify-native-desktop accepts exactly one compiled Host path".into());
        }
        let expected = env::var("BILIKARA_EXPECT_RELEASE_VERSION").unwrap_or_default();
        println!(
            "{}",
            native_package::verify(Path::new(&executable), &expected)?
        );
        return Ok(());
    }
    if action == "prepare-bbdown" {
        return bbdown::run(args.collect());
    }
    if action.starts_with("libav-") {
        return libav_prepare::run(action, args.collect());
    }
    if !matches!(
        action,
        "prepare-desktop" | "build-backend" | "build-desktop" | "assemble-desktop"
    ) {
        return Err(
            "expected prepare-desktop, build-backend, build-desktop or assemble-desktop".into(),
        );
    }
    let mut target = None;
    let mut dist = None;
    let mut shell = None;
    while let Some(arg) = args.next() {
        if arg == "--target" {
            target = Some(args.next().ok_or("--target requires a triple")?);
        } else if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--target=")) {
            target = Some(value.into());
        } else if arg == "--dist-dir" && action != "prepare-desktop" {
            dist = Some(std::path::PathBuf::from(
                args.next().ok_or("--dist-dir requires a path")?,
            ));
        } else if arg == "--shell" && action == "assemble-desktop" {
            shell = Some(std::path::PathBuf::from(
                args.next()
                    .ok_or("--shell requires a compiled shell path")?,
            ));
        } else {
            return Err(format!(
                "unsupported desktop build argument: {}",
                arg.to_string_lossy()
            )
            .into());
        }
    }
    let environment = Environment::current();
    if action == "prepare-desktop" && environment.mobile() {
        return Ok(());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut config = Config::new(root, Platform::current()?, environment, target)?;
    if action != "prepare-desktop" {
        config.development = false;
        let dist = release::dist_directory(&config, dist.as_deref())?;
        let destination = match action {
            "build-backend" => release::build_backend(&config, &dist)?,
            "build-desktop" => {
                release::build_backend(&config, &dist)?;
                let shell = release::build_shell(&config)?;
                release::assemble(&config, &dist, &shell)?
            }
            "assemble-desktop" => {
                let shell = match shell {
                    Some(shell) => shell,
                    None => release::shell_path(&config)?,
                };
                release::assemble(&config, &dist, &shell)?
            }
            _ => unreachable!(),
        };
        println!("Native build complete: {}", destination.display());
        return Ok(());
    }
    let prefix = libav::prefix(&config)?;
    if !config.development && prefix.is_none() {
        return Err("BILIKARA_LIBAV_PREFIX is required for a complete native bundle".into());
    }
    let executable = build_backend_executable(&config)?;
    let destination = config.target_output("src-tauri")?;
    files::stage(&config, &destination, &executable, prefix.as_deref())?;
    println!("Native build complete: {}", destination.display());
    Ok(())
}

fn build_backend_executable(config: &Config) -> Result<std::path::PathBuf> {
    let root = &config.root;
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
    Ok(config
        .target_output("rust-runtime")?
        .join(config.platform.executable("bilikara-desktop-host")))
}
