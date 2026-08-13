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

ORIGINAL_PATH="$PATH"
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

export PATH="$ORIGINAL_PATH"

machine="$(uname -m)"
case "$machine" in
  arm64) target_arch="arm64" ;;
  x86_64) target_arch="x64" ;;
  *)
    echo "Unsupported macOS FFmpeg architecture: $machine" >&2
    exit 1
    ;;
esac

readonly DEFAULT_PUBLIC_BASE="https://download.kevinx96.icu/bilikara/tools"
readonly BUILD_RECIPE_REVISION="portable-macos-ffmpeg-v1"

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

/usr/bin/codesign --force --sign - --timestamp=none "$output_dir/bin/ffmpeg"
/usr/bin/codesign --force --sign - --timestamp=none "$output_dir/bin/ffprobe"
/usr/bin/codesign --verify --strict --verbose=4 "$output_dir/bin/ffmpeg"
/usr/bin/codesign --verify --strict --verbose=4 "$output_dir/bin/ffprobe"

for binary in "$output_dir/bin/ffmpeg" "$output_dir/bin/ffprobe"; do
  dependencies="$(/usr/bin/otool -L "$binary")"
  printf '%s\n' "$dependencies"
  if printf '%s\n' "$dependencies" | /usr/bin/grep -E \
    '(@rpath|/opt/homebrew/|/usr/local/Cellar/|/opt/homebrew/Cellar/)' >/dev/null; then
    echo "FFmpeg binary $binary has a non-portable Homebrew or unresolved rpath dependency" >&2
    exit 1
  fi
done

printf '%s\n' \
  "FFmpeg portable runtime provenance" \
  "version=$FFMPEG_VERSION" \
  "official_source_url=$FFMPEG_SOURCE_URL" \
  "official_source_sha256=$FFMPEG_SOURCE_SHA256" \
  "build_recipe_revision=$BUILD_RECIPE_REVISION" \
  "architecture=$target_arch" \
  "deployment_target=$MACOS_DEPLOYMENT_TARGET" \
  > "$output_dir/PROVENANCE.txt"

archive_staging="$output_dir/ffmpeg-${FFMPEG_VERSION}-macos-${target_arch}.tar.gz.partial"
COPYFILE_DISABLE=1 /usr/bin/tar -cf - -C "$output_dir" bin licenses source PROVENANCE.txt \
  | /usr/bin/gzip -n > "$archive_staging"
archive_sha256="$(/usr/bin/shasum -a 256 "$archive_staging" | /usr/bin/awk '{print $1}')"
asset_name="ffmpeg-${FFMPEG_VERSION}-macos-${target_arch}-${archive_sha256}.tar.gz"
/bin/mv "$archive_staging" "$output_dir/$asset_name"

public_base="${BILIKARA_TOOL_ASSET_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"
public_base="${public_base%/}"
object_key="bilikara/tools/ffmpeg/${FFMPEG_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${asset_name}"
metadata_object_key="bilikara/tools/ffmpeg/${FFMPEG_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${archive_sha256}.json"
asset_url="${public_base}/ffmpeg/${FFMPEG_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${asset_name}"

python_cmd="$(command -v python3 || command -v python || echo "python3")"
"$python_cmd" - \
  "$output_dir/ffmpeg-macos-${target_arch}.json" \
  "$target_arch" "$asset_name" "$asset_url" "$archive_sha256" \
  "$FFMPEG_VERSION" "$FFMPEG_SOURCE_URL" "$FFMPEG_SOURCE_SHA256" \
  "$BUILD_RECIPE_REVISION" "$object_key" "$metadata_object_key" \
  <<'PY'
import json
import sys

(
    output_path,
    arch,
    name,
    url,
    sha256,
    version,
    source_url,
    source_sha256,
    recipe_revision,
    object_key,
    metadata_object_key,
) = sys.argv[1:]
payload = {
    "schema_version": 2,
    "tool": "ffmpeg",
    "provider": "bilikara-r2",
    "platform": "darwin",
    "arch": arch,
    "name": name,
    "url": url,
    "sha256": sha256,
    "version": version,
    "source_url": source_url,
    "source_sha256": source_sha256,
    "recipe_revision": recipe_revision,
    "object_key": object_key,
    "metadata_object_key": metadata_object_key,
}
with open(output_path, "w", encoding="utf-8", newline="\n") as output:
    json.dump(payload, output, ensure_ascii=True, indent=2, sort_keys=True)
    output.write("\n")
PY

printf '%s\n' "$asset_name" > "$output_dir/asset-name.txt"
printf '%s\n' "$archive_sha256" > "$output_dir/asset-sha256.txt"
printf 'Portable FFmpeg archive: %s\n' "$output_dir/$asset_name"

