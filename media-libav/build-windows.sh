#!/usr/bin/env bash
# Build/cache the upstream C libraries independently of companion/Rust changes.
# Sourcing keeps the verified source and toolchain variables for packaging below.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/build-windows-libraries.sh"

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
