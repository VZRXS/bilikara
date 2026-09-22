//! Controlled child only. Never connects, logs credentials, or runs a media CLI.
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    thread,
    time::Duration,
};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.iter().any(|v| v == "--help=#all") {
        println!(
            "--no-netrc --input-file --load-cookies --max-connection-per-server --human-readable --file-allocation --check-certificate --allow-overwrite --enable-rpc"
        );
        return;
    }
    if args.iter().any(|v| v == "--version") {
        if let Some(root) = env::var_os("BILIKARA_ARIA2_FIXTURE_ROOT") {
            let root = PathBuf::from(root);
            fs::write(
                root.join(format!("{}.probe", std::process::id())),
                "version checked",
            )
            .unwrap();
            while fs::read_to_string(root.join("mode")).unwrap() == "probe_hold"
                && !root.join("release").exists()
            {
                thread::sleep(Duration::from_millis(10));
            }
        }
        println!("aria2 version 1.37.0\nEnabled Features: HTTPS");
        return;
    }
    assert!(
        args.iter()
            .all(|v| !v.contains("SESSDATA") && !v.contains("http://") && !v.contains("https://"))
    );
    for flag in [
        "--no-conf",
        "--no-netrc=true",
        "--max-tries=1",
        "--file-allocation=none",
        "--check-certificate=true",
    ] {
        assert!(args.iter().any(|v| v == flag));
    }
    let connections = env::var("BILIKARA_ARIA2_EXPECT_CONNECTIONS").unwrap_or("16".into());
    assert!(args.contains(&format!("--split={connections}")));
    assert!(args.contains(&format!("--max-connection-per-server={connections}")));
    assert!(env::var_os("BILIKARA_BILIBILI_COOKIE").is_none());
    let value = |flag| PathBuf::from(&args[args.iter().position(|v| v == flag).unwrap() + 1]);
    let input_path = value("--input-file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&input_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let input = fs::read_to_string(&input_path).unwrap();
    assert!(input.contains("header=Origin: https://www.bilibili.com"));
    assert!(input.contains("header=Referer: https://www.bilibili.com"));
    assert!(input.contains("header=User-Agent:"));
    assert!(!input.contains("SESSDATA"));
    let cookies = fs::read_to_string(value("--load-cookies")).unwrap();
    assert!(cookies.contains("api.bilibili.com\tFALSE\t/\tFALSE\t0\tSESSDATA\tsynthetic"));
    let output = input.lines().find_map(|s| s.strip_prefix(" out=")).unwrap();
    let root = PathBuf::from(env::var_os("BILIKARA_ARIA2_FIXTURE_ROOT").unwrap());
    let media = PathBuf::from(env::var_os("BILIKARA_ARIA2_MEDIA").unwrap());
    let mode = fs::read_to_string(root.join("mode")).unwrap();
    let urls = input.lines().next().unwrap();
    let kind = if output.contains("video") {
        "video"
    } else {
        "audio"
    };
    let page = if output.contains("p2") { 2 } else { 1 };
    assert!(urls.contains(&format!("cid={}", 456 + page)));
    let source = if kind == "video" {
        if urls.contains("hevc") {
            "video-hevc.mp4"
        } else {
            "video.mp4"
        }
    } else if urls.contains("flac") {
        "audio-flac.mp4"
    } else if urls.contains("eac3") {
        "audio-eac3.m4a"
    } else {
        "audio.m4a"
    };
    let receipt = root.join(format!("{}", std::process::id()));
    fs::write(
        receipt.with_extension("started"),
        format!(
            "{kind}-p{page}:{source}:candidates={}\n",
            urls.split('\t').count()
        ),
    )
    .unwrap();
    if mode == "forbidden" {
        println!("error status=403 credential-must-never-be-logged");
        std::process::exit(22);
    }
    if mode == "always_fail"
        || (mode == "retry" || mode == "retry_video" && kind == "video")
            && fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(format!("{kind}-p{page}.first")))
                .is_ok()
    {
        fs::write(receipt.with_extension("failed"), "failed").unwrap();
        std::process::exit(1);
    }
    let destination = value("--dir").join(output);
    fs::write(&destination, vec![0; 1_000_000]).unwrap(); // deliberate preallocation
    println!("[#abc123 128B/1000000B(0%) CN:1 DL:1B]");
    io::stdout().flush().unwrap();
    while (matches!(mode.as_str(), "hold" | "preallocated")
        || mode == "invalid_video" && kind == "audio")
        && !root.join("release").exists()
    {
        thread::sleep(Duration::from_millis(10));
    }
    if mode == "invalid" || mode == "invalid_video" && kind == "video" {
        fs::write(&destination, b"not media").unwrap();
    } else {
        fs::copy(media.join(source), &destination).unwrap();
    }
    if mode == "extra" {
        fs::write(value("--dir").join("leftover.aria2"), b"incomplete").unwrap();
    }
    fs::write(receipt.with_extension("completed"), "done").unwrap();
    while mode == "late_hold" && !root.join("release").exists() {
        thread::sleep(Duration::from_millis(10));
    }
}
