#!/usr/bin/env bash
# Build/cache the upstream C libraries independently of companion/Rust changes.
# Sourcing keeps the verified source and toolchain variables for packaging below.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/build-windows-libraries.sh"

cd "$repo"
bilikara_xtask libav-companion --prefix "$prefix" --out "$prefix/bin" --test \
  2>&1 | tee "$prefix/records/companion.log"
