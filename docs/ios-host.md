# bilikara iOS Host development

The iOS target embeds the shared Rust `AppState` and `NativeHost` in the Tauri
process. It is a development entry, not an accepted iOS Beta. Opening the Host
page, compiling a target, signing an app and verifying playback are separate
results. Keep device evidence outside the Git checkout, for example under
`~/bilikara-ci-validation-evidence/<timestamp>/`, tied to a commit, toolchain,
device, OS and artifact hash.

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
Xcode 27.1 sets an iOS 15.0 supported build floor in `tauri.ios.conf.json`;
this is not a declared minimum supported iOS version. Set the product support floor only after the WebKit,
dependency and device matrix has been measured.
The iOS configuration also declares `AVFAudio` in the generated Xcode target's
framework list. A Rust static library's framework requirement alone does not
supply the final native link. Re-run `ios:init` after changing that list; CI
checks the final executable's system-framework dependencies.

Development runs disable Tauri's separate development web server so the
startup document and Host resources remain packaged and work without a PC.

### App name and icons

iOS inherits the `bilikara` product name; `Info.ios.plist` also fixes
`CFBundleDisplayName` and `CFBundleName` to that spelling. The identifier remains
`com.bilikara.app`, so the name/icon change does not select another data container
or signing identity. Verify a real overlay installation without uninstalling or
clearing data; SpringBoard, Settings and app-switcher appearance are device checks.

`static/pic/icon.png` is the sole brand source (1254×1254, opaque). Run
`npm run ios:icons` after changing it. The pinned Tauri icon generator runs in an
owned temporary directory; only its iOS PNGs and source/hash receipt are retained
under `src-tauri/icons/ios/`. Desktop and Android assets are not regenerated.

Tauri `ios init` creates a default AppIcon catalog. The repository wrapper copies
and verifies all 18 branded phone/tablet/marketing slots after initialization and
again before development/build, preserving the generated slot mapping. Source,
CLI or asset changes require explicit regeneration; missing or mismatched slots
fail preparation. Direct Tauri CLI users must run
`node scripts/ios-branding.mjs prepare` after init and before building.

Unsigned and Ad Hoc artifact gates inspect the final app's names, bundle identity,
primary `AppIcon` declaration and decoded 2x/3x phone-icon pixels. Native `sips`
normalizes Apple's optimized PNGs into a separate temporary directory; the sealed
app is read-only. The gate does not substitute for installation/device acceptance.

## Mobile workflow

`CI` runs the iOS application-target check, native Host checks and iOS startup/
build entry tests on macOS 15 ARM64. Shared frontend tests run once in Desktop
Linux. Manual `Bundle` accepts `target=ios` (or `mobile` / default `all`) and
runs independently without starting CI. The bundle builds the device target
`aarch64-apple-ios` with `--no-sign`, using Xcode 16.4
and SHA-256-verified XcodeGen 2.46.0. Android retains its own SDK, media and
signing steps.

The iOS workflow uploads an unprovisioned ARM64 `.ipa`
as an Actions artifact, with a commit/toolchain record and SHA-256
checksum. It validates bundle identity, the final ATS setting, ARM64 machine
architecture and the device Mach-O platform. Default builds receive
no signing credentials. Manual Bundle does not publish; a guarded tagged Release
distributes the original verified unsigned IPA alongside the other five packages
on GitHub and R2. The device
IPA requires valid signing before installation; the archive is not real-device
or playback acceptance. CI results apply only after the workflow actually runs.
Simulator builds remain available through the local development commands above;
CI does not build or publish simulator artifacts.

### Optional Ad Hoc distribution

Manual `Bundle` runs with an iOS target can enable the `ios_adhoc` boolean. This adds a
separate release build for registered devices; the unsigned device lane
remains available. Configure these repository secrets using real Apple assets:

| Secret | Required content |
| --- | --- |
| `IOS_CERTIFICATE` | Base64 Apple Distribution `.p12`, including its private key. |
| `IOS_CERTIFICATE_PASSWORD` | Password for that P12. |
| `IOS_MOBILE_PROVISION` | Base64 iOS Ad Hoc provisioning profile for the existing bundle identifier and registered test devices. |

For example, after configuring credentials:

```sh
gh workflow run bundle.yml --ref feature/ios -f target=ios -f ios_adhoc=true
```

The signing job accepts only manual branch builds in the explicitly trusted
`VZRXS/bilikara` or `VZRXS/bilikara-next` repository.
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

Code CI runs `node scripts/ios.mjs check` on the Apple runner. This checks the
actual iOS application crate with its selected SDK and locked dependencies,
without exporting an IPA or loading signing credentials. Linking, final-bundle
inspection and device installation remain separate Bundle/device gates.

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

Completed cache directories and scratch files use Darwin's `renamex_np` with
`RENAME_EXCL` on iOS. Publication fails if any destination already exists,
including an empty directory or a dangling link. Unsupported filesystems fail
closed; there is no overwrite or check-then-rename fallback. These platform
calls still require sandbox/device validation in addition to shared publication
race tests and Apple-target compilation.

The packaged `ios-startup.html` document has one local, main-window IPC
permission: `ios_host_status`. It reports Rust snapshot/listener readiness and
leaves playback `unverified`. The document exchanges the native-generated
loopback bootstrap credential for the existing HttpOnly Host cookie. Errors
show fixed codes/messages without paths or credentials; a corrupt checkpoint
is not removed, reset or retried with a different seed.

