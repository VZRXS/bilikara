#!/usr/bin/env bash
# Native Linux/macOS build from the same signed source used on Windows.
set -euo pipefail
repo="$(pwd)"
prefix="${BILIKARA_LIBAV_PREFIX:?Explicit private build prefix required}"
work="${RUNNER_TEMP:-/tmp}/bilikara-ffmpeg-source"
version=9.0.1
mkdir -p "$prefix/source" "$prefix/licenses" "$prefix/records" "$prefix/driver" "$work/keyring"
chmod 700 "$work/keyring"
url="https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz"
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
  --disable-ffplay --disable-static --enable-shared --disable-x86asm --disable-avdevice \
  --disable-swscale --enable-swresample --disable-network "${extra[@]}" \
  2>&1 | tee "$prefix/records/configure.log"
make -j4 2>&1 | tee "$prefix/records/build.log"
make install 2>&1 | tee "$prefix/records/install.log"
cp COPYING* LICENSE.md "$prefix/licenses/"
cp config.h config_components.h ffbuild/config.mak "$prefix/records/"
cd "$repo"
python media-libav/build.py --prefix "$prefix" --out "$prefix/bin" --test 2>&1 | tee "$prefix/records/companion.log"
cp "$prefix/bin/build-info.json" "$prefix/build-info.json"
cp "$prefix/bin/build_config.h" "$prefix/records/companion-build-config.h"
cargo build --manifest-path rust-runtime/Cargo.toml --release --locked --example libav_metadata
cp rust-runtime/target/release/examples/libav_metadata "$prefix/driver/"
cargo test --manifest-path rust-runtime/Cargo.toml --release --locked --lib --no-run --message-format=json > "$prefix/records/runtime-test-build.jsonl"
python - <<'PY'
import json, os, shutil
from pathlib import Path
from scripts.libav_bundle import native_target
p = Path(os.environ['BILIKARA_LIBAV_PREFIX'])
records = [json.loads(line) for line in (p/'records/runtime-test-build.jsonl').read_text().splitlines()]
tests = [r['executable'] for r in records if r.get('reason') == 'compiler-artifact' and r['target']['name'] == 'bilikara_runtime' and r['profile']['test'] and r.get('executable')]
assert len(tests) == 1, 'Expected one native Runtime library test executable'
shutil.copy2(tests[0], p/'driver/libav-runtime-tests')
data = json.loads((p/'build-info.json').read_text())
data.update(target=native_target(), source_url='https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz', release_signer='FCF986EA15E6E293A5644F10B4322F04D67658D8')
(p/'build-info.json').write_text(json.dumps(data, indent=2)+'\n')
PY
python -m scripts.libav_bundle collect "$prefix"
if [ -n "${GITHUB_ENV:-}" ]; then
  cat >> "$GITHUB_ENV" <<EOF
BILIKARA_FFMPEG_SOURCE_VERSION=9.0.1
BILIKARA_FFMPEG_SOURCE_URL=$url
BILIKARA_FFMPEG_SOURCE_ARCHIVE=$prefix/source/ffmpeg-9.0.1.tar.xz
BILIKARA_FFMPEG_LICENSE_FILE=$prefix/licenses/COPYING.LGPLv2.1
EOF
fi
