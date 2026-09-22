fn main() {
    if let Err(error) = bilikara_runtime::native_host::desktop::run(std::env::args().skip(1)) {
        eprintln!("Native desktop startup failed: {error}");
        std::process::exit(1);
    }
}
