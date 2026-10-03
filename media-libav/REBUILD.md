# Rebuilding the pinned libav libraries and companion

The source kit contains the signed FFmpeg 9.0.1 archive, signature/key material,
the existing C shim, platform recipes, and the independent locked `xtask` source.
Build on the matching native x64/ARM64 Windows MSVC or macOS/Linux runner, with
the repository Rust toolchain, C compiler, shell/make, GPG and platform utilities.
Windows uses MSYS2 only for shell/make and native MSVC `/MD` for C compilation.

From the source-kit root (the directory containing `media-libav/` and `xtask/`),
select an absolute private generated prefix and an independent work directory:

```sh
export BILIKARA_LIBAV_PREFIX=/absolute/generated/libav-prefix
export RUNNER_TEMP=/absolute/generated/libav-work
# Optional local archive input; signatures are still checked against the pin.
export BILIKARA_LIBAV_SOURCE_DIR="$PWD"
bash media-libav/build-posix-libraries.sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- \
  libav-companion --prefix "$BILIKARA_LIBAV_PREFIX" --out "$BILIKARA_LIBAV_PREFIX/bin" --test
```

On Windows, first enter the matching native MSVC environment, then use
`build-windows-libraries.sh` inside MSYS2 and the same `libav-companion` command.
The full repository's `build-posix.sh` / `build-windows.sh` and
`prepare-windows.ps1` also build current Runtime verification drivers and collect
the prepared release closure. Those full-prefix stages require the matching
application source checkout; the compliance kit does not include the application
Runtime or its binaries. The library/companion commands above work independently.

Cache operations use `xtask libav-cache`, snapshot upstream C outputs before
companion/driver construction, and validate target/toolchain, hashes, paths,
links, source/licenses and actual libraries before restoring. Historical
`build.py` is a frozen reference, not a fallback. Copied Python source is legal
rebuild/reference material; these normal build entries do not execute it.
