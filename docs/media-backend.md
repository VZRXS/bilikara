# Playback execution boundary

Rust AppState remains the business authority. A media backend executes one
authorized program; it never owns a playlist, selects Next, admits artifacts,
changes history, or substitutes a renderer clock for a business generation.
The WebView split player remains available as Legacy / Compatibility Mode. The
Linux desktop preview adds the native GStreamer engine (see below). Experimental
renderers under `research/` are not imported by Host, Remote or native product
packages.

## Current ownership

| Responsibility | Current owner and boundary |
| --- | --- |
| Intent entry | Host controls in `static/app.js`; Remote HTTP controls; desktop/iOS/Android presentation commands and native media-session callbacks |
| Admission and business commit | `rust-runtime/src/app_state.rs` and its native-session adapters under the serialized AppState authority; queue version and playback generation protect Next/order changes |
| Renderer binding | `createHostPlaybackSession`, exact program claim and `mountHostPlaybackSessionElements` in `static/app.js`; one existing video/audio pair, one artifact owner |
| Local media execution | HTML video plus independent HTML audio in that pair; `setSplitPlaybackIntent`, `seekHostPlayer`, existing startup recovery and `syncSplitPlayer` |
| DSP and volume | `ensureAudioPitchSource`, `applyKeyShiftToAudio`, `static/pitch-player.js` and pinned Signalsmith; native element volume or the existing Web Audio gain path |
| Local time mapping | Video remains the navigation/readiness reference. Split synchronization relates it to offset-adjusted audio. Captured Web Audio paths additionally use `static/audio-clock.js` output segments and DSP/alignment latency; an element's read-ahead cursor alone is not audible time |
| Readiness and success | Exact session claim, both metadata/readiness checks and `commitHostPlaybackSessionReadyPaused`; actual playing observation is separate from a successful `play()` Promise |
| EOS and failure | Existing startup watchdog/recovery and `handleSplitAudioEnded`; capture, pitch and alignment tails drain before the existing Host generation-checked transition. The backend only observes EOS |
| Ordinary independent Audience | Separate muted video in `static/controller.js`, following Host clock publications through `static/presentation-sync.js`; it cannot choose Next or write history |
| Native HLS preview | `static/native-output.js` consumes the Rust generation/period/lease-bound output timeline using admitted MSE or system HLS. In independent output the Audience may own the stream's audio while Host preview is muted; this differs from ordinary split output |
| DLNA L0/L1 | Rust Native Host Pure K/output services and the admitted receiver transport. L0 packet delivery and L1 audio processing/TS timestamps are not equivalent to local WebView execution. `experimental_libav/live_audio.rs` is an existing L1 PCM/TS service, not a local platform audio sink |
| Window/display lifecycle | Desktop presentation WebView; iOS independent WKWebView scene; Android HostPresentation WebView. OS mirroring and independent extended output remain distinct |
| UI and transport | Host/Remote controls, QR, overlay composition, presentation session/heartbeat, native audio-session policy and authorized network protocols remain outside a replaceable media engine |

The reusable pieces are immutable program identity, exact artifact lifetime
claims, application settings, backend observations, the shared clock-correction
policy and pinned DSP assets. Existing WebKit startup/seek/readiness execution is
implementation-specific and is not a portable media engine.

## Minimal LegacyPlaybackAdapter contract (MEDIA-ARCH-01/02/07)

`static/media-backend.js` exposes `createLegacyPlaybackAdapter`. It is a thin,
generation-bound facade over callbacks owned by the existing playback session.
It creates no media, timer, command queue, artifact claim or AppState mirror.
Production uses it for loading an already-mounted pair after the original claim;
other ports are available without rerouting the entire existing control graph.

Every operation supplies the complete immutable program identity:

```js
{
  playback_generation, item_id, item_incarnation_id,
  selected_audio_variant_id, artifact_set_id
}
```

The session validates it against current AppState and the exact existing pair.
A stale identity or disposed facade throws synchronously before delegation.
Owners of asynchronous operations retain their existing checks after awaits.
The facade returns a delegated synchronous value or the exact delegated Promise;
it does not turn an immediate user-gesture operation into an asynchronous queue.
New observation callbacks run after the owner's synchronous commit on a
microtask, with another identity/disposal check; a callback cannot retire a
session halfway through its readiness commit. This does not queue commands.

| Operation | Domain contract |
| --- | --- |
| `load(identity)` | Start binding/loading the authorized, already-owned program; existing owner admits artifacts and handles readiness |
| `play(identity, options)`, `pause(identity)` | Existing intent and autoplay/manual-start behavior; no readiness or playing guarantee from command return alone |
| `seek(identity, seconds)` | Video-program timeline in seconds; existing asynchronous settlement/cancellation semantics |
| `setVolume(identity, gain, muted, options)` | Existing normalized gain (1 = 100%) and mute/settings orchestration |
| `setKeyShift(identity, semitones)` | Existing pitch control, processing and settings admission |
| `setAvDelay(identity, milliseconds)` | Existing signed AV Delay and settings admission; not a guessed IPC latency |
| `selectAudioVariant(identity, variantId)` | Existing exact-incarnation Host action; Rust decides the resulting generation/artifact selection |
| `snapshot(identity)` | Program navigation `timeSeconds` (same timeline as seek), separate `audioTimeSeconds` with `audioTimeBasis`, phase/readiness/observed-playing/duration/settings; no media element or native pointer. Neither reported media time nor an output segment is physical microphone/photodiode proof |
| `subscribe(callback)` | Unsubscribe function; observers cannot authorize Next or interfere with execution |
| `stop(identity)`, `dispose()` | Stop through the existing session's retirement; disposal revokes observers once. Existing session teardown owns nodes, DSP, pending work and lease release |

