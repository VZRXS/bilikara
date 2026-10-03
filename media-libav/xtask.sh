#!/usr/bin/env bash
# Build the existing independent tool for the executing host, even when the
# product has an explicit Cargo target. Cargo's diagnostics stay on stderr.
bilikara_xtask() {
  cargo run --manifest-path "$repo/xtask/Cargo.toml" --locked --target host-tuple -- "$@"
}
