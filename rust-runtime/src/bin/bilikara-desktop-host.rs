fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if cfg!(all(windows, target_arch = "x86_64"))
        && args == [bilikara_runtime::show_host_process::WORKER_FLAG]
    {
        if let Err(error) = bilikara_runtime::show_host_process::run_worker() {
            eprintln!("Show media worker failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = bilikara_runtime::native_host::desktop::run(args.into_iter()) {
        eprintln!("Native desktop startup failed: {error}");
        std::process::exit(1);
    }
}
