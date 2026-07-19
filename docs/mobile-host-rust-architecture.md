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
   - desktop compatibility
   - migration fallback
   - reference implementations
   - development and build tooling
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
7. Core Rust business logic must not depend on:
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
- Only the BBDown capabilities required by bilikara will eventually be migrated.
- Do not port or link aria2 source code.
- A future independent Rust downloader may implement the required HTTP/Range/retry/cancellation subset.
- FFmpeg and ffprobe CLI calls are desktop transition adapters.
- Future media handling must be accessed through an abstract media backend.
