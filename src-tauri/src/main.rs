#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Manager;

use std::path::PathBuf;

#[derive(Deserialize, Debug)]
struct ReadyEvent {
    #[allow(dead_code)]
    event: String,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[serde(rename = "baseUrl")]
    base_url: String,
}

struct BackendProcess(Arc<Mutex<Option<std::process::Child>>>);

fn resolve_backend_command() -> (String, Vec<String>) {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let mut current_dir = current_exe.parent().unwrap_or_else(|| std::path::Path::new("."));

    // On macOS, the executable is inside Contents/MacOS/, so we go up 3 levels to get next to the .app bundle
    #[cfg(target_os = "macos")]
    {
        if current_dir.ends_with("MacOS") {
            current_dir = current_dir.parent().unwrap_or(current_dir).parent().unwrap_or(current_dir).parent().unwrap_or(current_dir);
        }
    }

    // Windows packaged path
    let win_path = current_dir.join("bilikara").join("bilikara.exe");
    if win_path.exists() {
        return (win_path.to_string_lossy().to_string(), vec![]);
    }

    let win_path2 = current_dir.join("bilikara.exe");
    if win_path2.exists() {
        return (win_path2.to_string_lossy().to_string(), vec![]);
    }

    // macOS packaged path
    let mac_path = current_dir.join("bilikara.app").join("Contents").join("MacOS").join("bilikara");
    if mac_path.exists() {
        return (mac_path.to_string_lossy().to_string(), vec![]);
    }

    // Default to Python script for development
    ("python".to_string(), vec!["start_bilikara.py".to_string()])
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_window("main").unwrap();

            let (cmd, mut args) = resolve_backend_command();
            args.extend(vec![
                "--no-browser".to_string(),
                "--headless".to_string(),
                "--host".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "0".to_string(),
            ]);

            let mut child = Command::new(&cmd)
                .args(args)
                .stdout(Stdio::piped())
                .spawn()
                .expect("Failed to start backend");

            let stdout = child.stdout.take().unwrap();
            let window_clone = window.clone();
            let child_arc = Arc::new(Mutex::new(Some(child)));

            app.manage(BackendProcess(child_arc.clone()));

            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    if line.contains("\"event\": \"bilikara.ready\"") {
                        if let Ok(ready) = serde_json::from_str::<ReadyEvent>(&line) {
                            println!("Backend ready at {}", ready.base_url);
                            window_clone
                                .eval(&format!("window.location.replace('{}');", ready.base_url))
                                .unwrap();
                            window_clone.show().unwrap();
                            break;
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = event.window().try_state::<BackendProcess>() {
                    if let Ok(mut child_lock) = state.0.lock() {
                        if let Some(mut child) = child_lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
