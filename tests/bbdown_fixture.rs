//! Deterministic child for the real Desktop Host executor. No network or shell.
//! Controls are private test files/environment, not application API parameters.
use std::{env, fs, io::Write, path::PathBuf, thread, time::Duration};
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--help"] {
        println!("BBDown version 1.6.3 --skip-mux --skip-subtitle --skip-cover --skip-ai --video-only --audio-only --audio-ascending --work-dir --file-pattern --config-file");
        return;
    }
    let root = PathBuf::from(env::var_os("BILIKARA_BBDOWN_FIXTURE_ROOT").unwrap());
    let media = PathBuf::from(env::var_os("BILIKARA_BBDOWN_MEDIA").unwrap());
    let option = |key: &str| args[args.iter().position(|arg| arg == key).unwrap() + 1].clone();
    assert!(args.iter().any(|arg| arg == "--skip-mux"));
    assert!(!args.iter().any(|arg| arg.contains("ffmpeg") || arg.contains("ffprobe") || arg.contains("aria2")));
    assert!(fs::read(option("--config-file")).unwrap().is_empty());
    let directory=PathBuf::from(option("--work-dir"));
    assert_eq!(directory,env::current_dir().unwrap());
    let kind = if args.iter().any(|arg|arg=="--video-only") { "video" } else { "audio" };
    let mode=fs::read_to_string(root.join("mode")).unwrap();
    let pid=std::process::id();
    // No credentials in the test receipt either.
    fs::write(root.join(format!("{pid}.started")), format!("{kind}\n{}\n{}\n{}",option("-p"),mode,directory.display())).unwrap();
    for _ in 0..24 { // larger than pipe capacity, both streams must drain
        println!("synthetic-secret-output {}", "x".repeat(8192));
        eprintln!("synthetic-secret-output {}", "x".repeat(8192));
    }
    std::io::stdout().flush().unwrap();
    if mode == "slow" {thread::sleep(Duration::from_secs(12));}
    if mode == "exit" {std::process::exit(7);}
    if mode == "missing" {return;}
    let output=directory.join("456");fs::create_dir(&output).unwrap();
    let name=if kind=="video" {"video.mp4"} else {"audio.m4a"};
    let source=if kind=="audio" && !args.iter().any(|a|a=="--audio-ascending") {"audio-flac.mp4"} else {name};
    if mode=="invalid" { fs::write(output.join(name),b"invalid-media").unwrap(); }
    else { fs::copy(media.join(source),output.join(name)).unwrap(); }
    fs::write(root.join(format!("{pid}.completed")), b"done").unwrap();
    if mode == "late" {thread::sleep(Duration::from_secs(12));}
}
