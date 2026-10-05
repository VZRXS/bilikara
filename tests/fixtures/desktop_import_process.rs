// Private native process fixture. Never included in a product.
use std::{io::Write, thread, time::Duration};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args[0].as_str() {
        "arguments" => print!("{}", args[1]),
        "fail" => { eprintln!("Synthetic invalid state"); std::process::exit(7); }
        "large" => { let _ = std::io::stdout().write_all(&vec![b'x';2*1024*1024]); }
        "waiting" => thread::sleep(Duration::from_secs(30)),
        _ => panic!("unknown private process fixture"),
    }
}
