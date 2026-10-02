//! Replaces a desktop installation after its owners exit, then reopens it.
//! Started by the Host from the update workspace: `bilikara-updater --plan PATH`.
#![windows_subsystem = "windows"]
use bilikara_runtime::update_installer::apply::{Outcome, run_from_plan};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let (Some(flag), Some(plan), None) = (args.next(), args.next(), args.next()) else {
        return ExitCode::from(2);
    };
    if flag != "--plan" {
        return ExitCode::from(2);
    }
    match run_from_plan(&PathBuf::from(plan)) {
        Ok(Outcome::Installed) => ExitCode::SUCCESS,
        Ok(_) => ExitCode::from(1),
        Err(_) => ExitCode::from(3),
    }
}
