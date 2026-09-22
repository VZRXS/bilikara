#!/usr/bin/env bash
# Native Linux/macOS build from the same signed source used on Windows.
set -euo pipefail
repo="$(pwd)"
prefix="${BILIKARA_LIBAV_PREFIX:?Explicit private build prefix required}"
work="${RUNNER_TEMP:-/tmp}/bilikara-ffmpeg-source"
version=9.0.1
url="https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz"
if [ "${BILIKARA_LIBAV_CACHE_HIT:-false}" = true ]; then
  python "$repo/scripts/libav_cache.py" restore "$BILIKARA_LIBAV_CACHE" "$prefix"
else
  mkdir -p "$prefix/source" "$prefix/licenses" "$prefix/records" "$prefix/driver" "$work/keyring"
  chmod 700 "$work/keyring"
  curl --fail --location --retry 5 "$url" -o "$prefix/source/ffmpeg-${version}.tar.xz"
  curl --fail --location --retry 5 "$url.asc" -o "$prefix/source/ffmpeg-${version}.tar.xz.asc"
  curl --fail --location --retry 5 https://ffmpeg.org/ffmpeg-devel.asc -o "$prefix/source/ffmpeg-devel.asc"
  gpg --homedir "$work/keyring" --batch --import "$prefix/source/ffmpeg-devel.asc"
  gpg --homedir "$work/keyring" --batch --status-fd 1 --verify \
    "$prefix/source/ffmpeg-${version}.tar.xz.asc" "$prefix/source/ffmpeg-${version}.tar.xz" \
    > "$prefix/records/signature.log" 2>&1
  grep -F '[GNUPG:] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' "$prefix/records/signature.log"
  tar -xf "$prefix/source/ffmpeg-${version}.tar.xz" -C "$work"
  cd "$work/ffmpeg-${version}"
  trap 'test ! -f ffbuild/config.log || cp ffbuild/config.log "$prefix/records/config.log"' EXIT
  extra=()
  if [ "$(uname -s)" = Darwin ]; then
    extra+=(--install-name-dir=@rpath "--extra-ldflags=-Wl,-rpath,$prefix/lib -Wl,-headerpad_max_install_names")
  else
    extra+=("--extra-ldflags=-Wl,-rpath,$prefix/lib")
  fi
  ./configure --prefix="$prefix" --disable-autodetect --disable-debug --disable-doc \
    --disable-programs --disable-static --enable-shared --disable-x86asm --disable-avdevice \
    --disable-swscale --enable-swresample --disable-network "${extra[@]}" \
    2>&1 | tee "$prefix/records/configure.log"
  make -j4 2>&1 | tee "$prefix/records/build.log"
  make install 2>&1 | tee "$prefix/records/install.log"
  cp COPYING* LICENSE.md "$prefix/licenses/"
  cp config.h config_components.h ffbuild/config.mak "$prefix/records/"
  if [ -n "${BILIKARA_LIBAV_CACHE:-}" ]; then
    python "$repo/scripts/libav_cache.py" snapshot "$prefix" "$BILIKARA_LIBAV_CACHE"
  fi
fi