Capabilities describe the adapter's implemented operations, not a promise that
every engine/device can activate them. Existing capability probes and explicit
unavailable/manual-start states still apply. `ready`, observed `playing`, generic
playback `error`, phase changes and drained `eos` are distinct observations.
EOS is not acknowledged by the facade; the existing Host remains responsible for
generation validation, history and exactly-once advancement.

## Playback engine selection (v0.9 Preview 1)

Runtime settings → *Playback engine* offers **GStreamer** and **Legacy /
Compatibility Mode**.
The preference is persisted by the desktop shell in `media-engine-v1.json`
beside the Host UI preferences; Remote and Audience never change it. The row
shows the configured preference and, separately, the engine that currently runs
the program (`data-configured-engine` / `data-active-engine`) plus any fallback.
An engine the build or device cannot run is shown disabled with its reason
(`not-qualified-on-platform`, `runtime-plugins-missing` or
`webview-renderer-unsupported`) and never selected.

| Platform | GStreamer | Default |
| --- | --- | --- |
| Linux x86_64 desktop (new preview artifact) | Available when the system GStreamer 1.20+ runtime and base/good/libav plugins are present and WebKitGTK runs its default DMA-BUF renderer | GStreamer |
| Windows, macOS, Android, iOS | Not included in this preview; reported `not-qualified-on-platform` | Legacy |

### Architecture

- `media-engine/` is a standalone Rust crate. It runs one pipeline per
  authorized program: independent `uridecodebin` video and audio branches, a
  Signalsmith pitch element with priming and tail drain, signed AV delay through
  sink `ts-offset`, and an appsink that hands BGRx frames to a frame sink.
  Hardware decoders are ranked out by default. The shell runs the pipeline on
  the monotonic system clock; the audio sink keeps its default skew slaving.
- A PulseAudio sink opens its stream only when the program first plays: the
  program prerolls on video while the sink's input is held. libpulse
  15.99–16.x reports a stream that was created corked as having played since
  its creation (fixed in PulseAudio 17), which otherwise delays the first
  samples by the whole paused preroll — the Host countdown — and leaves the
  sound behind the picture. Loopback HTTP media never uses a proxy from the
  environment.
- Every command and observation carries the complete program identity. The
  engine rejects stale identities (`stale-program`) and reports `eos` exactly
  once per program segment (seek sequence numbers and a drain token), so a
  superseded segment or a retired pipeline can never complete the current
  program. Watchdogs bound preroll (20 s), stalls (5 s) and EOS drain (2.5 s).
- `src-tauri/src/native_media.rs` hosts the engine inside the shell process,
  which owns the windows and the audio device. Tauri commands
  (`media_engine_command`, `get_media_engine_status`, `get_media_engine_snapshot`,
  `set_media_engine_preference`, `set_media_engine_surface`) are granted only to
  the main window, except the controller's surface registration. Observations are
  emitted to the main window as `media-engine://observation`.
- Frames never cross JavaScript IPC. The shell paints the latest frame beneath
  the transparent WebView in its GTK draw handler (`CAIRO_OPERATOR_DEST_OVER`,
  contain-fit with black letterbox). Only WebKitGTK's DMA-BUF renderer clears
  pixels that become transparent; with `WEBKIT_DISABLE_DMABUF_RENDERER` or
  `WEBKIT_DISABLE_COMPOSITING_MODE` set, stale page pixels would cover the
  video, so the engine reports `webview-renderer-unsupported` instead. The page only reports the stage rectangle
  and punches a transparent hole into its own stage background, so DOM controls
  and overlays stay above the video. Moving the video between the Host stage and
  the Audience window changes only the paint target; it never creates another
  decoder.
- `static/native-playback.js` exposes media-element-shaped facades over one
  native controller, so existing status reports, presentation publication and
  Remote progress read `currentTime`/`duration`/`paused` unchanged, while writes
  are routed to the engine for that exact program.

### Ownership

Rust AppState remains the only business authority. The Host page claims the
program exactly as for Legacy and binds the claimed program to the engine. The
engine executes it; `eos` is only an observation that enters the existing
generation-checked `handleLocalPlaybackEnded` transition. The engine never
selects Next, reorders the queue, writes history or admits media. Network output
(DLNA/Pure K) keeps its own authority: while a receiver owns playback the Host
uses the existing Legacy preview path.

### Switching and fallback

Changing the preference is a deliberate reload: the current execution retires
and the same claimed program remounts on the selected engine at its preserved
logical position, play/pause intent, volume, mute, selected audio variant, key
shift and AV delay. Program ownership is retained, so AppState refuses to
re-admit a generation this client retired and no Next or history entry is
produced. Observations from the retired engine are dropped by identity.

A fatal engine error, a failed load or a second stall within one program falls
back once to Legacy for the same claimed program at the preserved position. The
fallback stays in effect, and is shown in Settings, until the user explicitly
selects GStreamer again; there is no retry loop and no application restart.

### Rollback

Selecting Legacy / Compatibility Mode restores the WebView split player; the
Legacy path itself is unchanged. The Audio-First test harness from Round A
remains research-only and is not a product path. Physical display, audio device,
hot-plug and long-session acceptance on real hardware are separate from the
virtual-output tests (see the platform qualification in the
[v0.9 Preview 1 release notes](releases/v0.9.0-preview.1.md)). [Round A validation](round-a-validation.md) records the earlier
prototype results that this engine replaces.
