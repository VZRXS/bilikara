#!/usr/bin/env bash
# Native Linux/macOS build from the same signed source used on Windows.
set -euo pipefail
repo="$(pwd)"
source "$repo/media-libav/xtask.sh"
prefix="${BILIKARA_LIBAV_PREFIX:?Explicit private build prefix required}"
work="${RUNNER_TEMP:-/tmp}/bilikara-ffmpeg-source"
paths=(libav-cache check-paths "$prefix" "$work")
if [ -n "${BILIKARA_LIBAV_CACHE:-}" ]; then paths+=("$BILIKARA_LIBAV_CACHE"); fi
bilikara_xtask "${paths[@]}"
version=9.0.1
url="https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz"
if [ "${BILIKARA_LIBAV_CACHE_HIT:-false}" = true ]; then
  bilikara_xtask libav-cache restore "$BILIKARA_LIBAV_CACHE" "$prefix"
else
  mkdir -p "$prefix/source" "$prefix/licenses" "$prefix/records" "$prefix/driver" "$work/keyring"
  chmod 700 "$work/keyring"
  if [ -n "${BILIKARA_LIBAV_SOURCE_DIR:-}" ]; then
    for name in "ffmpeg-${version}.tar.xz" "ffmpeg-${version}.tar.xz.asc" ffmpeg-devel.asc; do
      cp "$BILIKARA_LIBAV_SOURCE_DIR/$name" "$prefix/source/$name"
    done
  else
    curl --fail --location --retry 5 "$url" -o "$prefix/source/ffmpeg-${version}.tar.xz"
    curl --fail --location --retry 5 "$url.asc" -o "$prefix/source/ffmpeg-${version}.tar.xz.asc"
    curl --fail --location --retry 5 https://ffmpeg.org/ffmpeg-devel.asc -o "$prefix/source/ffmpeg-devel.asc"
  fi
  # Public-key verification needs no signing agent (nor its short socket path).
  gpg --homedir "$work/keyring" --no-autostart --batch --import "$prefix/source/ffmpeg-devel.asc"
  gpg --homedir "$work/keyring" --no-autostart --batch --status-fd 1 --verify \
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
  # FFmpeg splits extra flags on whitespace. For a prefix with spaces, keep
  # the same linker arguments in a compiler response file instead of letting
  # the path become multiple arguments. No eval or shell-string execution.
  if [[ "$prefix" == *[[:space:]]* ]]; then
    linker_flag="-Wl,-rpath,$prefix/lib"
    linker_flag="${linker_flag//\\/\\\\}"
    linker_flag="${linker_flag//\"/\\\"}"
    printf '"%s"\n' "$linker_flag" > libav-linker-flags.rsp
    if [ "$(uname -s)" = Darwin ]; then
      printf '%s\n' '-Wl,-headerpad_max_install_names' >> libav-linker-flags.rsp
      extra=(--install-name-dir=@rpath --extra-ldflags=@libav-linker-flags.rsp)
    else
      extra=(--extra-ldflags=@libav-linker-flags.rsp)
    fi
  fi
  ./configure --prefix="$prefix" --disable-autodetect --disable-debug --disable-doc \
    --disable-programs --disable-static --enable-shared --disable-x86asm --disable-avdevice \
    --disable-swscale --enable-swresample --disable-network "${extra[@]}" \
    2>&1 | tee "$prefix/records/configure.log"
  make -j4 2>&1 | tee "$prefix/records/build.log"
  make install 2>&1 | tee "$prefix/records/install.log"
  cp COPYING* LICENSE.md "$prefix/licenses/"
  cp config.h config_components.h ffbuild/config.mak "$prefix/records/"
  cp ffbuild/config.log "$prefix/records/config.log"
  if [ -f libav-linker-flags.rsp ]; then cp libav-linker-flags.rsp "$prefix/records/"; fi
  if [ -n "${BILIKARA_LIBAV_CACHE:-}" ]; then
    bilikara_xtask libav-cache snapshot "$prefix" "$BILIKARA_LIBAV_CACHE"
  fi
fi
