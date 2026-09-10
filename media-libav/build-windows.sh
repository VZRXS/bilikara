#!/usr/bin/env bash
# Windows runner only: MSYS2 provides shell/make, MSVC builds all native code.
set -euo pipefail
case "${VSCMD_ARG_TGT_ARCH:-}" in
  x64) ffmpeg_arch=x86_64; rust_arch=x86_64; asm_flag=--disable-x86asm ;;
  arm64) ffmpeg_arch=aarch64; rust_arch=aarch64; asm_flag=--disable-asm ;;
  *) echo 'Expected native x64 or ARM64 MSVC environment' >&2; exit 1 ;;
esac
export BILIKARA_LIBAV_TARGET="$rust_arch-pc-windows-msvc"
repo="$(pwd)"
python_bin="$(cygpath -u "$pythonLocation")/python.exe"
prefix="$(cygpath -m "$BILIKARA_LIBAV_PREFIX")"
work="$(cygpath -u "$RUNNER_TEMP")/bilikara-ffmpeg-source"
compiler_dir="$(cygpath -u "$VCToolsInstallDir")/bin/Host${VSCMD_ARG_HOST_ARCH}/${VSCMD_ARG_TGT_ARCH}"
export PATH="$compiler_dir:$PATH"
mkdir -p "$prefix/source" "$prefix/licenses" "$prefix/records" "$work"
trap 'test ! -f "$work/ffmpeg-9.0.1/ffbuild/config.log" || cp "$work/ffmpeg-9.0.1/ffbuild/config.log" "$prefix/records/config.log"' EXIT
version=9.0.1
url="https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz"
curl --fail --location --retry 5 "$url" -o "$prefix/source/ffmpeg-${version}.tar.xz"
curl --fail --location --retry 5 "$url.asc" -o "$prefix/source/ffmpeg-${version}.tar.xz.asc"
curl --fail --location --retry 5 https://ffmpeg.org/ffmpeg-devel.asc -o "$prefix/source/ffmpeg-devel.asc"
# Same pinned official release signer used by the accepted Linux 9.0.1 build.
mkdir -p "$work/keyring"
chmod 700 "$work/keyring"
gpg --homedir "$work/keyring" --batch --import "$prefix/source/ffmpeg-devel.asc"
gpg --homedir "$work/keyring" --batch --status-fd 1 --verify \
  "$prefix/source/ffmpeg-${version}.tar.xz.asc" "$prefix/source/ffmpeg-${version}.tar.xz" \
  > "$prefix/records/signature.log" 2>&1
grep -F '[GNUPG:] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' "$prefix/records/signature.log"
# GNU tar must treat the Windows drive-letter archive path as a local file.
tar --force-local -xf "$prefix/source/ffmpeg-${version}.tar.xz" -C "$work"
cd "$work/ffmpeg-${version}"
# Preserve the accepted codec/demuxer corpus; no --disable-everything pruning.
# /MD is required: fd protocol and companion must share the UCRT fd table.
./configure --prefix="$prefix" --toolchain=msvc --arch="$ffmpeg_arch" --target-os=win64 \
  --extra-cflags=-MD --extra-cxxflags=-MD --disable-autodetect --disable-debug \
  --disable-doc --disable-ffplay --disable-static --enable-shared "$asm_flag" \
  --disable-avdevice --disable-swscale --enable-swresample --disable-network \
  2>&1 | tee "$prefix/records/configure.log"
make -j4 2>&1 | tee "$prefix/records/build.log"
make install 2>&1 | tee "$prefix/records/install.log"
cp COPYING* LICENSE.md "$prefix/licenses/"
cp config.h config_components.h ffbuild/config.mak "$prefix/records/"
cd "$repo"
"$python_bin" media-libav/build.py --prefix "$prefix" --out "$prefix/bin" --test \
  2>&1 | tee "$prefix/records/companion.log"
cp "$prefix/bin/build-info.json" "$prefix/build-info.json"
cp "$prefix/bin/build_config.h" "$prefix/records/companion-build-config.h"
cl.exe 2>&1 | head -n 2 > "$prefix/records/msvc-version.txt" || true
rustc -vV > "$prefix/records/rust-version.txt"
"$python_bin" - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['BILIKARA_LIBAV_PREFIX'])
data = json.loads((p/'build-info.json').read_text())
data.update(target=os.environ['BILIKARA_LIBAV_TARGET'], source_url='https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz',
            release_signer='FCF986EA15E6E293A5644F10B4322F04D67658D8',
            toolchain='MSVC /MD; MSYS2 shell/make only',
            vc_tools_version=os.environ['VCToolsVersion'], windows_sdk=os.environ['WindowsSDKVersion'])
(p/'build-info.json').write_text(json.dumps(data, indent=2)+'\n', encoding='utf-8')
PY
