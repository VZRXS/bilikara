# Rebuilding the pinned libav libraries and companion

The source kit contains the signed FFmpeg 9.0.1 archive, signature/key material,
the C shim, native Signalsmith C++ source/headers and MIT licenses, platform
recipes, and the independent locked `xtask` source.
Build on the matching native x64/ARM64 Windows MSVC or macOS/Linux runner, with
the repository Rust toolchain, C/C++17 compilers, shell/make, GPG and platform utilities.
Windows uses MSYS2 only for shell/make and native MSVC `/MD` for C compilation
and `/std:c++17 /MD /EHsc` for the companion DSP. POSIX builds honor `CXX`
(default `c++`) and link the OS C++ runtime; all platforms also link swresample.

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
links, source/licenses and actual libraries before restoring. The retired Python
companion builder is no longer included or needed. The kit's locked Rust tool
and platform recipes provide the library and companion rebuild entries.

The independent tool also prepares pinned BBDown 1.6.3 with `prepare-bbdown
OUTPUT_DIR`, using curl for HTTPS transfer and Rust for pinned SHA-256, ZIP and
native `--help` checks. Its MIT license is included under `third_party/`.
This command needs neither libav nor the application Runtime and is optional
for rebuilding the C libraries/companion.

## Android

The Android APK uses the same C/C++ companion with a small LGPL-only codec
profile, NDK **27.0.12077973**, API floor 24 and explicit 16 KiB ELF alignment.
Supported media ABIs are `arm64-v8a` and `x86_64`. Gradle's selected Tauri ABI
drives `app/media.gradle.kts`; desktop preparation remains independent.

From the source-kit root, with Rust, bash/make, curl, tar, gpg/gpgv and the
matching NDK host tools installed:

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- \
  android-libav --ndk /absolute/sdk/ndk/27.0.12077973 --abi arm64-v8a \
  --source-dir "$PWD/source" --cache /absolute/private/android-c-cache \
  --out /absolute/private/android-media
```

Omit `--source-dir` in the application checkout to fetch the pinned signed
archive. The digest and release-signing fingerprint are both verified before
extraction. `gpgv` checks public material without a signing agent. Windows
build hosts also need MSYS2 bash/make/GnuPG; NDK clang is selected explicitly.
`--cache-key` prints the upstream-C key; `--verify-only` validates an existing
output. Cache contents include only signed FFmpeg C sources/libraries, headers,
licenses and build records. Companion/DSP/Runtime edits do not change that key;
the companion is rebuilt separately with the current sources.

Generated `jniLibs/<abi>/` contains the four media libraries, companion and
NDK C++ shared runtime. `assets/bilikara-media/<abi>/` includes licenses, public
build metadata and the complete `source-kit.zip`, including the exact upstream
archive and native DSP/tool sources. Gradle extracts JNI libraries into the
application's trusted native-library directory. Do not substitute host libraries
or execute FFmpeg/ffprobe programs on the device.

最终 Android APK 校验（在签名/zipalign 校验后、上传前执行）：

```sh
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- verify-android-apk --ndk /absolute/sdk/ndk/27.0.12077973 --abi arm64-v8a --apk /absolute/app.apk
BILIKARA_TEST_ANDROID_NDK=/absolute/sdk/ndk/27.0.12077973 BILIKARA_TEST_ANDROID_APK=/absolute/app.apk npm run test:android-apk
```

该检查读取最终 ZIP，拒绝路径穿越、链接、重复项、过量内容和额外 ABI/原生库；使用固定 NDK 检查七个库的 ELF 架构、16 KiB LOAD 对齐及依赖闭包，确认 Rust shell 不链接 libav、companion 保留运行时导出。校验随包许可证、构建事实、重建包中的上游 SHA 与 DSP 源码清单。APK 签名与 ZIP 页面对齐仍由 Android build-tools 分别检查；这些检查不代表真机运行或后台/温升验收。
