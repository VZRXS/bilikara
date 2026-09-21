//! Deterministic child for the real Desktop Host executor. No network or shell.
//! Controls are private test files/environment, not application API parameters.
use std::{convert::TryInto, env, fs, io::Write, path::PathBuf, thread, time::Duration};
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
    assert_eq!(env::var("PATH").unwrap(), "");
    if let Ok(cookie) = env::var("BILIKARA_BBDOWN_EXPECT_COOKIE") {
        assert_eq!(option("-c"), cookie);
    }
    let mode=fs::read_to_string(root.join("mode")).unwrap();
    let pid=std::process::id();
    // No credentials in the test receipt either.
    fs::write(root.join(format!("{pid}.started")), format!("{kind}\n{}\n{}\n{}",option("-p"),mode,directory.display())).unwrap();
    for _ in 0..24 { // larger than pipe capacity, both streams must drain
        println!("synthetic-secret-output {}", "x".repeat(8192));
        eprintln!("synthetic-secret-output {}", "x".repeat(8192));
    }
    std::io::stdout().flush().unwrap();
    let policy = format!("quality={}\ncodec={}\nascending={}\n",
        if kind == "video" { option("-q") } else { String::new() },
        if args.iter().any(|a| a == "-e") { option("-e") } else { String::new() },
        args.iter().any(|a| a == "--audio-ascending"));
    fs::write(root.join(format!("{pid}.policy")), policy).unwrap();
    if mode == "hold" {
        let start = std::time::Instant::now();
        while !root.join("release").exists() {
            assert!(start.elapsed() < Duration::from_secs(15), "fixture barrier timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }
    if mode == "slow" {thread::sleep(Duration::from_secs(12));}
    if mode == "exit" {std::process::exit(7);}
    if mode == "missing" {return;}
    let output=directory.join("456");fs::create_dir(&output).unwrap();
    let name=if kind=="video" {"video.mp4"} else {"audio.m4a"};
    let source=if kind=="video" && mode.starts_with("hevc") {"video-hevc.mp4"}
        else if kind=="audio" && mode=="dolby" {"audio-eac3.m4a"}
        else if kind=="audio" && !args.iter().any(|a|a=="--audio-ascending") {"audio-flac.mp4"} else {name};
    if mode=="invalid" { fs::write(output.join(name),b"invalid-media").unwrap(); }
    else { fs::copy(media.join(source),output.join(name)).unwrap(); }
    if kind == "video" && mode == "hevc-missing-mdat" {
        let mut bytes = fs::read(output.join(name)).unwrap();
        let mut offset = 0;
        loop {
            let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            if &bytes[offset + 4..offset + 8] == b"mdat" {
                bytes[offset + 4..offset + 8].copy_from_slice(b"free");
                break;
            }
            assert!(size >= 8);
            offset += size;
        }
        fs::write(output.join(name), bytes).unwrap();
    }
    fs::write(root.join(format!("{pid}.completed")), b"done").unwrap();
    if mode == "late_hold" {
        let start = std::time::Instant::now();
        while !root.join("release").exists() {
            assert!(start.elapsed() < Duration::from_secs(15), "fixture barrier timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }
    if mode == "late" {thread::sleep(Duration::from_secs(12));}
}
