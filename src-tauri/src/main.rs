#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::{Arc, Mutex};
use tauri::Manager;

use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

struct BackendProcess {
    child: Arc<Mutex<Option<Child>>>,
    base_url: Arc<Mutex<Option<String>>>,
    shutdown_token: String,
}

fn resolve_backend_command() -> (String, Vec<String>) {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    #[allow(unused_mut)]
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
    if is_backend_candidate(&win_path, &current_exe) {
        return (win_path.to_string_lossy().to_string(), vec![]);
    }

    let win_path2 = current_dir.join("bilikara.exe");
    if is_backend_candidate(&win_path2, &current_exe) {
        return (win_path2.to_string_lossy().to_string(), vec![]);
    }

    // macOS packaged path
    let mac_path = current_dir.join("bilikara.app").join("Contents").join("MacOS").join("bilikara");
    if is_backend_candidate(&mac_path, &current_exe) {
        return (mac_path.to_string_lossy().to_string(), vec![]);
    }

    if let Some(script_path) = find_dev_launcher(current_dir) {
        return ("python".to_string(), vec![script_path.to_string_lossy().to_string()]);
    }

    // Default to Python script for development
    ("python".to_string(), vec!["start_bilikara.py".to_string()])
}

fn find_dev_launcher(start_dir: &std::path::Path) -> Option<PathBuf> {
    let mut cursor = Some(start_dir);
    while let Some(dir) = cursor {
        let candidate = dir.join("start_bilikara.py");
        if candidate.exists() {
            return Some(candidate);
        }
        cursor = dir.parent();
    }
    None
}

fn is_backend_candidate(path: &PathBuf, current_exe: &PathBuf) -> bool {
    if !path.exists() {
        return false;
    }
    let candidate = path.canonicalize().unwrap_or_else(|_| path.clone());
    candidate != *current_exe
}

fn current_executable_string() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn make_shutdown_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", std::process::id(), nanos)
}

fn parse_local_http_url(base_url: &str) -> Option<(&str, u16)> {
    let rest = base_url.strip_prefix("http://")?;
    let authority = rest.split('/').next()?;
    let (host, port_text) = authority.rsplit_once(':')?;
    let port = port_text.parse::<u16>().ok()?;
    Some((host, port))
}

#[tauri::command]
fn set_window_fullscreen(window: tauri::WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

fn request_backend_shutdown(base_url: &str, shutdown_token: &str) -> bool {
    let Some((host, port)) = parse_local_http_url(base_url) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect((host.trim_matches(|c| c == '[' || c == ']'), port)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/app/shutdown HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nX-Bilikara-Shutdown-Token: {}\r\nConnection: close\r\n\r\n{}",
        host, port, shutdown_token, "{}"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    true
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return true,
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_window_fullscreen])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            let (cmd, mut args) = resolve_backend_command();
            args.extend(vec![
                "--no-browser".to_string(),
                "--headless".to_string(),
                "--port".to_string(),
                "0".to_string(),
            ]);

            let shutdown_token = make_shutdown_token();
            let desktop_executable = current_executable_string();

            let mut command = Command::new(&cmd);
            command
                .args(args)
                .env("PYTHONUNBUFFERED", "1")
                .env("BILIKARA_STARTUP_LOG", "1")
                .env("BILIKARA_LAUNCH_MODE", "tauri")
                .env("BILIKARA_DESKTOP_PID", std::process::id().to_string())
                .env("BILIKARA_DESKTOP_EXECUTABLE", desktop_executable)
                .env("BILIKARA_SHUTDOWN_TOKEN", shutdown_token.clone())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);

            let mut child = command.spawn()?;

            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take();
            let window_clone = window.clone();
            let child_arc = Arc::new(Mutex::new(Some(child)));
            let base_url = Arc::new(Mutex::new(None));
            let base_url_for_reader = base_url.clone();

            app.manage(BackendProcess {
                child: child_arc.clone(),
                base_url: base_url.clone(),
                shutdown_token: shutdown_token.clone(),
            });

            let app_handle = app.handle().clone();
            let child_for_monitor = child_arc.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let should_exit = match child_for_monitor.lock() {
                    Ok(mut child_lock) => {
                        if let Some(child) = child_lock.as_mut() {
                            match child.try_wait() {
                                Ok(Some(_)) | Err(_) => {
                                    *child_lock = None;
                                    true
                                }
                                Ok(None) => false,
                            }
                        } else {
                            false
                        }
                    }
                    Err(_) => true,
                };
                if should_exit {
                    app_handle.exit(0);
                    break;
                }
            });

            if let Some(stderr) = stderr {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            eprintln!("Backend stderr: {}", line);
                        }
                    }
                });
            }

            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    if line.contains("\"event\": \"bilikara.ready\"") {
                        if let Ok(ready) = serde_json::from_str::<ReadyEvent>(&line) {
                            println!("Backend ready at {}", ready.base_url);
                            if let Ok(mut stored_url) = base_url_for_reader.lock() {
                                *stored_url = Some(ready.base_url.clone());
                            }
                            if let Err(error) = window_clone.show() {
                                eprintln!("Failed to show window: {}", error);
                            }
                            if let Err(error) = window_clone
                                .eval(&format!("window.location.replace('{}');", ready.base_url))
                            {
                                eprintln!("Failed to navigate to backend: {}", error);
                            }
                            break;
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    let shutdown_url = state
                        .base_url
                        .lock()
                        .ok()
                        .and_then(|stored_url| stored_url.clone());
                    let shutdown_requested = shutdown_url
                        .as_deref()
                        .map(|url| request_backend_shutdown(url, &state.shutdown_token))
                        .unwrap_or(false);

                    if let Ok(mut child_lock) = state.child.lock() {
                        if let Some(mut child) = child_lock.take() {
                            if shutdown_requested
                                && wait_for_child_exit(&mut child, Duration::from_secs(20))
                            {
                                return;
                            }
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
