# Android adaptive Host layout

Android uses the same `static/index.html`, `app.js`, workspace components and
media elements as desktop. There is one APK, no alternate tablet document,
second player, navigation reload or separate application state.

In **Settings → Appearance**, two independent preferences are available:

- **Layout: Auto / Desktop / Phone.** Auto uses the actual WebView's CSS window
  width: below 700 px uses the five-page phone dock; 700 px and above uses the
  shared desktop layout. This matches the desktop narrow-window minimum. Wide
  tablet portrait is therefore desktop too; a narrow split window is phone.
  Opening the keyboard changes available height, not this width-based choice.
- **Direction: Follow system / Landscape / Portrait.** This requests an Android
  orientation; it does not pretend the window acquired a different size. Android
  16 large-screen devices and some multi-window modes may ignore the request.
  Fullscreen playback temporarily requests landscape and restores this preference
  on exit, including Android Back. Both landscape directions are allowed.

Preferences are stored in the app's private Android SharedPreferences, not web
localStorage (the local Host port changes between launches). They are UI/window
settings, not a second Rust AppState authority. Failed saves leave the last
confirmed preference active and report an error. Requests are origin/main-frame/
Host-path scoped, bounded and timed out; remote pages cannot set these preferences.

The phone-only dock and settings embedding switch off in desktop mode. Existing
request tabs, login/cache controls and audience-display selector return to their
desktop positions, preserving the same nodes/listeners. Desktop responsive rules
still collapse tools into a drawer on short windows. Native capability restrictions
(such as deferred developer mode and diagnostic ZIP) are not bypassed by choosing
desktop layout. Deliberately forcing desktop on a very narrow phone may require
horizontal scrolling; use Auto for fitting that window.

Switching does not reset playback, queue, session, login, search drafts or the
audience output. The last active shared workspace is mapped back to its phone
page. Independent audience output keeps its own full-screen shared renderer;
changing the Host's layout does not rotate or rebuild the audience WebView.

## Acceptance

1. Leave Auto selected. Rotate a phone; inspect phone portrait and desktop
   landscape, including short-height drawers. Repeat on a wide tablet and in
   a narrow split window. Open a text keyboard: layout must not oscillate.
2. During playback, enter a search draft, switch layout several times and rotate.
   Playback must continue with the same media nodes and input contents.
3. Choose each manual layout and direction. Restart the app without uninstalling:
   preferences must remain despite the new Host port. Restore Auto/System.
4. Choose Portrait, enter player fullscreen, then exit via its control and Android
   Back. Verify the prior direction returns. Some tablets legitimately ignore locks.
5. Where an independent display is available, leave audience playback running and
   switch Host layouts. Do not confuse an emulator display with a real HDMI/mirror
   route; hardware routing and audiovisual latency require separate validation.

`tests/android_layout.cjs` and `tests/android_portrait_navigation.cjs` cover policy,
bridge failures/lifecycle, duplicate guards, workspace restoration and persisted
overrides. Live browser/device checks complement these; they do not establish
behavior on every vendor's ROM, split-window manager or physical display hardware.
`tests/live_android_layout.cjs` exercises the shared Rust Host with offline media
at phone/tablet/window sizes. `tests/live_android_layout_device.cjs` targets only
the disposable `emulator-5562`, checks real native preferences/rotation/restart,
and uses HTTP-only synthetic media for fullscreen playback (no database writes).
