# Mobile Host and Shared Rust Architecture

## Product Model
1. Android and iOS will eventually provide the complete Host functionality.
2. Mobile Host must work without a computer.
3. The actual Remote remains a pure webpage served by the Host.
4. APK and IPA artifacts will be distributed through GitHub rather than application stores.

## Runtime Model
1. Rust is the eventual canonical backend shared by:
   - Windows
   - Linux
   - macOS
   - Android
   - iOS
2. Mobile production builds must not depend on Python.
3. Mobile production builds must not require child processes, sidecars, or command-line executables.
4. Python remains temporarily for:
   - desktop HTTP/SSE and compatibility transport
   - persistence and external-tool I/O orchestration
   - reference implementations
   - development and build tooling
   Rust AppState is the sole mutable application authority during v0.8
   convergence. AppState unavailability fails startup; there is no Python Core
   startup mode and no per-operation stateful fallback. Python remains packaged
   until the separate D0 compiled-only build/launch contract is completed.
5. Tauri provides:
   - the native application shell
   - the system WebView
   - frontend-to-Rust commands and events
   - packaging
   - platform plugin integration
6. Swift and Kotlin are restricted to platform adapters such as:
   - local-network permissions
   - application lifecycle
   - screen wake locks
   - audio session/focus
   - notifications
   - other platform APIs
7. Pure domain logic in the shared `rust/` crate must not depend on:
   - Python
   - C JSON FFI
   - Tauri
   - Swift or Kotlin
   - HTTP routes
   - stores
   - filesystem state
   - subprocesses
   - threads
   - global application state
8. Each migrated domain must expose a typed Rust API that Tauri can later call directly.
9. The C/JSON ABI is only a temporary Python compatibility adapter.
10. Do not embed JSON parsing or raw pointer handling in the domain algorithm.

## Dependency Direction
The current desktop compatibility path is:

```text
Web frontend
    ↓
Python HTTP/SSE transport and persistence/external-tool adapters
    ↓
Rust runtime AppState and application services
    ↓
Rust domain core
```

The intended direct native path remains:

```text
Web frontend
    ↓
Tauri commands/events
    ↓
Rust application services
    ↓
Rust domain core
    ↓
platform and infrastructure adapters
```

Explicitly prohibit Rust domain code from depending upward on Python, Tauri, UI code, or platform adapters.

## Future Infrastructure Direction
- Only the BBDown capabilities required by bilikara will be migrated, using
  known BBDown behavior as a compatibility oracle and explicit fallback for
  unsupported cases during transition.
- Do not port or link aria2 source code. Build an independent Rust downloader;
  retain aria2c only as an explicit desktop transition fallback until that path
  is proven.
- The first downloader infrastructure slice lives in the typed `rust-runtime`
  crate. It owns HTTP transfer, URL fallback, progress, cancellation, response
  validation, temporary output, and atomic publication. Python only adapts the
  temporary C ABI and keeps aria2c as a transactional desktop fallback.
- The stateful service slice in `rust-runtime` owns Bilibili QR-login
  transitions, WBI/DASH and redirect resolution, Rust Native cache queues,
  retries, cancellation, track concurrency, validation and publication,
  Gacha task leases, Gacha repository persistence and refresh, Cloudflare
  requests and its bounded background append queue, update transfer,
  diagnostics assembly, and network address selection. Python supplies
  configuration and cookie facts, commits external-worker cache events through
  AppState, persists Rust snapshots, and adapts the temporary C ABI.
- Frozen Python implementations remain only for explicit compatibility paths:
  external BBDown/yt-dlp/aria2c/FFmpeg modes, emergency diagnostics, direct
  Feishu fallback, legacy Gacha schema rebuild, and runtime-unavailable update
  fallback. These are retained I/O or historical compatibility paths, not a
  Python application core. Normal operations do not recompute Rust-owned state
  in Python.
- FFmpeg and ffprobe CLI calls are desktop transition adapters. Media handling
  must use a `MediaBackend` abstraction, with direct FFmpeg libraries preferred
  for the required metadata and remux functionality.
- Mobile production cannot depend on Python, child processes, sidecars, or CLI
  executables.
- Tauri remains the shell and WebView integration layer. Swift and Kotlin stay
  narrow platform adapters rather than alternate backends.

The detailed release sequencing, downloader scope, and casting foundation are
maintained in [the version roadmap](version-roadmap.md).
