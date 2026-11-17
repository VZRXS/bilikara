# Android libav construction

`xtask android-libav` builds FFmpeg 9.0.1 and the C/C++ media companion for Android
API 24, using NDK **27.0.12077973**. Supported APK ABIs are `arm64-v8a` and
`x86_64`. This is a host-native construction tool, independent of the application
Runtime and desktop preparation. The recipe is adapted from bilikara-next's
MIT implementation; its FFmpeg whitelist and upstream C cache identity remain
aligned with that implementation.

Install the repository's pinned Rust toolchain, Node version from `.nvmrc`, the
NDK, and `bash`, `make`, `gcc`, `tar`, `curl`, `gpg` and `gpgv`. On Windows use
MSYS2 for the POSIX tools and initialize the native MSVC environment before
building xtask. Put MSYS2 `usr/bin` on PATH after the MSVC tool directories.
Run Cargo from the checkout root. Pass absolute, non-overlapping NDK, output,
cache and optional source paths. Use the NDK's normal native path spelling;
the compiler discovers its own sysroot from its executable path. The tool keeps
canonical paths for validation and uses relative compiler inputs and outputs
under its owned build directory, without stripping Windows verbatim prefixes.
FFmpeg's embedded configure string uses the fixed logical prefix
`/bilikara-android-libav`; installation uses a separate temporary `DESTDIR`.
The temporary directory therefore does not become part of the library's
configuration or the companion's configuration handshake.

```text
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- android-libav --ndk <absolute-ndk> --abi arm64-v8a --out <absolute-output> --cache <absolute-cache>
```

For offline builds append `--source-dir <absolute-source-directory>` containing
all three original files: `ffmpeg-9.0.1.tar.xz`, `ffmpeg-9.0.1.tar.xz.asc`, and
`ffmpeg-devel.asc`. The archive must match SHA-256
`cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635` and its signature
must match fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` before extraction.
Without the option the tool downloads these pinned inputs from ffmpeg.org.

The default output is:

```text
<output>/
  build-info.json
  jniLibs/<abi>/
    libavformat.so
    libavcodec.so
    libavutil.so
    libswresample.so
    libbilikara_media_libav.so
    libc++_shared.so
  assets/bilikara-media/<abi>/
    build-info.json
    licenses/libav-source.txt
    licenses/libav/...
    licenses/THIRD_PARTY_NOTICES.md
  sources/bilikara-android-libav-9.0.1-<abi>-source-kit.zip
