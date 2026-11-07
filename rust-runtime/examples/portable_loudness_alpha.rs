// Share the actual Host fixture while keeping its feature-specific executable
// separate from ordinary builds running in another Node test worker.
#[path = "native_host_alpha.rs"]
mod host_fixture;

fn main() {
    host_fixture::main();
}
