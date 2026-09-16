fn main() {
    if let Err(error) = bilikara_runtime::native_host::desktop::run(std::env::args().skip(1)) {
        eprintln!("Desktop Rust preview failed: {error}");
        std::process::exit(1);
    }
}