```

ELF verification checks the selected machine, LOAD alignment of at least 16 KB,
16 KB aligned GNU_RELRO end for our five built libraries, exact unversioned SONAME, declared dependencies
(these six libraries plus `libc.so`, `libm.so`, `libdl.so`), and companion
exports. `--verify-only` repeats these inspections and verifies the complete
output inventory. A failed build preserves the previous validated output;
unrelated or modified output directories are refused rather than overwritten.

Signalsmith is required by next's L1 pipeline and is enabled by default. The
`--with-signalsmith` flag is retained for explicit callers; it does not change
the upstream C cache key. The NDK's `libc++_shared.so` is copied from the selected
ABI sysroot and inspected for 16 KB LOAD alignment, SONAME and closed dependencies. It is exempt only from the FFmpeg-prefix requirement,
never the build-path scan. The required companion exports include both R1 cast
and next L0/L1/DSP entry points.

### Pinned NDK C++ runtime RELRO exception

Only the original, unstripped `libc++_shared.so` from NDK **27.0.12077973** may
use a RELRO end that is not a multiple of 16 KB. Both verifiers require the
exact ABI-specific SHA-256, the exact SONAME, all LOAD alignments at least
16 KB, and the actual safe segment layout. RELRO must end at its containing
LOAD's end; any following writable LOAD must start at or beyond that end
rounded up to 16 KB. Wrong identity, changed bytes or unsafe layout fails.

| ABI | Original runtime SHA-256 |
| --- | --- |
| arm64-v8a | `46b51d661454b9cfaf42c1dc90893b5ad601b7a7ffc2e09d44bb3cc9d20e7ae2` |
| x86_64 | `936e1150309bdae86216f14e493f478d39e588095f1577105856da6d0f24f149` |

This follows [Android's RELRO Example 4](https://developer.android.com/guide/practices/page-sizes#check-relro):
RELRO may fill an unaligned LOAD tail when later writable data occupies a
different 16 KB page. The linker can protect that page without covering writable
data. For example, the pinned arm64 runtime's RELRO and containing LOAD both
end at `0x143000`; its next writable LOAD starts at `0x146e40`, beyond `0x144000`.
This is a verified layout exception for Google's precompiled runtime, not a
general bypass or a claim that less memory protection is acceptable.

The emitted library facts explicitly mark `libc++_shared.so: RELRO alignment
accepted by pinned NDK runtime exception`, along with NDK version and hash.
NDK upgrades require independently verified new pins in both verifiers; never
strip or patch this runtime to make a mismatch pass. Gradle keeps debug symbols
only for this filename so APK packaging preserves the pinned bytes. Our other five media
libraries retain the strict 16 KB RELRO-end rule and all privacy checks remain.

## Cache and Gradle

Append `--cache-key` to the same command to print only
`key=android-libav-v1-<abi>-<sha256>`. This validates the selected NDK and reads
its compiler version but performs no download or build. Inputs are the pinned
source digest, NDK version, ABI, API 24, FFmpeg configure list, 16 KB page size
and compiler-version output. Changing application, Runtime or companion code
does not rotate this key. Compiler output can differ between host installations;
use the actual emitted key, not a guessed cross-host key.

Cache `<cache>/<key>/` contains only upstream C libraries, headers, signed
source, licenses and build records plus `cache-manifest.json`. Cache hits check
inventory, hashes, source identity and configuration and skip FFmpeg compilation.
The fixed-prefix and binary-path checks also run on cache hits. Older caches
with a machine-specific prefix are rejected with their path and instructions
to select a fresh `--cache` directory. The cache key format is unchanged; an
old cache is never silently reused or overwritten to bypass these checks.
The companion, licenses and source kit are rebuilt after a hit. Never cache
`jniLibs` or an application binary as part of this C cache.

`src-tauri/gen/android/app/media.gradle.kts` runs the host-native xtask before
`merge*JniLibFolders` and `merge*Assets`, with Tauri's `abiList`. It pins the NDK
and sets `packaging.jniLibs.useLegacyPackaging = true`, so the trusted Android
loader can access regular files in `ApplicationInfo.nativeLibraryDir`.

- Gradle output: `src-tauri/gen/android/app/build/generated/bilikara-media/<abi>/`.
- Default C cache: `src-tauri/gen/android/.gradle/bilikara-libav-cache`.
- `BILIKARA_ANDROID_LIBAV_CACHE`: optional absolute C cache directory.
- `BILIKARA_LIBAV_SOURCE_DIR`: optional absolute offline source directory.

Only the generated `jniLibs` and `assets` subdirectories enter the APK. Publish
the generated source-kit ZIP **separately beside the corresponding APK at the
same download location**. The APK's license notice identifies the exact ZIP,
upstream source, version, hash, signer and configure string. The ZIP includes
the original signed archive, licenses, configuration records, companion source,
xtask sources and lockfile, and `REBUILD-ANDROID.md`. Rebuild from the extracted
kit root with its `source/` directory and a fresh output/cache.
The 22 pinned Signalsmith files have exact-path LF rules in `.gitattributes`,
so Windows source kits preserve the upstream bytes recorded in `sources.json`.
Both the checkout and real source-kit tests verify all 22 file hashes.

The APK metadata binds the separate kit by filename and SHA-256. Validate both
files together; the verifier rejects embedded kits, a mismatched kit, missing
licenses, corrupt FFmpeg sources and altered DSP source inventory:

```text
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- verify-android-apk --ndk <absolute-ndk> --abi arm64-v8a --apk <absolute-apk> --source-kit <absolute-source-kit>
```

## Verification

```text
cargo test --manifest-path xtask/Cargo.toml --locked
npm run test:android-libav
npm run test:desktop-build
npm run tauri -- android build --debug --apk --target aarch64
```

`npm run test:android-libav` retains the required real NDK cold/hot build and
source-kit rebuild gate: set `BILIKARA_TEST_ANDROID_NDK` to the pinned NDK and
`BILIKARA_TEST_ANDROID_LIBAV_CACHE` to an absolute private cache; set
`BILIKARA_LIBAV_SOURCE_DIR` for offline inputs. Without real build prerequisites,
run only `node --test tests/android_libav_contract.test.mjs tests/android_media_check.test.mjs`
and report the missing real build explicitly.

`npm run test:android-apk` requires `BILIKARA_TEST_ANDROID_APK`,
`BILIKARA_TEST_ANDROID_NDK` and `BILIKARA_TEST_ANDROID_SOURCE_KIT` (the separate
matching ZIP). It checks final binary facts, source contents, corrupt inputs and
that verification never changes APK bytes.

Set `BILIKARA_TEST_ANDROID_LIBAV_DIR` to the absolute real-built
`<output>/jniLibs/<abi>` directory when running `npm run test:android-libav`.
This enables the binary-string acceptance test for the six real libraries:
it rejects build-directory/home paths and the current builder's username,
and requires the fixed FFmpeg prefix in FFmpeg and companion libraries. Without that input the real-library
test explicitly skips; synthetic ELF tests alone do not qualify this check.

After a real NDK build, repeat the xtask command with `--verify-only`; rerun
without that flag and confirm `Android libav C cache hit` with no FFmpeg rebuild.
For the resulting APK run the selected Android build-tools `apksigner verify`
and `zipalign -c -P 16 -v 4 <apk>`. Inspect the extracted six media libraries
with the selected NDK's `llvm-readelf -W -h -l -d`, and verify the APK's licenses
and absence of a source-kit ZIP in assets. The Rust application `.so` is an
additional APK library outside the six-library media output. Fixture tests
do not qualify an APK, Android loading, or physical DLNA operation.
