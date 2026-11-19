#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // The native media engine fetches the Host's loopback routes; a user's
    // proxy environment must never redirect them. Set before any thread starts.
    #[cfg(target_os = "linux")]
    for key in ["no_proxy", "NO_PROXY"] {
        let value = bilikara_media_engine::loopback_no_proxy(std::env::var(key).ok().as_deref());
        // SAFETY: the first statement of `main`, before any thread exists.
        unsafe { std::env::set_var(key, value) };
    }
    bilikara_app::run();
}
