fn main() {
    std::process::exit(bilikara_runtime::catalog_maintenance::cli(
        std::env::args().skip(1),
    ));
}