Startup failures include a versioned diagnostic with the failing stage, last
completed stage, fixed error code and available I/O kind/OS errno. No raw error
message or private path crosses IPC. A failed mobile Host construction drains
its owned listener/workers and releases AppState's storage lock; the process
still refuses a second startup attempt. Preserve the original checkpoint when
investigating failures. Shared process-reopen tests do not establish the cause
of a device-specific second-launch failure or qualify iOS lifecycle recovery.

The main window permits only that packaged document, the exact bootstrap URL,
and `/` or `/index.html` at the native-created loopback origin. Other ports,
external URLs, Remote and audience paths are rejected. HTTP pages receive no
Tauri IPC capability. A separate `WKScriptMessageHandler` accepts system login
requests only from the native-created main WKWebView, its main frame/security
origin and the exact Host paths. Remote, iframe, login and other-origin documents
cannot call it directly. The opener accepts only HTTPS on `account.bilibili.com`
or `passport.bilibili.com`, with bounded length and no credentials, nonstandard
ports or fragments; it uses `UIApplication.open(_:options:completionHandler:)`
and never navigates the Host away. No arbitrary scheme/URL opener is exposed.

The injected adapter bounds request count and deadlines, cancels retired-page
callbacks and isolates document generations, including BFCache restoration.
A successful system-open reply means the system accepted the URL, not that login
completed. Returning to the Host refreshes the existing Rust login state; the
QR worker remains authoritative. Safari/Universal Link routing and actual iOS
background/return behavior still require device qualification. Sharing and
external-display operations remain separate capabilities.

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
| Player fullscreen | iOS uses the same in-app fullscreen container and media/DSP nodes, with a main-frame UIKit appearance command. Cache-ready video/audio are required for entry; exit remains available. Status-bar/home-indicator restoration, safe areas and physical device behavior still require Apple validation. |
| Network/TLS | Existing Rust HTTP/TLS and Apple interface discovery. SDK linkage, platform trust and another device's LAN Remote are mandatory checks. |
| Public Remote | Existing signaling/ICE/DataChannel protocol; iOS room authentication, initial identity/state and reconnection have not been qualified. |
| QuickJS | iOS device/simulator bindgen enabled; actual C compilation and execution require the corresponding SDK. |
| Export/fonts | Shared renderer is present; mobile renderer registration, font discovery, system sharing and temporary-file ownership remain to be implemented/verified. |
| Automatic volume | The iOS shell selects the statically linked Rust AAC-LC/FLAC scanner. First enable must actually decode the current cached audio before confirming availability; old sidecars or a saved enable preference cannot qualify a new process. Device energy, interruptions and long playback remain unqualified. |
| libav / Pure K / DLNA | No iOS companion is installed or claimed. They do not gate startup and retain explicit unavailable results. |
| Updates | iOS rejects the Android APK workflow. Version checks, installation guidance and upgrade retention require a separate iOS implementation. |
| Audio session | A narrow Rust/Objective-C adapter selects `AVAudioSessionCategoryPlayback` before Host startup and reports fixed startup errors. It does not activate audio at launch or request a microphone. Actual activation and routing remain device checks. |
| Lifecycle / audience | A scene-bound UIKit adapter discovers independent external scenes and opens the shared muted audience compositor only on explicit activation. Host audio and Rust state remain authoritative. Physical AirPlay/HDMI, interruptions and background playback still require device qualification. |

The display list reports unsupported, discovering, no independent targets,
read failure, mirroring only, or selectable targets separately. AirPlay audio or system mirroring
does not establish an app-owned external scene. No hidden view or forced scene
activation is used to manufacture an available display. AirPlay/HDMI device
acceptance remains outstanding.

### Independent iOS audience display

