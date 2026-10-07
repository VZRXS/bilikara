// Private native process fixture. Never included in a product.
use std::{io::Write, thread, time::Duration};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args[0].as_str() {
        "arguments" => print!("{}", args[1]),
        "fail" => { eprintln!("Synthetic invalid state"); std::process::exit(7); }
        "large" => { let _ = std::io::stdout().write_all(&vec![b'x';2*1024*1024]); }
        "waiting" => thread::sleep(Duration::from_secs(30)),
        "--start-without-import" => {
            let data = std::path::Path::new(&args[args.iter().position(|arg| arg == "--data-dir").unwrap() + 1]);
            let isolate = args.iter().any(|arg| arg == "--import-from");
            let mut record = std::fs::OpenOptions::new().create(true).append(true).open(data.join("fresh-attempts.txt")).unwrap();
            record.write_all(if isolate { b"isolate\n" } else { b"initialize\n" }).unwrap();
            drop(record);
            if isolate { thread::sleep(Duration::from_secs(30)); }
            else { print!("{}", std::fs::read_to_string(data.join("fresh-result.json")).unwrap()); }
        }
        _ => panic!("unknown private process fixture"),
    }
}
