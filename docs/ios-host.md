# bilikara iOS Host development

The iOS target embeds the shared Rust `AppState` and `NativeHost` in the Tauri
process. It is a development entry, not an accepted iOS Beta. Opening the Host
page, compiling a target, signing an app and verifying playback are separate
results. Device results belong in ignored `.tmp/` evidence, tied to a commit,
toolchain, device, OS and artifact hash.

## Build and run

Use macOS with full Xcode, its selected command-line tools, and both iPhoneOS
and iPhoneSimulator SDKs. Install the pinned Rust toolchain from
`rust-toolchain.toml`, Node 24+, and the locked npm dependencies:

```sh
npm ci
npm run ios:doctor
npm run ios:init
npm run ios:build:sim
npm run ios:dev -- --open
```

The simulator build entry selects Apple Silicon (`aarch64-sim`) and disables
signing. On an Intel Mac, use
`node scripts/ios.mjs build --debug --target x86_64 --no-sign --ci`.
`src-tauri/gen/apple/` is generated and ignored. Do not store durable changes
in that directory; keep the iOS configuration and plist in `src-tauri/`.

Use `npm run ios:build:device` for a signed ARM64 development build after
configuring the developer's real signing team and provisioning in Xcode or
`APPLE_DEVELOPMENT_TEAM`. No team or certificate is supplied by the repository.
An unsigned simulator product is not an installable iPhone IPA. Consult
[Tauri iOS signing](https://v2.tauri.app/distribute/sign/ios/) for the supported
signing setup. Do not publish development credentials or generated private
provisioning material.

`scripts/ios.mjs` fails explicitly outside macOS. It supplies target-specific
Apple sysroots to QuickJS bindgen using SDK discovery and forwarded Cargo
configuration, including when Xcode is opened separately. Build/dev commands
retain `--locked`; the script does not download an
SDK, disable TLS, install media CLIs or build the desktop backend. The current
AVFAudio dependency sets an iOS 14.5 build floor in `tauri.ios.conf.json`;
this is not a declared minimum supported iOS version. Set the product support floor only after the WebKit,
dependency and device matrix has been measured.
The iOS configuration also declares `AVFAudio` in the generated Xcode target's
framework list. A Rust static library's framework requirement alone does not
supply the final native link. Re-run `ios:init` after changing that list; CI
checks the final executable's system-framework dependencies.

Development runs disable Tauri's separate development web server so the
startup document and Host resources remain packaged and work without a PC.

## Mobile workflow

The existing `CI And Bundles` caller runs iOS inside its reusable `Mobile`
workflow. `Test (iOS)` runs shared Rust/frontend checks and the iOS startup/build
entry tests on macOS 15 ARM64. The bundle matrix builds both
`aarch64-apple-ios` and `aarch64-apple-ios-sim` with `--no-sign`, using Xcode 16.4
and SHA-256-verified XcodeGen 2.46.0. Android retains its own SDK, media and
signing steps.

The iOS workflow uploads an unprovisioned ARM64 `.ipa` and a simulator `.app.zip`
as separate Actions artifacts, each with a commit/toolchain record and SHA-256
checksum. It validates bundle identity, the final ATS setting, ARM64 machine
architecture and the device/simulator Mach-O platform. Default builds receive
no signing credentials and iOS products are not uploaded to GitHub Releases. The device
IPA requires valid signing before installation; neither archive is real-device
or playback acceptance. CI results apply only after the workflow actually runs.

### Optional Ad Hoc distribution

Manual `CI And Bundles` runs can enable the `ios_adhoc` boolean. This adds a
separate release build for registered devices; unsigned and simulator lanes
remain available. Configure these repository secrets using real Apple assets:

| Secret | Required content |
| --- | --- |
| `IOS_CERTIFICATE` | Base64 Apple Distribution `.p12`, including its private key. |
| `IOS_CERTIFICATE_PASSWORD` | Password for that P12. |
| `IOS_MOBILE_PROVISION` | Base64 iOS Ad Hoc provisioning profile for the existing bundle identifier and registered test devices. |

For example, after configuring credentials:

```sh
gh workflow run ci-bundle.yml --ref feature/ios -f ios_adhoc=true
```

The signing job accepts only manual branch builds in the upstream repository.
PR/default jobs receive no iOS credentials. Requested signing fails explicitly
when inputs are absent, expired or incompatible; it never substitutes a local
`codesign -` signature. The pinned Tauri CLI uses Xcode's `release-testing`
export method for Ad Hoc, imports the certificate into its temporary keychain
and owns that keychain's cleanup. Build scripts do not install a permanent key.
An always-run cleanup removes only the new provisioning copy whose bytes match
this invocation; it preserves every previously installed profile.

`scripts/ios-signing.mjs` checks the profile's explicit app identity, team,
expiry, distribution entitlement and device list before building. It then
checks the exported IPA's embedded profile, actual signing certificate,
entitlements, code seals, ARM64 device platform and ATS setting before staging
the original sealed archive. Receipts omit device IDs and certificate/profile
contents. The IPA itself contains the provisioning profile required by Apple;
the separate Actions artifact expires after seven days. No release is published.
An exported/verified IPA still needs installation and upgrade testing on a
registered device. No signing credentials are provided by this repository.

Apple Ad Hoc requires a distribution certificate and a profile that includes
the target devices; see [Apple's profile requirements](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/).
The ordinary unsigned IPA is also available for independent AltStore/SideStore
resigning. That route supplies its own signing identity/provisioning; installation
and capabilities through those tools remain unverified for this app.

## Startup and trust boundary

Android and iOS call `native_host::mobile::start` once during application
setup. Android retains its TLS/JNI and libav setup before that call. The shared
startup initializes the existing checkpoint and starts a single listener.
Repeated startup attempts fail without creating another Host. Page reload,
wake and IPC status requests never initialize application state.

The iOS data root comes from Tauri's `app_data_dir` inside the app's
`Library/Application Support/<bundle identifier>`. The current shared layout
keeps `host-state.json`, media, logs and temporary exports under that root.
Cache backup exclusion, distinct cache/temp placement and device file
protection still require iOS storage adaptation. Do not move committed data or
change bundle identity as a workaround for an installation or storage error.

The packaged `ios-startup.html` document has one local, main-window IPC
permission: `ios_host_status`. It reports Rust snapshot/listener readiness and
leaves playback `unverified`. The document exchanges the native-generated
loopback bootstrap credential for the existing HttpOnly Host cookie. Errors
show fixed codes/messages without paths or credentials; a corrupt checkpoint
is not removed, reset or retried with a different seed.

The main window permits only that packaged document, the exact bootstrap URL,
and `/` or `/index.html` at the native-created loopback origin. Other ports,
external URLs, Remote and audience paths are rejected. HTTP pages receive no
Tauri IPC capability. This boundary is not yet a share, login, fullscreen,
external-display bridge. Add those as separately scoped
platform operations, with main-frame/origin validation, bounded pending
requests and stale-response isolation.

`Info.ios.plist` scopes cleartext WebKit access to the loopback IP and leaves
arbitrary loads disabled. It declares the local-network purpose without
Bonjour services or multicast entitlements. Validate the generated and final
application plist on each supported SDK. Loopback, incoming LAN TCP, outgoing
LAN traffic, ATS and Rust TLS are distinct checks; see Apple's
[ATS exception domains](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)
and [local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

## Capability boundaries

| Area | Implementation boundary and remaining validation |
| --- | --- |
| Core, queue, settings, history | Existing Rust AppState; native checkpoints and API authentication remain authoritative. |
| Startup and HTTP | Shared in-process startup; iOS compile/link, WKWebView cookie/SSE/Range and reopen require Apple validation. |
| Shared UI | The existing Host page receives `hostPlatform=ios` and uses the shared mobile navigation, Request pager and My/Settings components. CSS safe areas and an iOS VisualViewport adapter reserve input space. Native keyboard, rotation, gestures and iPhone/iPad layout still require device validation; no Android identity or legacy engine mode is injected. |
| Playback | Existing split video/audio and WebKit path; iOS attenuation/zero volume reuse the same Web Audio gain used by boost and pitch. Gesture, offset with DSP, tracks, Signalsmith, drift and physical output require real-device measurements. |
| Network/TLS | Existing Rust HTTP/TLS and Apple interface discovery. SDK linkage, platform trust and another device's LAN Remote are mandatory checks. |
| Public Remote | Existing signaling/ICE/DataChannel protocol; iOS room authentication, initial identity/state and reconnection have not been qualified. |
| QuickJS | iOS device/simulator bindgen enabled; actual C compilation and execution require the corresponding SDK. |
| Export/fonts | Shared renderer is present; mobile renderer registration, font discovery, system sharing and temporary-file ownership remain to be implemented/verified. |
| libav / automatic volume / Pure K / DLNA | No iOS companion is installed or claimed. They do not gate startup and must retain explicit unavailable results. |
| Updates | iOS rejects the Android APK workflow. Version checks, installation guidance and upgrade retention require a separate iOS implementation. |
| Audio session | A narrow Rust/Objective-C adapter selects `AVAudioSessionCategoryPlayback` before Host startup and reports fixed startup errors. It does not activate audio at launch or request a microphone. Actual activation and routing remain device checks. |
| Lifecycle / audience | Interruption/route recovery and external-display adapters and device evidence are outstanding; no background or external-display support is declared. |

## Shared mobile presentation

`static/host-layout.js` selects the common mobile workflow only for native
Android/iOS Hosts; available width then selects phone or landscape arrangement.
A narrow desktop retains its rail, workspace and desktop controls, independently
of touch input. Existing `android-*` DOM hooks and browse helper names remain
compatibility hooks for one shared component tree, rather than a second iOS UI.
Navigation moves headings/settings only; it never moves or recreates media.

`static/ios-host.js` owns only viewport events. It coalesces VisualViewport and
focus changes, excludes pinch zoom from keyboard measurements, and releases its
listeners on page hide before restoring them on page show. Only content and
transient messages reserve keyboard space; the five-target dock stays at the
bottom of the layout viewport. Safe-area values come from WebKit, separately
from Android's native inset notifications. Browser simulations check geometry
and event ownership, not native keyboard or lifecycle behavior.

Android TLS/JNI, window preferences, media visibility workarounds, export and
platform commands remain Android adapters. iOS continues to use the existing
WebKit player path. System sharing and external login report unavailable until
a separately authenticated iOS bridge is implemented. Startup still runs only
once per process; reloading or restoring the page never starts another Host.

## Captured audio timing

`static/audio-clock.js` adapts the existing split player's captured audio on
WebKit. A media element routed to Web Audio can report queued decoder input
ahead of actual output and can retain samples after native pause. The adapter
starts each playback/seek segment from an explicit media position and advances
it with the existing AudioContext clock. It gates gain while paused or seeking,
flushes the source before resume, and drains queued output before normal song
completion. Signalsmith keeps the same source/gain graph and its explicit DSP
latency compensation. Media elements and browser `currentTime` are not replaced.

Clock ownership follows the current Host playback session. User pause cancels
pending completion, retired listeners cannot restart/advance another song, and
context closure remains an explicit recovery condition. This is renderer timing
state; Rust AppState remains the only queue/settings/business authority.
Diagnostics retain raw media clocks and separately expose the captured segment
clock and its drift. The mapping still needs Apple-device validation, including
real output-route latency and interruptions; it does not declare background
playback or compensate an unmeasured device route with a fixed offset.

## Verification

Portable checks:

```sh
npm run test:ios-bootstrap
npm run test:ios-build
npm run test:ios-signing
npm run test:ios-playback
npm run test:mobile-host
node --test tests/android_alpha_bootstrap_contract.test.mjs
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --test mobile_startup
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib mobile_navigation::tests
cargo check --manifest-path rust/Cargo.toml --locked --target aarch64-apple-ios
```

The mobile startup test launches isolated native processes and exercises real
HTTP authentication, durable reopen, repeat-start rejection and corrupt-data
preservation. It does not qualify iOS or physical LAN access. Run the affected
Android and desktop checks in `AGENTS.md` before accepting shared changes.

The playback browser fixture runs desktop first, then Android/iOS platform
markers over an actual isolated Rust Host. FFmpeg generates fixed test media
only for the fixture; it is not an application dependency or downloader fallback.
The default run includes Chromium and Linux WebKit. It checks decoded PCM attenuation/zero gain, mute,
positive/negative offset, track selection, pause/resume, actual pitch output
frequency and media/gain-node retention across DSP changes. An independent
frequency-coded channel verifies actual output position through offset, seek,
and DSP changes, and WebKit checks queued EOS, tail pause/resume and a single
automatic next operation. It does not accept a mapped-clock value as output proof.
It tests shared logic and cannot qualify Apple codecs, WKWebView or speakers.

For a focused Linux WebKit run, use
`BILIKARA_IOS_PLAYBACK_ENGINE=webkit npm run test:ios-playback`.
Raw MediaElement time may still describe decoder input ahead of output. Preserve
that diagnostic; compare the segment clock against independent decoded PCM and
video position rather than concealing the raw reading or accepting model-only
agreement. Do not infer an iOS result from Linux WebKit.
Use `BILIKARA_IOS_PLAYBACK_EVIDENCE=/absolute/ignored/directory` to retain
samples, failure diagnostics and screenshots.

On an iPhone, test first user gesture and rejected `play()`, automatic next,
positive/negative offset and seek, original/accompaniment selection, pitch
on/off, gain/mute, and uninterrupted playback for at least one hour. Record
actual output sync/error, DSP delay, CPU/memory/heat and route changes; do not
infer audible output from a gain parameter or a processor's ready flag.
The pinned Wry iOS adapter configures inline media and autoplay policy when
creating WKWebView. Inspect that version before adding configuration overrides;
changing a copied configuration after WebView creation is ineffective.

On Apple hardware, record both device and simulator build/link results before
claiming either target works. Check the signed app's bundle identity, plist and
resource inventory; install it on an iPhone, reopen saved records, play fixed
split media with positive/negative offset and pitch changes, and have another
device register and control it through LAN Remote. Preserve failure diagnostics
without exporting credentials. A missing SDK/device is **blocked**, an
unexecuted test is **not tested**, and a failed operation is **failed**.
Neither simulator success nor portable tests complete M0's real-device gate.
