# Android WebView support and compatibility checks

The Android Host uses the system's **selected WebView provider**. Installing a
new browser does not by itself change that provider. `minSdk = 24` is an Android
native API requirement, not a browser version guarantee. Use a current, vendor
supported WebView; the historical versions below describe compatibility testing,
not recommended downloads.

## Current capability baseline

The default **standard mode** Host/Remote UI has a **Chromium 111 capability floor**.
The JavaScript-only floor is 93; treating it as the full application minimum
misses input isolation and layout dependencies. The audit covers the shared
Host entry, its scripts/styles/vendor media code, local/public Remote transport
and Android startup/native bridges. A version number alone cannot establish
all device, codec, networking or presentation capabilities.

| Required capability | Chromium introduction | Current use |
| --- | --- | --- |
| Optional chaining, nullish coalescing, logical assignment | 80 / 85 | Shared startup and event handlers; an older parser stops the entire script |
| `Promise.allSettled`, `replaceAll`, `Array.at`, `Object.hasOwn` | 76 / 85 / 92 / 93 | Rendering, transport and state validation |
| `crypto.randomUUID` / Web Crypto | 92 / earlier; secure context | Public transport identities and authenticated room protocol |
| `HTMLElement.inert` | [102](https://developer.chrome.com/blog/new-in-chrome-102/) | Host page focus/input isolation and modal background isolation |
| CSS `:has()` | [105](https://developer.chrome.com/blog/has-with-cq-m105) | Shared source controls, pagination and contextual control layouts |
| CSS `dvh` | [108](https://developer.chrome.com/blog/whats-new-css-ui-2023) | Native page frame and bounded floating panels |
| CSS `color-mix()` | [111](https://developer.chrome.com/docs/css-ui/css-color-mix) | Shared pressed/neutral control tokens, including unguarded declarations |
| `WEB_MESSAGE_LISTENER` | Provider feature, independently detected | Origin-scoped Android Host controls/platform/presentation bridges |
| Fetch + `AbortController`, SSE, WebSocket, WebRTC DataChannel, Canvas, WebAssembly, Web Audio + AudioWorklet | Earlier than 111; context/provider restrictions also apply | State and QR, reconnect, public Remote, export and pitch processing |

Popover (114) has explicit JavaScript feature checks and existing ordinary
popup/help paths. Native popover/top-layer enhancements, `@starting-style` and
discrete animation support are not startup requirements. They must still be
checked when changing those surfaces; absence must not be interpreted as a
successful top-layer test. No syntax polyfill or second frontend is introduced.

The local Host loopback document supplies the secure context required by crypto
and AudioWorklet. A capability report from the packaged startup document can
show a different origin/security context; it names the **document tested**.
Media codecs, audio routing, external displays and real peer connectivity need
separate device tests. Public Remote outside localhost requires HTTPS.

## Android standard and compatibility modes

The displayed names are **标准模式** (standard mode) and **兼容模式**
(compatibility mode). Internal protocol identifiers remain `latest` and `legacy`.

Android automatically uses **standard mode** when its startup checks pass.
Otherwise it opens the native compatibility report. When the actual provider is
at least Chromium **83**, its native message bridge works, and the required
compatibility primitives are present, the report offers **Enter compatibility
mode** (进入兼容模式). It never enters compatibility mode silently. Providers below
83, an unknown version, an incomplete probe or a missing bridge keep the
diagnostic without an entry button. Experimental WebView 83–90 additionally uses
generated CSS syntax adapters and simplified CSS motion. Compatibility mode on
91 keeps its existing narrower adapters.

Both modes use the same frontend, authenticated Rust Host and data formats.
Standard mode keeps the Chromium 111 capability floor. The compatibility
scripts return before installing adapters unless compatibility mode was
explicitly selected; missing APIs alone never enable it. Generated 83 styles,
simplified motion and the generated Signalsmith wrapper are selected only by
the compatibility profile. Standard mode retains the original resources and
native browser APIs.

Request deadlines are shared application behavior, not a compatibility-mode
polyfill. Both modes use `AbortController` with a 10-second timer for state
startup and a 15-second timer for public room creation, cleared in `finally`
after response-body handling. Standard mode does not switch back to
`AbortSignal.timeout`, and this shared implementation does not lower its
capability floor or modify browser globals.

Compatibility mode supplies missing `replaceChildren`, `replaceAll`,
`Object.hasOwn`, `Array.at`, cryptographic UUIDs, input/focus isolation and
adapters for the relationships, viewport/container
sizes and colors used by this UI. Existing native APIs are retained. Choosing
compatibility mode crosses the ordinary authenticated entry as a fixed mode
parameter; the resulting local page retains its mode on reload. It creates no persistent
preference or alternate application data. Each cold start checks the provider
again and uses standard mode automatically when it qualifies.

On Chromium 83–90, the same authored CSS is compiled using pinned Lightning CSS,
including selector/inset/focus/overflow syntax. Scoped runtime adapters supply
flex spacing and aspect ratios. Panel CSS transitions/animations are immediate in
this mode; the current-song title retains shared scrolling and respects reduced
motion. JavaScript Web Animations retain real finish/cancel completion. The pinned
Signalsmith wrapper has a generated syntax-compatible module with identical
embedded DSP/WASM bytes. No `eval`, runtime compiler, provider installation or
second UI is used. After shared CSS changes run `npm run prepare:webview83`;
`node scripts/build_webview83.mjs --check` rejects stale artifacts.

WebView 83 UI compatibility does not establish public Remote connectivity.
The compatibility adapters cover JavaScript and layout; they do not replace
WebRTC or bypass Android network permissions. Generating a public-room QR is
separate from connecting a peer. LAN Remote uses the local HTTP/SSE Host.
Qualify WebRTC separately on each supported provider/device.

The original source capability floor above describes standard mode; it is not a
reason to bypass the compatibility mode gate or proof of device/media acceptance.
Android 11 with an updated provider may qualify; an Android OS number alone cannot select a
mode. This mode does not install or change a WebView provider.

## Diagnosis and startup checks

Open **My → Settings → Diagnostics → WebView compatibility check**. There is
also an action on the packaged startup screen. On an old/unknown provider or
missing native bridge, a native Android dialog opens before shared frontend
startup; its capability probe deliberately uses ES5 syntax.

The report includes Android/API, actual provider/package/full version,
`WEB_MESSAGE_LISTENER`, missing UI primitives, the inspected document origin,
secure-context status and media/RTC availability. “Basic capabilities pass” is
not a claim that media, network, all devices or all features passed acceptance.
Copying it does not collect room tokens, cookies or application records.

The dialog offers **Copy diagnostics** and **Close**, plus **Enter compatibility mode**
only when its eligibility checks pass on the startup page. An incompatible or
incomplete result identifies missing capabilities; it does not ask the user to
update WebView. There is no store, component-settings, download,
installation or provider-switch action in this check. bilikara's own application
updater is a separate existing feature.

Android documents the [active-provider lookup](https://developer.android.com/reference/androidx/webkit/WebViewCompat#getCurrentWebViewPackage(android.content.Context)).
Store/update availability depends on the actual provider and device/region ROM,
not just the MIUI, ColorOS or OriginOS name. Production devices enforce
configured provider/package/signature restrictions; installing a newer browser
or an arbitrary WebView APK does not establish that the Host's provider changed.
See [Chromium's provider requirements](https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/webview-providers.md)
and [vendor update distribution](https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/aosp-system-integration.md).
An emulator's successful provider update diagnoses an engine dependency; it
does not establish an update path on a retail device. Supporting an engine that
cannot be updated requires software compatibility work.

APK [`minSdkVersion`](https://developer.android.com/guide/topics/manifest/uses-sdk-element)
limits the Android OS API level. It cannot declare a minimum independently
installed WebView package version. The native minimum remains 24. Startup checks
test actual engine capabilities and the native message bridge before loading
the shared UI; raising the OS floor would not establish WebView compatibility.
The current 111 capability floor is not a newly certified device minimum.

The full Host action uses the existing main-frame, exact local-origin bridge;
the startup command is restricted to the local Android main window. Remote
pages gain no diagnostics permission.

## Validation limits

111 is the source-audited capability floor, not blanket device certification.
Report actual emulator/provider and physical-device results separately,
including any remaining native-shell errors; a modern desktop browser is not
a substitute. An offline, same-package/signer
provider update can prove recovery without certifying an app-store download or
a vendor's update availability. Historical test providers belong only in
isolated emulators, never in the product's download recommendations.

State startup and public room creation no longer depend on `AbortSignal.timeout`;
their bounded `AbortController` requests preserve cleanup, errors and recovery.
A LAN QR is obtained from local Host state and generated locally. Public-room
signaling is a separate operation. Neither the timeout fix nor an OS version
alone establishes that an old frontend parser/native bridge can run the app.

The specific `AbortSignal.timeout` defect came from calling an unguarded static
API introduced in [Chromium 103](https://developer.chrome.com/blog/new-in-chrome-103).
An absent method throws before the fetch can start. `/api/state` now uses a
10-second controller/timer and public-room creation uses 15 seconds; `finally`
clears each timer, including response-body handling. Timeout failures still
surface through the existing error/recovery path. This removes that API
dependency, not older-engine syntax, missing input/layout features or bridge
requirements. The LAN QR comes from Host state, not the public-room POST.
