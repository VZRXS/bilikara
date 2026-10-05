# Android adaptive Host layout

Android uses the same `static/index.html`, `app.js`, workspace components and
media elements as desktop. There is one APK, no alternate tablet document,
second player, navigation reload or separate application state.

Layout adapts automatically to the actual WebView's CSS window width: below
700 px uses the five-page Android phone dock; 700 px and above uses the shared
desktop layout. Wide tablet portrait is therefore desktop too; a narrow split
window is phone. Opening the keyboard changes available height, not this
width-based choice. Native desktop windows keep desktop navigation at every
width and use their existing narrow workspace layout.

Host settings have no manual layout or screen-direction selector. Ordinary
Android windows follow the system auto-rotation setting; earlier saved manual
layout/direction values do not pin them. Fullscreen playback temporarily requests
landscape and returns to system orientation on exit, including Android Back.
Some large-screen and multi-window Android environments may ignore fullscreen
orientation requests.

Existing private window-preference storage and its bounded, origin/main-frame/
Host-path-scoped bridge remain compatible. They own no playlist/session/player
state. The native storage tests retain failed-save/rollback and confirmed-pair
checks; normal responsive layout and rotation do not write those preferences.

The phone-only dock and settings embedding switch off at desktop widths. Existing
request tabs, login/cache controls and audience-display selector return to their
desktop positions, preserving the same nodes/listeners. Desktop responsive rules
still collapse tools into a drawer on short windows. Native capability
restrictions are unchanged.

Resizing and rotation do not reset playback, queue, session, login, search drafts
or audience output. The last active shared workspace is mapped back to its phone
page. Independent audience output keeps its own shared fullscreen renderer;
Host resizing does not rotate or rebuild the audience WebView.

## Player touch controls

In both phone and desktop layouts on Android, a single tap on the video reveals
the native controls without toggling playback. Double-tap the video to play/pause;
use the explicit fullscreen button to enter or leave fullscreen. Native play
buttons and the seekbar keep their normal single-tap/drag actions. Scrubbing a
playing song retains its resume intent; scrubbing a paused song leaves it paused.
Desktop browser and desktop Tauri click/fullscreen shortcuts are unchanged.

## Acceptance

1. Enable system auto-rotation and rotate a phone; inspect phone portrait and desktop
   landscape, including short-height drawers. Repeat on a wide tablet and in
   a narrow split window. Open a text keyboard: layout must not oscillate.
2. During playback, enter a search draft, resize the window several times and rotate.
   Playback must continue with the same media nodes and input contents.
3. Restart the app without uninstalling. Layout must remain responsive despite
   the new Host port and any older saved manual preferences. Neither desktop nor
   phone settings should contain a manual direction selector.
4. From portrait, enter player fullscreen, then exit via its control and Android
   Back. Verify system orientation returns and later system rotation still works.
5. Where an independent display is available, leave audience playback running and
   switch Host layouts. Do not confuse an emulator display with a real HDMI/mirror
   route; hardware routing and audiovisual latency require separate validation.
6. Single-tap the video to reveal controls, drag its seekbar, then double-tap to
   pause/resume. Repeat while paused and in fullscreen. A seek must not turn a
   temporary native scrub pause into a permanent user pause, or resume a song
   that was already paused. The native play button must still respond to one tap.

`tests/android_layout.cjs` and `tests/android_portrait_navigation.cjs` cover policy,
bridge failures/lifecycle, workspace restoration, system rotation and ignored
legacy overrides. Live browser/device checks complement these; they do not establish
behavior on every vendor's ROM, split-window manager or physical display hardware.
`tests/live_android_layout.cjs` exercises the shared Rust Host with offline media
at phone/tablet/window sizes. `tests/live_android_layout_device.cjs` targets only
the disposable `emulator-5562`, checks real system rotation/restart with restored emulator settings,
and uses HTTP-only synthetic media for fullscreen playback (no database writes).
`tests/android_player_gestures.cjs`, `tests/android_playback_visibility.cjs` and
`tests/live_android_player_gestures.cjs` cover gesture ordering, cancellation,
native-control dragging while playing/paused, and phone/wide/fullscreen views.
`HostWindowPreferencesTest.kt` runs native Kotlin against a SharedPreferences
interface double that changes memory before a failed disk result and serializes
the whole map on later writes. It checks both field orders, returned snapshot
maps, Activity-helper recreation, recovery failure and write exceptions. It is
separate from JS rejection mocks and from the instrumented fullscreen test;
the latter still needs an Android environment.
