#!/bin/bash
set -euo pipefail

readonly ARIA2_VERSION="1.37.0"
readonly ARIA2_SOURCE_URL="https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}.tar.xz"
readonly ARIA2_SOURCE_SHA256="60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"
readonly DEFAULT_PUBLIC_BASE="https://download.kevinx96.icu/bilikara/tools"
readonly BUILD_RECIPE_REVISION="portable-macos-appletls-v2"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Portable aria2c builds must run on macOS" >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT_DIR" >&2
  exit 2
fi

output_dir="$1"

machine="$(uname -m)"
case "$machine" in
  arm64) target_arch="arm64" ;;
  x86_64) target_arch="x64" ;;
  *)
    echo "Unsupported macOS aria2c architecture: $machine" >&2
    exit 1
    ;;
esac

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
source_archive="$build_dir/aria2-${ARIA2_VERSION}.tar.xz"
source_dir="$build_dir/aria2-${ARIA2_VERSION}"
stage_dir="$build_dir/stage"
package_dir="$build_dir/package"

/usr/bin/curl \
  --fail \
  --location \
  --retry 3 \
  --show-error \
  --silent \
  "$ARIA2_SOURCE_URL" \
  --output "$source_archive"

printf '%s  %s\n' "$ARIA2_SOURCE_SHA256" "$source_archive" \
  | /usr/bin/shasum -a 256 -c -
/usr/bin/tar -xf "$source_archive" -C "$build_dir"

export MACOSX_DEPLOYMENT_TARGET="11.0"
export COPYFILE_DISABLE="1"
export CC="/usr/bin/clang"
export CXX="/usr/bin/clang++"
export CFLAGS="-Os -fPIE -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"
export CXXFLAGS="-Os -fPIE -stdlib=libc++ -std=c++11 -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"
export LDFLAGS="-Wl,-dead_strip -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET}"

mkdir -p "$stage_dir"
cd "$source_dir"
./configure \
  --prefix="$stage_dir" \
  --enable-static \
  --disable-shared \
  --disable-nls \
  --disable-bittorrent \
  --disable-metalink \
  --with-appletls \
  --with-libz \
  --without-libxml2 \
  --without-libexpat \
  --without-sqlite3 \
  --without-libcares \
  --without-libssh2 \
  --without-libgmp \
  --without-libgcrypt \
  --without-libuv \
  --without-gnutls \
  --without-openssl \
  --without-libnettle \
  ARIA2_STATIC=yes

cpu_count="$(/usr/sbin/sysctl -n hw.ncpu)"
/usr/bin/make -j"$cpu_count"
/usr/bin/make install-strip

aria2_binary="$stage_dir/bin/aria2c"
test -x "$aria2_binary"
"$aria2_binary" --version
/usr/bin/codesign --force --sign - --timestamp=none "$aria2_binary"
/usr/bin/codesign --verify --strict --verbose=4 "$aria2_binary"

dependencies="$(/usr/bin/otool -L "$aria2_binary")"
printf '%s\n' "$dependencies"
if printf '%s\n' "$dependencies" | /usr/bin/grep -E \
  '(@rpath|/opt/homebrew/|/usr/local/Cellar/|/opt/homebrew/Cellar/)' >/dev/null; then
  echo "aria2c has a non-portable Homebrew or unresolved rpath dependency" >&2
  exit 1
fi
if printf '%s\n' "$dependencies" | /usr/bin/tail -n +2 | /usr/bin/awk \
  '{print $1}' | /usr/bin/grep -Ev '^(/usr/lib/|/System/Library/)' >/dev/null; then
  echo "aria2c has a non-system dynamic dependency" >&2
  exit 1
fi

file_output="$(/usr/bin/file "$aria2_binary")"
printf '%s\n' "$file_output"
if ! printf '%s\n' "$file_output" | /usr/bin/grep -F "$machine" >/dev/null; then
  echo "aria2c does not contain the expected $machine architecture" >&2
  exit 1
fi

mkdir -p "$package_dir" "$output_dir"
/bin/cp "$aria2_binary" "$package_dir/aria2c"
/bin/cp "$source_dir/COPYING" "$package_dir/COPYING"
printf '%s\n' \
  "aria2c portable runtime provenance" \
  "version=$ARIA2_VERSION" \
  "official_source_url=$ARIA2_SOURCE_URL" \
  "official_source_sha256=$ARIA2_SOURCE_SHA256" \
  "build_recipe_revision=$BUILD_RECIPE_REVISION" \
  "architecture=$target_arch" \
  "deployment_target=$MACOSX_DEPLOYMENT_TARGET" \
  "tls_backend=AppleTLS" \
  "features=HTTP/HTTPS (BitTorrent, Metalink, SFTP, and external libraries disabled)" \
  > "$package_dir/PROVENANCE.txt"

archive_staging="$output_dir/aria2-${ARIA2_VERSION}-macos-${target_arch}.tar.gz.partial"
COPYFILE_DISABLE=1 /usr/bin/tar -cf - -C "$package_dir" aria2c COPYING PROVENANCE.txt \
  | /usr/bin/gzip -n > "$archive_staging"
archive_sha256="$(/usr/bin/shasum -a 256 "$archive_staging" | /usr/bin/awk '{print $1}')"
asset_name="aria2-${ARIA2_VERSION}-macos-${target_arch}-${archive_sha256}.tar.gz"
/bin/mv "$archive_staging" "$output_dir/$asset_name"
public_base="${BILIKARA_TOOL_ASSET_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"
public_base="${public_base%/}"
object_key="bilikara/tools/aria2/${ARIA2_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${asset_name}"
metadata_object_key="bilikara/tools/aria2/${ARIA2_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${archive_sha256}.json"
asset_url="${public_base}/aria2/${ARIA2_VERSION}/${BUILD_RECIPE_REVISION}/macos-${target_arch}/${asset_name}"

python - \
  "$output_dir/aria2-macos-${target_arch}.json" \
  "$target_arch" "$asset_name" "$asset_url" "$archive_sha256" \
  "$ARIA2_VERSION" "$ARIA2_SOURCE_URL" "$ARIA2_SOURCE_SHA256" \
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
    "tool": "aria2c",
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
printf 'Portable aria2c archive: %s\n' "$output_dir/$asset_name"
