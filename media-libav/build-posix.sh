#!/usr/bin/env bash
# Build/cache the upstream C libraries independently of companion/Rust changes.
# Sourcing keeps the verified source and toolchain variables for packaging below.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/build-posix-libraries.sh"

cd "$repo"
mkdir -p "$prefix/driver"
bilikara_xtask libav-companion --prefix "$prefix" --out "$prefix/bin" --test 2>&1 | tee "$prefix/records/companion.log"
bilikara_xtask libav-finish --prefix "$prefix"
if [ -n "${GITHUB_ENV:-}" ]; then
  cat >> "$GITHUB_ENV" <<EOF
BILIKARA_FFMPEG_SOURCE_VERSION=9.0.1
BILIKARA_FFMPEG_SOURCE_URL=$url
BILIKARA_FFMPEG_SOURCE_ARCHIVE=$prefix/source/ffmpeg-9.0.1.tar.xz
BILIKARA_FFMPEG_LICENSE_FILE=$prefix/licenses/COPYING.LGPLv2.1
EOF
fi
