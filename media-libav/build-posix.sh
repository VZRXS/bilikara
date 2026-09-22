#!/usr/bin/env bash
# Build/cache the upstream C libraries independently of companion/Rust changes.
# Sourcing keeps the verified source and toolchain variables for packaging below.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/build-posix-libraries.sh"

cd "$repo"
mkdir -p "$prefix/driver"
python media-libav/build.py --prefix "$prefix" --out "$prefix/bin" --test 2>&1 | tee "$prefix/records/companion.log"
cp "$prefix/bin/build-info.json" "$prefix/build-info.json"
cp "$prefix/bin/build_config.h" "$prefix/records/companion-build-config.h"
# Match the packaged backend so its optimized Runtime library can be reused.
cargo build --manifest-path rust-runtime/Cargo.toml --release --locked --features native-host --example libav_metadata
cp rust-runtime/target/release/examples/libav_metadata "$prefix/driver/"
cargo test --manifest-path rust-runtime/Cargo.toml --release --locked --features native-host --lib --no-run --message-format=json > "$prefix/records/runtime-test-build.jsonl"
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