The scene manifest keeps one ordinary application scene and accepts Apple's
non-interactive external-display role (with the legacy external role). The Host
is built hidden, attached explicitly to the application scene, then shown. An
external scene arriving first cannot create a second Host or put controls on TV.
The pinned stable Tauri 2.12.3/tao 0.37.2 stack preserves the requested scene role
and the scene-configuration lifetime; older pinned tao releases do not safely
support this lifecycle. See [Tauri's scene integration](https://v2.tauri.app/learn/mobile-multiwindow/)
and [Apple's connected-display guidance](https://developer.apple.com/documentation/uikit/presenting-content-on-a-connected-display).
This dependency update does not change the Rust backend or media cache policy.

Only connected external-role `UIWindowScene` objects on a screen distinct from
the controller are selectable. Connecting, refreshing or opening the display
menu creates no audience window. Explicit activation creates a non-key UIKit
window containing the existing `controller.html` renderer. It receives the
shared versioned scene/clock envelopes and renders muted video; the original
Host retains audio, DSP, controls and Rust AppState. Explicit Identify creates
short-lived native number annotations and keeps the button busy until they close.
Their native UIKit cards use the UI's exact display-number mapping and resolved
Light/Dark/Blue colors, role labels, safe-area-relative 128pt geometry and
reduced-motion preference. A pending system accessory remains a zero-size,
unstable capability until a real external Scene exists. Explicit Identify may
temporarily enable that capability and wait up to five seconds for the Scene;
it creates no Audience WebView or decoder. Shown annotations last three seconds.
Backgrounding, document retirement, disconnect or cancellation release the
temporary windows/accessory, and identification excludes active output changes.
Linux policy/bridge checks cannot validate a native Scene's actual appearance.

The separate narrow WK bridge validates the actual WebView, main frame,
security origin, exact Host/audience URL, document identity and generation.
It exposes no general Tauri IPC to HTTP, Remote or external pages. Both Host
and audience must acknowledge readiness. Old documents, stale/replayed clocks,
renderer failure, lost scenes and heartbeat timeouts cannot retain an output
lease. Background/foreground notifications suspend forwarding and request a
fresh Host clock on return; they do not claim background audio qualification.

Locally testable policy and injected-adapter tests do not exercise UIKit window
attachment. After an unsigned Bundle is re-signed and sideloaded, verify an
external display connected before launch, explicit connect/disconnect, unplug
while activating/playing, reattach, repeated output cycles, mirroring-only and
audio-only routes, app background/return, seek/pause/tracks, muted TV audio and
uninterrupted Host audio. Test iPhone and iPad separately. No real-room or
physical external-display result is implied by compilation.

The shared phone label defaults to iOS beta and Android without a test suffix.
Packaged HTML may set `data-host-channel="stable"` or `"beta"` to choose the
corresponding localized platform label; preview/development retain the beta
label. This is a presentation label, not release or device qualification.
V7 replaces the former portrait-only, threshold-swipe and title-free decisions.
Normal iPhone pages may remain portrait; explicit player fullscreen must allow
both landscape directions and restore the ordinary policy on exit. iPad retains
its window/system policy. Rotation never implicitly enters fullscreen.
Settings back must follow continuous gesture progress, support cancellation and
commit the shared route only once. A DOM transition driven by a native edge
gesture is not a UINavigationController push/pop. Physical rotation, gesture,
multitasking and safe-area acceptance require an installed device build.

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

Mobile Host and Remote text, numeric, search, pagination and select fields use
shared 2px inset focus outlines. The field or its existing pill/search/select
shell owns the outline, so bounded scrollports retain the focus paint without
changing control size or page padding. Desktop Host keeps its external focus
halos; native checkbox, radio and range treatments remain separate. The iOS
adapter compares the focused field with the actual VisualViewport: visible
fields do not scroll, while occluded fields reveal only through their nearest
scroll owner. Native viewport panning is not applied a second time. Physical
iOS keyboard, accessibility zoom and compositor acceptance still require a
device run.

The iOS phone dock has a 56px body at the ordinary 16px root font; its bottom
safe area is added once. Icons remain 24px and all five targets remain at least
44px high. Larger labels may wrap, and the iOS adapter measures their actual
content height on font/content/size changes so the reserved page track grows
with them. Dock observers coalesce their work and retire with the page. Android
keeps its existing dock geometry; the keyboard continues to overlay a stationary
dock while content and transient messages reserve its inset.

Shared action labels (including nested SVGs), session-user handles/names and
pager labels suppress text selection and the iOS touch callout. Inputs and
read-only text remain outside that control rule; Remote-access URLs explicitly
retain WebKit text selection and its ordinary callout. No page-wide gesture or
context-menu cancellation is installed, so rename, native input selection,
keyboard activation, paging and the existing drag owners keep their behavior.

Android TLS/JNI, window preferences, media visibility workarounds, export and
platform commands remain Android adapters. iOS continues to use the existing
WebKit player path. System sharing remains unavailable; validated Bilibili login
links use the main-frame bridge described above. Startup still runs only
once per process; reloading or restoring the page never starts another Host.

The iOS fullscreen bridge changes only the existing Tao view controller's
appearance. It retains the original status-bar/home-indicator preferences and
restores them on exit, document retirement, cancellation or bridge destruction.
The shared player uses its existing in-app fullscreen class instead of an
exclusive video player or Tao's iOS window fullscreen API, whose exit operation
is not implemented by the pinned shell. No decoder, audio graph or queue is
created by this UI operation. Old document messages/replies cannot reactivate a
retired player. Arbitrary-container DOM Fullscreen API support is not required.

iOS single-screen video taps reveal the system overlay, with no permanent
application transport in ordinary or immersive playback. Dual-screen retains
the shared Host console transport. Repeated taps do not invoke desktop double
click fullscreen. The application's fullscreen button also works while the
selected song caches. `controlsList=nofullscreen`, `disablepictureinpicture`
and WebKit skin hints request that the system omit fullscreen/PiP buttons;
actual iPhone enforcement remains a device gate. The owned audience config
disables PiP before creation. Pinned Tauri/Wry still exposes no main-view iOS
precreation PiP hook. No private selectors or replacement player are used.

Phone function titles and restored subtitles occupy an 80px toolbar, sharing
Playback's title axis. Subtitles use 12px/16px type below the title and may
ellipsize on narrow translated headers. The outer workspace, Playback and My
cards are removed; their content uses 14px page gutters. Desktop and Remote
retain their existing headings and cards. Snapshot rendering cannot hide either
card while a Settings transition or edge gesture owns its presentation.
Phone toolbar actions retain their translated text, content widths and existing
control shapes. Only the 44px height and vertical alignment match the home
phone-access surface; no square width or icon-only presentation is imposed.

After a seek, WebKit may leave `play()` pending despite decoding media. A
resume can also leave video in a synchronization-owned pause after the audio
seek. When that position has buffered future frames and output is running,
release the video hold while startup is still pending. Requiring video progress
before releasing its own pause would deadlock. The bounded play guard still
applies; only subsequently observed decoder/output progress qualifies recovery.
A current-attempt probe requires advancing audio/video clocks, newly decoded video
frames, live readiness, no seek/error, and a running captured AudioContext before
establishing playback independently of that Promise. A temporarily ineligible
post-seek restart is retried after readiness recovers, respecting logical pause,
session ownership and the existing startup deadline. No elapsed timer alone
certifies successful playback.

## Captured audio timing

`static/audio-clock.js` adapts the existing split player's captured audio on
WebKit. A media element routed to Web Audio can report queued decoder input
ahead of actual output and can retain samples after native pause. The adapter
starts each playback/seek segment from an explicit media position and advances
it with the existing AudioContext clock. It gates gain while paused or seeking,
flushes the source before resume, and drains queued output before normal song
completion. Signalsmith keeps the same source/gain graph and its explicit DSP
latency compensation. Media elements and browser `currentTime` are not replaced.

iOS WebKit creates that source/gain route while its element is still paused,
before the first playback. Capturing an already-playing decoder can introduce
a source underrun during the initial gain change. Desktop and Android retain
their native unity-range path; volume/pitch changes keep the existing graph.

Clock ownership follows the current Host playback session. User pause cancels
pending completion, retired listeners cannot restart/advance another song, and
context closure remains an explicit recovery condition. Known source EOF survives
startup retries even if WebKit clears its native ended flag; a delayed decoder
rewind cannot replace the explicitly resumed output segment. Completion still
requires that segment to finish, and a new source clears the EOF evidence.
This is renderer timing
state; Rust AppState remains the only queue/settings/business authority.
Diagnostics retain raw media clocks and separately expose the captured segment
clock and its drift. The mapping still needs Apple-device validation, including
real output-route latency and interruptions; it does not declare background
playback or compensate an unmeasured device route with a fixed offset.

An explicit AV-delay edit on WebKit freezes the video reference before seeking
audio. Readiness resumes alignment at frame cadence instead of charging the
decoder's seek duration to the requested delay. The selected relationship stays
under precise output-clock control for that playback session, including later
video starvation/recovery. A short Web Audio delay line before volume gain
absorbs measured residual lead; a leading video waits for audio. The correction
starts at zero, is capped at one second and resets on seek/pause. A larger
recovery rebases against the frozen reference instead of clamping the requested
setting. No fixed device/route latency is assumed. Pause retains the audible
position, completion drains output, and mute/volume remain immediate after the
delay line. The first explicit Desktop WebKit AV edit prepares the existing
captured clock/gain route if native unity volume has not needed it yet.
Video/audio rates, media nodes, pitch ownership and committed play intent are
preserved. Audience clocks include the measured output position and DSP latency.
Chromium's existing Android/Windows path is unchanged. Decoded-PCM tests
distinguish +/-100ms settings; physical iOS/macOS output remains a device gate.

The same ownership rule applies when WebKit rejects the initial video play with
`AbortError` after a synchronization-owned pause. If the captured output is
already running and the audio play succeeded, keep that output segment alive
and let the synchronizer recover video under the original startup watchdog.
Do not pause/reseek a valid tail merely to retry video. Other rejections and
stopped output retain the bounded retry/failure path; recovery still requires
real frame/clock progress or actual output completion. Native input EOF does not
prevent that progress check: the captured output clock and decoded video frames
can qualify a resumed tail while its source element is already ended.

## Offline loudness analysis

The iOS Runtime enables `portable-loudness`: Symphonia 0.6.1 decodes local
AAC-LC in MP4/M4A and FLAC into the existing EBU R128 histogram meter. The
decoder is statically linked Rust; no media CLI, separately signed library or
Python fallback is used. Other platform products retain their existing libav
scanner by default. The shared measurement schema, calibration and gain policy
remain unchanged. Upstream licenses and exact source links are embedded under
`vendor/symphonia/` with the Host assets.

Provisioning permits a verification attempt, not an available/enabled claim.
First enable requires current cache-ready audio. AppState admits one request,
holds its artifact read lease, and checks the same song, rendition and manual
intent after decoding. The scan runs outside AppState's lock. Failure,
cancellation, a later manual change or switching songs leaves automatic volume
disabled and preserves manual volume. Success enables analysis without setting
a reference or changing the current audible level. A new process verifies again,
including when the previous enable preference and sidecars were saved.

After verification, the existing supervised worker analyzes the current/next
tracks and reuses size/mtime/algorithm-validated facts. OFF starts no decoder
or scan. Supported measurements are mono/stereo, 8–192 kHz and 0.4 seconds to
six hours; PCM chunks and histogram memory do not grow with song duration.
Individual scans have a 120-second deadline and cooperate with cancellation.
Incomplete audio, internal timestamp gaps/overlaps, unsupported codecs/channels,
silence and invalid measurements report unavailable; manual playback/volume is
independent. This format boundary and Linux regression evidence do not certify
Apple-device energy, thermal behavior, background execution or all provider media.

## Verification

Portable checks:

```sh
npm run test:ios-bootstrap
npm run test:ios-build
npm run test:ios-signing
npm run test:ios-playback
npm run test:ios-fullscreen
npm run test:portable-loudness
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


### Native navigation dock (iOS 26+)

The main Host uses a system `UITabBar` on iOS 26+, with five localized items
forwarding selection to the existing shared Host navigation. It creates no
additional WebView or page state. UIKit supplies the system material and
accessibility behavior; visual Liquid Glass acceptance still requires a device.
Older systems and a failed bridge retain the Web dock. The native bar's measured
height reserves bounded-list content space once, including the safe area.
Playback reserves the dock track so only its inline controls scroll above the
bar, while its stage and track selector stay fixed. My/Settings scroll behind
the bar with final-control and keyboard padding. Fullscreen hides
the native bar; ordinary dialogs keep its geometry and visual presence while
blocking interaction and covering/dimming its surface. Document retirement
removes it. Remote and audience windows never install this control. Shared
routing owns page selection; native tint must use the final semantic accent,
not a transitioning button's computed color.

The CI iOS toolchain is pinned to Xcode 27.1 so the binary links the iOS 27.1 SDK;
SDK-derived Cargo cache identities keep the former Xcode 16.4 artifacts separate.

### V7 diagnostics and acceptance boundaries

Set `globalThis.BILIKARA_PLAYBACK_TRACE = true` in an owned Host document to
capture the latest 256 numeric/enum playback events in memory. The existing
diagnostic export includes a defensive trace copy. The trace records requested,
committed and element/gain volume separately, renderer generations and clocks;
it excludes media URLs, cookies, user identifiers and paths. An AV Delay change
also opens an eight-second diagnostic window without requiring this flag. It
records the previous/current offset, operation sequence, committed play intent,
decoder readiness/seek/pause/EOS, captured pending/hold/reposition, context state,
actual/target gain, pitch phase and decoded/dropped frames. Progress sampling
uses existing synchronization callbacks, at most once per 250ms; the same
256-event limit applies. With the flag off, recording stops when that window
expires. Reloading retires the buffer; it never writes periodic logs.

Captured audio seeks retain the committed playback intent across internal
decoder pauses and repeated delay changes. An explicit user pause and negative
preroll remain holds. Decoder EOS alone is not an instruction to pause a newly
sought audio segment. Delay adjustment preserves the video node/timeline and
the current AudioContext/gain graph.

`BILIKARA_AV_DELAY_MATRIX=1 node --test tests/presentation_timing_browser.test.mjs`
adds a separate Audience and real stereo PCM/time-coded verification for
positive/negative/reset/repeated adjustments, paused seeks and pitch bypass/on.
`BILIKARA_PRESENTATION_PROFILE` selects `1280x720:30`, `1920x1080:30` or
`1920x1080:60` software fixtures. Their Host/Audience frame counts, dropped
frames, drift and recovery latency are browser observations, not physical route
latency, AirPlay qualification or a guarantee of the nominal frame rate.

Queue exports offer CSV and PNG/multi-page ZIP through the native Files
export picker. The export dialog centers in the visible area above the dock,
respecting safe-area/keyboard bounds and scrolling within short windows. Mobile
exports use the shared theme-aware dim backdrop without page blur, keep the
background inert and preserve the visible native dock as non-interactive. Closing
releases the scroll/focus lease after exit motion; small
anchored confirmations retain their existing placement. Rust selects and renders records using the same immutable export
service as desktop; UIKit chooses the destination and reports saved/cancelled.
The preparation guard ends when the picker appears; the user's choice has no
fixed UI timeout. Retired documents dismiss their picker and remove only their
owned temporary export files. A late worker cannot present in a different page.
Native Files providers, cancellation, retained-data playback during export and
large libraries still require device acceptance; browser/native-service tests
and a device-target build alone do not close those gates.

On mobile, the Bilibili account's first tap arms logout. An outside tap/focus,
Host page or Settings change, app departure or hidden document disarms it.
A second tap while still armed performs logout with the existing busy guard;
unrelated SSE paints do not consume that confirmation.

### V7 iOS 27 external-display registration

On iOS 27+, the existing Host controller retains a public Scene Accessory
registration for the `Audience` configuration. Discovery reads system availability
while registration is disabled, so refreshing the menu does not replace mirroring.
Explicit activation enables it and waits at most ten seconds for an external
Scene before creating the existing muted audience WebView. Stop, timeout, document
retirement and controller destruction disable/unregister the accessory. Older
systems retain automatic external-scene discovery. Audio AirPlay alone is never
used as display evidence. Registration, availability, enablement and Scene count
are separate bounded diagnostic facts.

The pinned objc2 bindings predate this API, so runtime class/selector checks guard
public selectors documented by Apple. Apple-target type checking verifies Rust
bindings, not Scene creation or receiver compatibility. This path requires native
lifecycle experiments and AirPlay plus wired-device acceptance before being
qualified as stable; a Windows receiver that supports mirroring alone is not an
independent-scene acceptance result.

### V7 navigation presentation and open native gate

Ordinary Web modals keep the dock visible with constant reserved height while
native hit testing and accessibility selection are disabled and the surface is
dimmed. Large modal content reserves the native dock track to avoid sibling-view
occlusion. Selection/tint comes from shared route state and the final accent
token, with ordered presentation sequence numbers; dynamically inserted modals
are observed as well.

Settings uses a document-bound UIScreenEdgePanGestureRecognizer on supported
native dock containers. Its continuous progress drives the existing shared DOM
transition, reveals My and supports cancellation without changing drafts/scroll.
Visible controls are excluded from edge capture; modal, keyboard, fullscreen,
route and document retirement disable input. The Web touch path remains the
fallback. Completion replaces the shared child route once. This is native edge
input driving DOM presentation, not a UINavigationController push/pop. V7-12's
native lifecycle and continuous-audio acceptance remain open pending a device
experiment with competing input owners.
When UIKit takes the edge gesture, cancellation of the WebView touch stream
does not cancel native progress; the recognizer's cancelled phase owns that
decision. The Web fallback retains its ordinary touch-cancel behavior.

### Retained-cache AAC compatibility

mp4 0.14 emits an SLConfigDescriptor as `06 00 00` (zero declared length with
an undeclared byte). Symphonia 0.6.1 rejects this generated artifact even when
the provider's AAC-LC file decodes successfully. New Rust-normalized output
writes the valid one-byte predefined=2 descriptor (`06 01 02`). Analysis applies
a bounded, structurally checked read overlay to existing affected artifacts;
it never rewrites/evicts their bytes or resets user data.

When an AudioContext resumes after a between-song cache wait, its captured
segment reconciles on statechange and during startup, without depending on a
second canplay event. Suspended contexts do not spin decoder starts. Validate the recovery on an installed iPhone with
retained data.
Queued media play/pause observations also check the current element state;
an old pause cannot reverse a resumed pair and an old play cannot undo a pause.
Current native commands remain active, including cancellation during startup.

The iOS display list includes the actual main Scene as the fixed Host screen,
recommends external output and remaps the accessory entry to its attached Scene.
An unconnected accessory has no invented resolution or physical monitor ID;
only connected Scenes can be annotated. UIKit sizes the audience WKWebView as
the controller's root view, avoiding the default phone view's resize delta.
The audience uses the Host's actual website data store before loading. Receiver
reconnect/load failure acceptance remains physical; error states stay visible.

### Presentation heartbeat and late media readiness

The shared Host sends audience scene/clock heartbeats for the active presentation
lease even with no mounted decoder, during cache waits, or after a media-readiness
failure. The existing clock/paused cadence and native heartbeat deadline remain
unchanged. Inactive output, listener teardown and page retirement release the
heartbeat; repeated activation must not accumulate intervals.

A late-ready media pair retains its failure until an explicit play gesture.
The Host checks the same authoritative playback program, artifact ownership,
metadata and seek state before committing readiness once and restoring its
synchronization interval. The following audio/video starts remain in the same
gesture stack. Ownership failures, media errors and stale programs do not qualify
for this retry. The audience transport owns no playback or application state.

Part selection opened from details is a child modal above the retained detail
view on both mobile Hosts. Cancel preserves the detail, search draft and request
context; successful submission keeps the existing detail-close behavior.

The shared recovery browser regression runs both desktop WebKit and the iOS
platform marker over an isolated Rust Host, with delayed real media responses.
Its OS display bridge is a fixture. Physical iPhone/AirPlay and native macOS
WKWebView playback remain separate acceptance checks.

The audience clock uses captured audio's output time when active, or the
uncaptured audio element's presentation time, plus effective AV delay and
minus the existing DSP pipeline delay. Internal Host video holds/corrective seeks do
not become audience pause/seek commands. Explicit user seeks retain their target;
explicit pause, interrupted output and negative-delay preroll still stop the
audience. Desktop's uncaptured unity route also follows audio presentation time,
independently of hidden Host video holds. This shared behavior also applies
to Windows audience output; receiver/network/decode stutter requires separate
physical measurements.

An accepted video play event also retires its earlier internal-pause marker.
Queued media events still verify the actual paused state; a later system-control
pause must not be consumed by a hold that has already ended.

### Phone pages without outer cards

Phone title bars retain their title/subtitle geometry and add a theme-aware
1px divider at the bottom, inset 16px on both sides. Request tabs reserve a
12px gap before every active subview, including contextual tabs, independently
of the removed card padding.
Playback's single-line brand centers with its action row; other sections retain
the shared title/subtitle axes. On iOS, default quality and downloader share
the same accessible CSS picker
and floating-panel material; their original selects retain value/event ownership.
Other platforms retain native selects.

Playback keeps its media stage and track selector fixed and scrolls only the
inline controls. Playback, Queue/History, My and Settings extend beneath the
floating dock, with trailing scroll space keeping final controls reachable
above the dock/keyboard; there is no horizontal content cutoff at its top.
The connected decoder/DSP nodes are preserved. My and Settings move across
the complete usable viewport, retaining 14px content gutters inside that frame during
forward/back gestures; their final controls can scroll above the dock and
keyboard. Bounded Request and Users lists retain resident
pagination/editing tools at the available bottom edge. History rows keep their
natural height; short Queue layouts use intrinsic content tracks and put scroll
padding on their actual whole-list scroll owner. The Web dock explicitly
occupies the same grid column when content extends behind it.

My uses independent 14px rounded settings groups, shared theme-aware fill,
14px inner insets and 12px gaps. Visible functional rows within a group use
inset 1px dividers, without redundant lines between group cards. Settings
retains the same grouped layout. Both page frames remain transparent, exposing the continuous viewport
background without a rectangular base. Forward/back transitions and interactive
return clip the covered underlay at the moving page boundary, including blank
space below Settings; they do not fill a page-sized opaque rectangle.
Phone Settings releases its hidden header's grid track so the scrolling body
fills the page. My's resident playback/download controls remain rendered under
Settings; desktop popover state does not hide this embedded content during
an interactive return. Nodes, input values, pending guards and scroll position
are retained. Settings remains an ordinary full-row action with
12px clearance from the preceding controls. Queue tabs retain a 12px gap before the first song;
queue/history cards keep their own shapes with 8px vertical padding and normal
badge touch targets.

Pending queue cards share the current card's 48px badge, 54px badge column,
12px inline inset and 8px column gap. Both requester pills and the queue/history
ellipsis circle have a 28px visual height; the circle retains a 44px hit target.
This avoids inflating the history metadata row and its apparent lower whitespace.
The current card's two content rows size to their content with an 8px gap;
they do not reserve an empty 44px visual row. Expanded touch targets retain
their size independently. Current, pending and history content blocks keep
equal top/bottom card insets without extra first/last margins.
Queue menus use history's 8px action gaps and 36px action surfaces, preserving
44px hit areas. Both phone row menus animate in/out without discarding their
anchor during exit; closing actions are inert, interrupted exits cannot hide
a reopened menu, and reduced motion hides/shows immediately. Desktop and Remote
keep their existing behavior.

Owned mobile documents explicitly suppress selection on fixed-label descendants
as well as their containers. Inputs, actual URL links, song content, editable
content and diagnostic/copyable blocks retain native text selection. This rule
does not affect Desktop, browser Remote, login WebViews or accessibility zoom.


### Additional part audio: completion and failure visibility

Additional audio remains an immutable candidate until the user explicitly
selects its variant. Queued/downloading progress belongs to the requested
page, not the playing item's cache status. Worker failure/cancellation retains
its message and cache-attempt token in Rust AppState and the Host/local/public
Remote projections. Clients keep the part label, clear busy state at the
terminal event, show a persistent failure mark and its reason, and notify once
per failed attempt. Explicit retry starts a fresh attempt; unrelated snapshots
must not repeat the warning. A failed later page keeps earlier prepared audio
and the current playback program intact.

A disappearing loading animation alone does not establish success. Acceptance
must verify the candidate contains the requested page and remains selectable;
physical iOS failures still require the exact source/page and resulting error.

Reuse validation recognizes the actual published container. In particular,
Native's elementary FLAC output is not an MP4 input and does not require a
desktop libav companion. Its portable validator checks bounded metadata,
decoded frame CRCs, channel/timeline and sample inventory, and STREAMINFO MD5
when supplied. It polls cancellation while decoding with bounded buffers.
H.264/AAC MP4 retains the existing single-track/sample validation; supported
desktop passthrough codecs retain their explicit companion validation.
Corruption, missing files, symlinks and stale owners are not backend fallback
conditions. Safe cache logs retain the validation stage, known container/codec
and original error category; failure remains actionable and retryable without
redownloading the current video or changing its selected audio.

### IOS-09-06 analysis and foreground recovery

Whole-track verification owns a Rust job/read lease, separate from the volume
editor's UI lease. Close and navigation do not change the requested preference.
The explicit Cancel action checks rendition, intent and analysis epoch, cancels
cooperatively, retires late results and preserves the previous saved preference.
Disable remains an explicit preference change. Re-enable admits a fresh epoch.
Long verification disables only conflicting automatic actions; manual player
controls remain available. Closed or superseded UI leases cannot display late
errors, reopen the editor or steal focus.

On foreground visibility, a suspended/interrupted captured AudioContext receives
an explicit resume attempt even when the media elements still report playing.
A rejected or indefinitely pending resume exposes the existing Start Playback
action. A fresh gesture retires the old resume lease and requests the actual
AudioContext inside the click stack, including during decoder seeking. The action accepts
a suspended captured output as needing recovery even if both elements report
unpaused; it retains the same media pair and audio graph. Validate iOS
background scheduling, output-route changes, energy use, UIKit
frames and physical AirPlay audio separately from software context tests.

### Result pages, shared tablet layout and section-local swipes

Song-result pagination retains at most three rendered pages for the current
dataset. A cache hit reuses the actual card/image nodes and their handlers.
For an uncached page, the current cards and page metadata remain together until
the new data and image decode attempts finish; the node/page commit is atomic.
Leaving the view cancels pending publication and retires detached image loads.
Source-editor drag registries retain their separate existing ownership.

Desktop and landscape iPad share one measured grid policy. The available
content width, stage/workspace rem-based minimums and shell gap admit two
columns; short or genuinely narrow windows use the same compact fallback.
There is no iPad-specific shell or fixed 1180px admission. Two-column playback
controls distinguish `inline-natural` and `inline-scrollable`; only the tray
scrolls, retaining the title, video, track strip and media/DSP identity. Phone
layout stays independent. The fullscreen Remote/QR panel has mobile-only,
safe-area-aware logical size caps and internal scrolling; desktop's panel and
the Audience composition retain their separate roles.
The compact tool drawer remembers an explicit open/closed state across a
temporary two-column layout. Returning to compact must not hide its form,
discard a draft or clear selections merely because focus moved to the page.

`subtab-swipe.js` has no primary-tab or media API. It recursively flattens one
active genuine sub-tab tree. Queue/History and Request are separate scopes;
Request's Random leaf uses its real workspace adapter. Preview does not load
business data or change the route. A committed gesture updates the full
ancestor/child path synchronously, keeps the primary selection and compresses
within-section history. Direct parent taps retain child memory. Explicit fixed
headings, toolbar blank areas and fitting segmented bars provide additional
gesture zones when cards own content pagination. Short tab taps retain their
action; a drag cannot also click its starting tab. Registered fixed inputs, Back actions and ordinary buttons also admit horizontal
drags; short taps keep their original action/focus and active composition stays excluded, and the five primary sections still switch only by activation.
Pagers own their last-page gesture, and edge Back, dialogs, fullscreen, actually overflowing horizontal strips,
IME composition, selection controls, sliders and source edits retain priority. Reduced motion is immediate;
cancelled/interrupted gestures restore presentation without committing.

Light phone pages retain the global canvas with a viewport-wide white gradient
from 0% at the top to 60% at the bottom. Dark/Blue and desktop retain their
surfaces; the gradient has no outline, shadow, blur or hit layer.
The QR scanner restores the shared
20px content axis inside its 18px outer panel, with 14px scanner corners,
a 12px header/content gap and no additional empty track above the camera.
Its bounded scroller remains above dock/IME safe space. Manual DLNA connection
is an explicitly expandable advanced row, separate from QR acquisition.
The shared scanner binds an optional native BarcodeDetector only when decoding.
Owned Android Host and embedded Android WebViews use the bundled local pixel
decoder: an exposed native detector can fail inside JNI when the embedding
application lacks GMS metadata, beyond a JavaScript exception handler. Camera,
image import, ambiguity rejection and official authorization remain separate.

Reproducible Linux rendered checks live in
`tests/desktop_tablet_layout_browser.test.mjs`,
`tests/source_pagination_browser.test.mjs`,
`tests/subtab_swipe_browser.test.mjs` and `tests/ios_output_ui_browser.test.mjs`.
They use the real Rust Host; platform markers, native replies and synthesized
touch input remain fixtures. iPad text sizing, native dock/Back, VoiceOver,
UIKit frames, Windows WebView2 and real Android touch remain device gates.

### Video AirPlay policy and DLNA management

Before assigning any source, Native iOS Host and muted Audience video elements
request local video via `disableRemotePlayback` (property and attribute) and
`x-webkit-airplay="deny"`. Audio elements, Web Audio/DSP and WKWebView's global
AirPlay configuration are unchanged. For a controlled comparison, inject
`BILIKARA_IOS_VIDEO_HANDOFF_CONTROL=true` before media mounting to omit only
these new hints. Never recreate an active WebView/video to change the test arm.
This is a hypothesis-driven mitigation for individual-video handoff, not proof
of the Pure K receiver's rejection cause or of system mirror behavior.

DLNA management remains reachable on all Host platforms even without an
authorized receiver or live-TS capability. The switch only selects local/network
playback, and never launches a scanner or management dialog. Without a receiver,
explicit standalone testing selects the actual Rust L1 pipeline with a local or
Audience sink, subject to the real native companion. Missing iOS support returns
an explicit unavailable cause and leaves Web playback active. A selected standard
DLNA endpoint defaults to output only after real AVTransport/compatible TS facts;
unknown advertisements never imply DLNA-only. The default applies once per
connection and never overrides a subsequent manual off. Scan/Manage is a separate explicit entry; mobile
connected devices open management, whose Disconnect action remains available.
The shared
dialog accepts a plain DLNA description URL through Rust preparation/connect,
while official Pure K authorization keeps its existing separate step. A missing
companion displays an explicit cause and keeps playback local. An admitted,
explicit output request still goes through Rust's existing authority/codec
checks. No iOS live-TS companion is installed or claimed by this UI change.

Hardware A/B must bind the same media, receiver, OS and network, comparing
single-screen mirror and independent Audience separately. Capture local video,
receiver picture, audible audio and AV sync through Next, Seek, foreground and
repeated switches. If element hints fail, assess the pre-creation global
WKWebView option separately with audio-route and Audience impact checks.
Linux WebKit cannot certify AirPlay transmission, AVAudioSession routing,
receiver decoding, wireless latency or physical screen coordinates.

### BILIBILI-EXTERNAL-LINK

Details and rating links share a Bilibili-video-only Host action. Canonical URLs
contain a validated twelve-character BV ID and optional positive integer page
(up to 2147483647); arbitrary original media URLs are never labeled Bilibili.
The iOS Request/native policy and Android JVM validator reject noncanonical
hosts, protocols, ports (including explicit :443), credentials, paths, redirects,
fragments and extra query fields. Account login and WeChat authorization remain
separate actions/whitelists.

Tap and Enter use the existing anchor click path; rating links delegate from the
stable document handler so changing previous/current cannot lose the opener.
Pending links suppress duplicates and keep busy feedback until the system reply.
Failure leaves the dialog, mounted media and Host origin intact. Desktop retains
its Tauri opener; ordinary Remote anchors keep browser navigation semantics.
Validate physical iOS/Android handoff with and without the Bilibili app,
including return-to-app playback.


### Foreground JSON transport and shared presentation

Owned iOS main documents use `request-json` for same-Host GET/POST JSON API
requests. The Rust client calls the existing authenticated HTTP adapter off the
UIKit thread, with a private shell-held capability, no redirects, no proxy and
no automatic retries. It rejects origin/path escapes, arbitrary headers,
non-object POSTs and excessive payloads. Native cancellation retires replies;
it cannot undo or repeat an already committed command. Foreground/BFCache
refresh replaces only a stale state-read lease, preserving media nodes and
pending writes. Ordinary media/SSE/browser traffic retains its existing path.
First scanner qualification retains the decoder's existing 120-second work
budget (125 seconds for its HTTP response, 130 for IPC). Ordinary JSON controls
retain 30/35-second deadlines and state polling its existing 10-second limit.
Cancellation and document retirement remain independent; no POST is replayed.
Background recovery requires separate physical iOS qualification.

Phone Request sub-tab motion uses the complete measured page width with
14px inner content gutters and temporary ancestor clip release. Fixed text
inputs and ordinary buttons can start a horizontal sub-tab gesture; sliders,
pagers, overflowing strips and active composition retain ownership. Primary
sections still require direct activation. Song grids fit at least three rows
per page, scrolling those rows on shorter screens. Fit samples persist across
page changes and update on real size/font changes. Local catalog pages prefetch
two pages; API batch caching is retained. The pager's dock track comes from
measured native/fallback geometry, without a second bottom gutter.
Landscape iPads retain the shared Host shell and the same section-local touch
routes, including fixed Random toolbar controls. Mouse drags preserve ordinary
selection; Pointer-only engines admit touch/pen rather than mouse navigation.
The approved light phone backdrop adds a viewport-wide white gradient, from
0% at the top to 60% at the bottom, behind the content. Cards/text retain their
colors and page frames stay transparent; dark/blue and landscape Host keep
their existing backdrop. It adds no overlay node or backdrop-filter layer.

Both iOS runtime selects use one accessible CSS picker with a shared
floating material, keyboard operation and outside dismissal. Their original
selects remain value/event owners. Android/Desktop treatment is unchanged.
Only the owned iOS 26+ scroll view's public `topEdgeEffect.hidden` is set to
remove its status-area shade; no private selector or global appearance rule is
used. UIKit appearance remains device-unverified. After initial activation,
software does not rewrite an already enabled video's `controls` on every tap,
so subsequent overlay visibility belongs to the system player.
