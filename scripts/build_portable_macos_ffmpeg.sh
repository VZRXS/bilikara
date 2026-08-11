#!/bin/bash

set -euo pipefail

readonly FFMPEG_VERSION="8.1.2"
readonly FFMPEG_SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
readonly FFMPEG_SOURCE_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
readonly MACOS_DEPLOYMENT_TARGET="11.0"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Portable macOS FFmpeg must be built on macOS." >&2
  exit 1
fi

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: $0 OUTPUT_DIR" >&2
  exit 2
fi

output_dir="$1"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/bilikara-ffmpeg.XXXXXX")"
source_archive="$build_dir/ffmpeg-${FFMPEG_VERSION}.tar.xz"
source_dir="$build_dir/ffmpeg-${FFMPEG_VERSION}"

cleanup() {
  rm -rf "$build_dir"
}
trap cleanup EXIT

# Do not let Homebrew headers, libraries, pkg-config files, or tool shims leak
# into the release binary. Xcode Command Line Tools are build-time only.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH
unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR SDKROOT

/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors \
  "$FFMPEG_SOURCE_URL" \
  --output "$source_archive"

printf '%s  %s\n' "$FFMPEG_SOURCE_SHA256" "$source_archive" \
  | /usr/bin/shasum -a 256 --check --status

/usr/bin/tar -xf "$source_archive" -C "$build_dir"

configure_options=(
  "--prefix=$build_dir/install"
  "--cc=/usr/bin/clang"
  "--ar=/usr/bin/ar"
  "--nm=/usr/bin/nm"
  "--ranlib=/usr/bin/ranlib"
  "--strip=/usr/bin/strip"
  "--disable-autodetect"
  "--disable-debug"
  "--disable-doc"
  "--disable-ffplay"
  "--disable-shared"
  "--enable-static"
)

# FFmpeg's optimized x86 assembly requires NASM, which is not part of the
# macOS/Xcode system toolchain. Keep the release build independent of an
# unpinned Homebrew assembler; the resulting Intel binaries remain fully
# functional and report this choice in their captured configure string.
if [[ "$(uname -m)" == "x86_64" ]]; then
  configure_options+=("--disable-x86asm")
fi

(
  cd "$source_dir"
  ./configure "${configure_options[@]}"
  build_jobs="$(/usr/sbin/sysctl -n hw.logicalcpu 2>/dev/null || printf '2')"
  /usr/bin/make -j "$build_jobs" ffmpeg ffprobe
)

/bin/mkdir -p "$output_dir/bin" "$output_dir/licenses" "$output_dir/source"
/usr/bin/install -m 0755 "$source_dir/ffmpeg" "$output_dir/bin/ffmpeg"
/usr/bin/install -m 0755 "$source_dir/ffprobe" "$output_dir/bin/ffprobe"
/bin/cp "$source_archive" "$output_dir/source/ffmpeg-${FFMPEG_VERSION}.tar.xz"
/bin/cp "$source_dir/COPYING.LGPLv2.1" "$output_dir/licenses/COPYING.LGPLv2.1"

metadata_file="$output_dir/metadata.env"
printf '%s\n' \
  "BILIKARA_FFMPEG_SOURCE_VERSION=$FFMPEG_VERSION" \
  "BILIKARA_FFMPEG_SOURCE_URL=$FFMPEG_SOURCE_URL" \
  "BILIKARA_FFMPEG_SOURCE_SHA256=$FFMPEG_SOURCE_SHA256" \
  "BILIKARA_FFMPEG_SOURCE_ARCHIVE=$output_dir/source/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  "BILIKARA_FFMPEG_LICENSE_FILE=$output_dir/licenses/COPYING.LGPLv2.1" \
  > "$metadata_file"

"$output_dir/bin/ffmpeg" -version
"$output_dir/bin/ffprobe" -version
