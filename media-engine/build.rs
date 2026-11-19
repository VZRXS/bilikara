// Compiles the pinned Signalsmith C ABI shared with the libav companion. The
// engine links it statically; no libav or Runtime code is linked here.
fn main() {
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .file("../media-libav/stretch.cpp")
        .include("../media-libav")
        .compile("bilikara_engine_signalsmith");
    println!("cargo:rerun-if-changed=../media-libav/stretch.cpp");
    println!("cargo:rerun-if-changed=../media-libav/probe.h");
    println!("cargo:rerun-if-changed=../media-libav/signalsmith");
}
