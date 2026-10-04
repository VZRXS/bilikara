//! Native command fixture. No downloader or interpreter; records exact argv.
use std::{
    env, fs,
    io::Write,
    thread,
    time::{Duration, Instant},
};
fn main() {
    let root = env::current_exe().unwrap().parent().unwrap().to_owned();
    let arguments: Vec<_> = env::args().skip(1).collect();
    assert_eq!(arguments.len(), 2);
    assert_eq!(arguments[0], "--no-conf");
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("calls"))
        .unwrap();
    writeln!(log, "{}", arguments[1]).unwrap();
    drop(log);
    match arguments[1].as_str() {
        "--version" => {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !root.join("release").exists() {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(10));
            }
            println!("aria2 version 1.37.0\nEnabled Features: HTTPS");
        }
        "--help=#all" => println!(
            "--no-netrc --input-file --load-cookies --max-connection-per-server --human-readable --file-allocation --check-certificate --allow-overwrite --enable-rpc"
        ),
        _ => panic!("unexpected fixture invocation"),
    }
}
