# Shared native Host UI

The desktop and Android Hosts serve the same `static/index.html`, `app.js`,
controls, song cards, dialogs and translations. Both consume the authoritative
Rust Host state. Remote remains a controller with its own page and permissions;
the audience page remains a presentation surface.

`native-session.js` presents the persisted-session choice on either Host.
The shared Host song controls expose the existing rating dialog for the selected
session requester. Host and Remote submissions retain their playback identity
across layout changes, release failed submissions for retry, and check HTTP and
service failures before retaining a successful submission. The native backend
validates identity and eligible plays independently of these presentation gates.
`host-layout.js` adapts the shared controls to a phone navigation dock or the
existing desktop workspace rail. Settings offers Auto, Desktop and Phone:
Auto selects Phone below 700 CSS pixels, independently of keyboard height or
physical orientation. The desktop shell retains its minimum window size.
Desktop persists this choice with its window geometry; Android retains its
native window preferences. An ordinary browser uses origin-local storage.

Layout changes move existing non-media controls, retaining their drafts,
selection and applicable focus/scroll state. They do not reparent the player,
recreate its media elements or create another Signalsmith graph. Touch session
user controls reuse the shared reorder/remove actions; desktop mode retains
mouse dragging, context menus and keyboard navigation. The existing
`android-*` DOM hooks remain stable while the layout implementation is shared.

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
