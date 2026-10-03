#!/usr/bin/env bash
# Build the existing independent tool for the executing host, even when the
# product has an explicit Cargo target. Cargo's diagnostics stay on stderr.
# Resolve rustup overrides and Cargo configuration from the checkout/source-kit
# root even during a cold snapshot; leave the recipe's source cwd untouched.
bilikara_xtask() (
  cd -- "$repo" || return
  cargo run --manifest-path "$repo/xtask/Cargo.toml" --locked --target host-tuple -- "$@"
)
