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
  - bilikara may download, bundle, or invoke BBDown for media parsing, downloading, login, or caching workflows.
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
- bilikara release bundles may include `ffmpeg` and `ffprobe` binaries from the build machine. The exact binary and license obligations depend on that build.
- The bilikara build script rejects FFmpeg / FFprobe binaries whose version output contains `--enable-nonfree`.
- If the version output contains `--enable-gpl`, the build script prints a notice so the release maintainer can verify GPL redistribution obligations.

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

## 4. PyInstaller

- Project: PyInstaller
- Website: https://pyinstaller.org/
- Description: Packaging tool used to build executable bundles
- License: GPL 2.0 or later with the PyInstaller bootloader exception, plus Apache-licensed portions as documented by PyInstaller

Notes:

- PyInstaller is used only for packaging bilikara releases.
- PyInstaller's bootloader exception allows distributing executable bundles generated from your own code under your chosen license, provided you comply with the licenses of your dependencies.
- If you modify PyInstaller itself, review PyInstaller's own license terms.

## 5. Bilibili and External Services

- Bilibili: bilikara can parse Bilibili URLs, use Bilibili embedded playback, interact with Bilibili APIs, and rely on user-provided account login data.
- GitHub: bilikara may check GitHub Releases to download or update BBDown.
- QR code generation: bilikara may use an external QR-code generation endpoint for LAN remote-control links.

These services are independent third parties. bilikara is not affiliated with, endorsed by, sponsored by, or officially associated with them.

Use of these services may be subject to their own terms, rate limits, access restrictions, privacy policies, and legal requirements. bilikara does not grant any license to platform content, media, accounts, APIs, paid access, or service names and trademarks.
