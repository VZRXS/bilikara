# Shared native Host UI

The desktop and Android Hosts serve the same `static/index.html`, `app.js`,
controls, song cards, dialogs and translations. Both consume the authoritative
Rust Host state. Remote remains a controller with its own page and permissions;
the audience page remains a presentation surface.

The behavior baseline is the shipped preview.1 Python desktop Host plus later
user-approved changes. Android reuses those shared components; improvements
from Android may supplement the desktop when they preserve its existing flows.
Viewport width, input method and native capabilities are separate concerns:
a compact desktop must not inherit Android-only action restrictions. The compact
Android account page waits for an explicit login action, while opening desktop
Settings retains automatic QR preparation even in a narrow window.

`native-session.js` presents the persisted-session choice on either Host.
Continuing keeps the saved session; dismissing the banner or letting its
10-second countdown finish starts a new session through the same Rust command.
Hover, keyboard focus and a hidden page pause the countdown. A failed command
leaves the banner available for retry without retrying automatically.
The shared Host song controls expose the existing rating dialog for the selected
session requester. Host and Remote submissions retain their playback identity
across layout changes, release failed submissions for retry, and check HTTP and
service failures before retaining a successful submission. The native backend
validates identity and eligible plays independently of these presentation gates.
`host-layout.js` adapts the shared controls to a phone navigation dock or the
existing desktop workspace rail. Preview 2 uses responsive layout without an
Auto/Desktop/Phone selector: Phone applies below 700 CSS pixels, independently
of keyboard height or physical orientation. The desktop shell retains its
minimum window size. Earlier manual layout preferences remain stored but do
not override this responsive behavior. Android's orientation control remains
a separate device-local preference.

Layout changes move existing non-media controls, retaining their drafts,
selection and applicable focus/scroll state. They do not reparent the player,
recreate its media elements or create another Signalsmith graph. The existing
`android-*` DOM hooks remain stable while the layout implementation is shared.

Common components have one maintained structure, action definition and base
style, rather than a shared initial render followed by a separate phone render:

- `app.js` owns the session-user badges and their reorder/remove controls,
  including pending state, translations and retry feedback. Existing badge and
  button nodes survive reordering and responsive changes. Both layouts expose
  the same keyboard-accessible actions; pointer layouts also retain dragging.
  Touch targets adapt to input capability; narrow width alone does not disable
  desktop dragging. A mixed mouse/touch device retains its mouse operations.
- `index.html` groups account status and login into one section. Layout code
  moves that section and the cache-settings container as units. Cache fields
  retain their common order and wrap through shared Flex rules; a new field
  does not need adding to a second phone placement list.
- The desktop workspace rail defines equivalent navigation labels, icons,
  targets and compact-page grouping. The dock and compact workspace tabs reuse
  those definitions. Playback and My remain compact outer-page entries.
- `styles.css` owns component visuals and tokens. `host-layout.css` adapts
  placement, available space and touch geometry without a second component
  renderer. A shared component change must reach both native Hosts from that
  shared definition; a layout preference alone does not establish this.

Platform adapters stay narrow:

- Desktop Tauri owns window preferences, native dialogs, exports, validated
  external links and update activation. Shell commands verify the main window
  and its native Host origin; a frontend capability flag grants no permission.
- Android owns orientation/fullscreen, background playback handling,
  permission/share dialogs and APK verification/system installation consent.
  `android-host.js` contains only Android window/display hooks. Its playback,
  export and presentation adapters remain separate from the shared UI.
- `host-updates.js` supplies one update action interface to the shared controls.
  Desktop uses the private shell activation boundary; Android uses its APK
  adapter and Rust operation settlement. Neither can enter the other's installer.
  See [native desktop deployment](native-desktop.md) for supported installation
  layouts and the Preview 1 macOS transition limitation.

Tauri embeds the same maintained `static/` directory for Android. Desktop
bundles stage that directory alongside the native backend. The desktop startup
and update validators require the shared layout/session/update modules, so a
package missing these resources fails explicitly.

Android remains a preview. Background playback, external display/audio routing
and device-specific WebView behavior retain their documented limitations;
sharing the interface does not certify long sessions or casting. Desktop
feature parity and platform acceptance remain separate from UI convergence.
