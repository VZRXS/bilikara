# Android independent audience display

The phone remains the Host/control surface. Android `Presentation` hosts the
same `controller.html` audience stage used on desktop. No alternate Remote,
playlist, cache, audio engine or Rust AppState is created.

## Using it at a venue

1. Connect HDMI or the system wireless display **first**. Merely connecting to
   the venue's WiFi does not create an external display.
2. Open **My → Settings → Dual display**, refresh, and select an external screen.
   **Identify displays** shows its number and resolution for four seconds.
3. Enable the switch. Wait until the status becomes active. The phone keeps its
   queue/search/settings pages; the audience screen shows the shared stage.
4. Test play/pause, seek, On/Off vocal, AV delay, and at least two consecutive
   songs. Confirm the actual audio output (phone/HDMI/receiver/Bluetooth).
5. Keep the app foreground and the phone unlocked. Backgrounding/locking still
   pauses playback; returning resumes only the same eligible playback session.
6. Disable the switch to return to single-screen, or disconnect the output.
   Reconnecting requires selecting/enabling the new attachment again.

If only the phone is listed, the current route does not expose an independently
addressable Presentation display. This may be a mirror-only receiver or an
unsupported phone/adapter/ROM combination. Continue using system mirroring;
this feature does not implement DLNA, Cast receiver playback or a custom stream.

If activation fails, the app returns to single-screen. Copy diagnostic Markdown
from Settings. The **Android UI → external_display** section contains numeric
display capabilities, window generation/phase, a bounded event history and stage
telemetry (media clock difference, readiness, dropped frames, error code). It
does not include receiver names, media URLs, cookies or QR credentials.

## Architecture and safety

- Kotlin owns display enumeration, window lifetime, attachment-generation
  tokens and a restricted message bridge. It does not own business or playback
  state. Display IDs are scoped to the current attachment and never persisted.
- The main shared Host keeps its existing video/audio and playback clock.
  The audience WebView plays **muted video only** and follows the same scene /
  clock protocol as desktop. This currently costs an additional video decoder;
  it is not zero-copy rendering or a second independent media authority.
- The Android bridge replaces desktop IPC for display commands only. It does
  not expose desktop restart, filesystem, arbitrary navigation or generic IPC.
  Exact process-issued loopback origin, main-frame, document-role, WebView
  identity and generation checks reject foreign/stale messages.
- Clock messages travel through the native bridge, not through assumptions
  about BroadcastChannel/storage sharing between Android WebViews. No new
  polling of the network Host, Worker, D1 or Bilibili is required.
- The output freezes on stale clock input after two seconds; the native window
  returns to single-screen after five seconds without Host messages while
  foregrounded. Activation has a 15-second readiness deadline. Output video
  failure, renderer loss or disconnection releases the output WebView.
- Window creation is non-focusable so the phone remains interactive. A second
  window must not steal focus and accidentally trigger Android's pause policy.
- Android uses the Host's locally generated Remote QR image on the stage, not
  an external QR service.

Hardware display support, audio routing, receiver buffering and long-session
reliability require venue testing. Emulator/fixture tests cannot establish
physical HDMI/WiFi audio/video latency. There is no new fixed AV compensation.

## Regression checks

```powershell
python -m unittest tests.test_android_presentation tests.test_android_portrait tests.test_controller_frontend tests.test_presentation_host_frontend -v
npm run android:build:debug
```

`tests/android_presentation.cjs` exercises request settlement, unsupported
commands, message unsubscribe/teardown, muted stage playback, next-song
replacement, generation rejection, transport timeout and background suspension.

`tests/live_android_presentation.cjs` is an opt-in acceptance harness for a
dedicated, disposable `emulator-5562` with a developer secondary-display overlay
and its WebView debug port forwarded. Do not use a personal-data emulator.
`probe` mode checks the actual APK's display activation/disconnection. `playback`
mode requires an empty queue plus self-generated `fixture-video.mp4` and
`fixture-audio.m4a` in its output directory. It intercepts media/API responses
with synthetic fixtures; it does not test downloading, Bilibili or Rust cache
publication. Real Android WebViews, video decoding, native window/bridge,
seek/next-song, Activity background/resume and disconnection are exercised.
The harness removes its secondary-display overlay after a successful run.

WebView debugger screenshots may omit hardware video layers. Acceptance also
checks decoded pixels, visible video bounds and an Android-native screenshot.

References: [Android Presentation](https://developer.android.com/reference/android/app/Presentation),
[presentation display discovery](https://developer.android.com/reference/android/hardware/display/DisplayManager#DISPLAY_CATEGORY_PRESENTATION).
