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

Phone Host reuses Remote's shared request components where the workflow fits.
For example, Sources keeps the UID field, add and manual-refresh controls on
one row at phone widths, using the same definition rather than a phone-only
copy. Native Host pagination remains panel chrome: Sources places its pager
below the internally scrolling list and fits complete rows to the available
width/height. Resizing keeps the previously visible item in range and retains
selections. Remote keeps its document scrolling and fixed source-page limit.
Android search, discovery and source-detail results also reuse Remote's shared
result pager: swipe horizontally or use its page number and previous/next
buttons. Their footer stays outside the internally scrolling result list.
Swiping a source card changes pages; long-press selection and source editing
retain their own gestures without triggering pagination.

The phone layout targets a minimum 360 CSS px window width and also checks
320 px without horizontal overflow. Source frames fit complete rows at usable
heights from 640 to 1000 CSS px, keeping their 44 px action row and bottom
pagination. System bars reduce the actual WebView height; record that height separately
from the emulator's physical display size. The soft keyboard overlays the fixed
phone dock rather than moving it upward. Input content and transient messages
avoid the keyboard independently.
Hover-only colors, lifts and previews require an actual hover-capable fine
pointer. Touch-only windows retain tap/pressed, keyboard-focus, busy and
disabled feedback; synthetic mouse events after a tap do not activate hover
help or pause countdowns. The login QR is itself a keyboard-accessible refresh
action; it retains visible focus and pressed/busy feedback without a separate button.
Long-press selection retains the page capacity and media nodes. See
[source management](source-management.md) for its floating tools and gestures.

My keeps Bilibili login and playback/download settings in separate rounded
cards. The compact login status aligns with its heading. Queue, history,
request, session-user and My pages place their shared bilingual heading outside
the content card. Queue/history actions align with the top-right of the entire
heading pair. Settings uses an external chevron Back action without a duplicate
page title. Session-user prerequisites and editing guidance appear below the
form only while the roster is empty. Request search, discovery and source cards
keep equal 14px top/side insets; contextual segmented fills stay inside their track.
The audience-display menu reuses the
desktop menu surface and spacing; its trigger uses the shared 60px status-button
width beside the 44px phone-access button.
Android audience output has no corner buttons: opening the main Host's phone
access menu shows its QR panel in the audience's top-right corner, and closing
the main menu closes that panel. The existing ordered presentation messages own
this visibility; stale generations or sequences cannot reopen a dismissed panel.
Desktop audience controls keep their existing behavior.

The phone dock retains five full-width touch slots, with each selected accent
surface capped at 68px. My scrolls inside a frame with equal 14px edge insets,
so the top and bottom frame remain visible. My/Settings transitions use the
existing Web Animations API, preserving the page's measured position and My's
scroll offset, including rapid navigation and reduced motion.

While a Bilibili QR is waiting, its original 13px Bilibili App scan guidance,
alternative label and browser link share the right column, centered within
the QR's height. Clicking the QR or the signed-out badge requests a new code;
expiry also refreshes it while the account surface is open. Every path uses
the same login generation and removes the previous browser link while pending.
Retain equal 14px card content insets. Login and phone-access QR images have no
internal border and share the same fixed 3px white UI frame, without stacking
another quiet zone or reserving a refresh-button row. The link opens the same QR webpage in
the system browser. It does not replace the Host document. The link
is authenticated Host state, disappears when that login is replaced or ends,
and accepts only the login service's two HTTPS Bilibili origins. Availability
of the webpage and account confirmation in a particular browser are separate
from successfully opening that browser; scanning the QR remains available.

Identify display uses the shared numbered identifier page in small native
windows near each display's upper-left corner. It does not intercept input or
dim the Host. Identifiers close automatically after about three seconds; the
Identify button stays busy until their windows and WebViews have been closed.

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
7. At 360 and 320 CSS px widths, check Sources at 640, 800 and 1000 CSS px
   heights in Chinese, English and Japanese. Long-press a card, scroll to covered
   items, change pages and exit selection. Check the native screen capture as
   well as the DOM after layout settles; one transient matching frame is not
   evidence that the rendered page retained its capacity. Keep the same Host
   document during resize checks rather than navigating it through DevTools.

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
