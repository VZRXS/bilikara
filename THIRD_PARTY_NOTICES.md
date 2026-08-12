# Third-Party Notices

This project, **bilikara**, may use, invoke, download, bundle, or interact with third-party software and services.

This file is intended to document known third-party components and legal notices. It is not a complete legal analysis. Redistributors and binary packagers must verify the exact components, versions, build options, and licenses included in their own distribution.

## 1. bilikara

- Project: bilikara
- Repository: https://github.com/VZRXS/bilikara
- License: MIT License
- License file: `LICENSE`

The MIT License applies to this project's own source code and documentation unless otherwise stated.

It does not apply to third-party tools, platform content, downloaded media, cached media, user-provided files, or content obtained from external services.

## 2. BBDown

- Project: BBDown
- Repository: https://github.com/nilaoda/BBDown
- Description: Bilibili downloader / parser command-line tool
- License: MIT License, according to the upstream repository at the time this notice was written
- Notes:
  - BBDown is an independent third-party project.
  - Packaged builds bundle the architecture-matched BBDown 1.6.3 release asset from upstream tag `1.6.3` / commit `45622f79cd766e0fc6f5cbd49fcf4960340f35c3`.
  - Release builds verify a pinned SHA-256 for each supported Windows and macOS asset and retain the selected URL, hash, version output, and MIT license in packaged compliance material.
  - Packaged runtime repair copies the immutable vendor executable to the writable tool directory and does not poll GitHub for a newer BBDown release.
  - Non-packaged development environments may still use the legacy online acquisition path when no local binary is available.
  - BBDown's README includes its own usage notice. Users and redistributors should review the upstream repository before use or redistribution.
  - Account data such as `BBDown.data`, cookies, or tokens may contain sensitive user information and must not be shared, committed, uploaded, or published.

## 3. FFmpeg and FFprobe

- Project: FFmpeg
- Website: https://ffmpeg.org/
- Legal information: https://ffmpeg.org/legal.html
- Description: Multimedia framework used for audio/video processing and media inspection
- License: Depends on build configuration

Important notes:

- FFmpeg is generally licensed under LGPL when built with LGPL-compatible options.
- Some optional components and build flags may cause a distributed FFmpeg binary to be licensed under GPL.
- Builds using nonfree components may have additional redistribution restrictions.
- Windows release bundles may include `ffmpeg` and `ffprobe` binaries from the build environment. The exact binary and license obligations depend on that build.
- macOS release bundles build FFmpeg and FFprobe from a versioned, SHA-256-pinned official FFmpeg source archive with external-library autodetection disabled. The exact source archive, applicable FFmpeg license text, source URL/hash, and generated `-version` configuration output are retained in the packaged compliance material.
- The bilikara build script rejects FFmpeg / FFprobe binaries whose version output contains `--enable-nonfree`.
- If the version output contains `--enable-gpl`, the build script prints a notice so the release maintainer can verify GPL redistribution obligations.
- The macOS build also rejects non-system Mach-O dependencies, including Homebrew Cellar paths and unresolved `@rpath` dependencies, before PyInstaller packaging.

If you bundle or redistribute FFmpeg / FFprobe with bilikara, you must verify the exact binaries you ship.

Recommended checks before publishing a release:

```bash
ffmpeg -version
ffprobe -version
```

Recommended release notes:

- Record where the bundled FFmpeg / FFprobe binaries came from, such as Homebrew, Chocolatey, a system package, or an official/static build.
- Preserve or link the relevant FFmpeg license and source information required by the FFmpeg build you redistribute.
- Do not assume that the MIT License for bilikara covers FFmpeg / FFprobe.

## 4. aria2c

- Project: aria2
- Repository: https://github.com/aria2/aria2
- Description: Experimental, opt-in transfer engine used by the DownKyi download source
- License: GPL-2.0-or-later

macOS packaged builds do not include aria2c by default. The manual Tool Assets workflow
builds an HTTP/HTTPS-focused portable executable from the SHA-256-pinned official aria2
1.37.0 source archive using AppleTLS and system libraries only. Application bundles consume
checked-in architecture-specific URL and SHA-256 locks; ordinary application CI does not
rebuild or republish the tool. The project-controlled mirror archive includes the upstream
license and provenance. It is downloaded only after the user selects DownKyi and confirms
preparation. Homebrew is an optional fallback, not a prerequisite.

## 5. Reqwest

- Project: Reqwest
- Repository: https://github.com/seanmonstar/reqwest
- Description: Rust HTTP client used by the native media downloader
- License: MIT License or Apache License 2.0

The native downloader is an independent bilikara implementation. It does not
port or link aria2 source code. Reqwest and its transitive dependencies are
distributed under their respective licenses.

## 6. PyInstaller

- Project: PyInstaller
- Website: https://pyinstaller.org/
- Description: Packaging tool used to build executable bundles
- License: GPL 2.0 or later with the PyInstaller bootloader exception, plus Apache-licensed portions as documented by PyInstaller

Notes:

- PyInstaller is used only for packaging bilikara releases.
- PyInstaller's bootloader exception allows distributing executable bundles generated from your own code under your chosen license, provided you comply with the licenses of your dependencies.
- If you modify PyInstaller itself, review PyInstaller's own license terms.

## 7. Truststore

- Project: truststore
- Repository: https://github.com/sethmlarson/truststore
- Description: Native operating-system certificate-store integration for packaged macOS HTTPS
- License: MIT License

The packaged macOS backend uses truststore so strict Python HTTPS validation follows the effective macOS system trust configuration. It does not disable certificate or hostname verification.

## 8. Bilibili and External Services

- Bilibili: bilikara can parse Bilibili URLs, use Bilibili embedded playback, interact with Bilibili APIs, and rely on user-provided account login data.
- GitHub: non-packaged development mode may use GitHub Releases to acquire BBDown; packaged builds do not poll for BBDown updates. aria2 release metadata is checked for an official matching asset before the project mirror is used.
- QR code generation: bilikara may use an external QR-code generation endpoint for LAN remote-control links.

These services are independent third parties. bilikara is not affiliated with, endorsed by, sponsored by, or officially associated with them.

Use of these services may be subject to their own terms, rate limits, access restrictions, privacy policies, and legal requirements. bilikara does not grant any license to platform content, media, accounts, APIs, paid access, or service names and trademarks.
