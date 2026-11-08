fn main() {
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .file("../../media-libav/stretch.cpp")
        .include("../../media-libav")
        .compile("round_a_signalsmith");
    println!("cargo:rerun-if-changed=../../media-libav/stretch.cpp");
    println!("cargo:rerun-if-changed=../../media-libav/signalsmith");
}
