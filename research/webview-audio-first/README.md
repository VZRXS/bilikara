# Isolated WebView Audio-First renderer

> **Retired (v0.9 Preview 1).** The native GStreamer engine (`media-engine/`,
> see `docs/media-backend.md`) supersedes this route. It is kept only as a
> research harness with its recorded Round A results; it failed the strict
> virtual synchronization gate in several startup/recovery scenarios and must
> not be enabled. No production HTML, script, setting, native startup or
> package graph references it (verified by searching `static/`, `src-tauri/`,
> `rust-runtime/` and `xtask/`), and `static/` is the only packaged frontend
> tree.

`audio-first.js` is served only by `tests/media_round_a_support.mjs` under explicit
test-only routes. No production HTML, setting or native startup imports it.
It has one audio element, the existing captured audio clock and pinned Signalsmith
worklet. It creates no Host video during dual output. A detachable video surface
follows the output timeline through the shared presentation correction policy.

The test bridge claims programs through real Native Host HTTP, reports readiness
and observed output separately, and requests Next only through the authoritative
Rust API after drain. Track selection also goes through the existing Rust API.
The renderer owns no playlist and rejects retired identities. Experimental output
relay and surface attachment are fixtures, not native multi-display acceptance.

```bash
CUDA_VISIBLE_DEVICES='' .tmp/local-build-run.sh node --test tests/media_round_a_browser.test.mjs
```

The functional test covers startup, pause/resume, seek, signed offset mapping,
actual DSP initialization, gain/mute, audio replacement, surface attachment with
the same audio/context, stale identity and Rust EOS/Next/history. It does not
qualify physical A/V timing, seamless track changes, phone route changes, Apple
autoplay or physical hotplug. A Linux WebKit pass is not an iOS/macOS device pass.
Production synchronization and manual-start fallback remain unchanged.

The sign follows `rust/src/output_audio.rs` and the production split player:
audible audio = video time minus signed offset. At zero, positive offset inserts
real audio delay; negative offset holds video frame zero while initial audio
plays. Neither opening seeks over input samples. A seek inside positive preroll
uses only its remaining silence. Flushed segments rebase on `playing`, not the
earlier `play` intent event; pause disconnects queued DSP/delay output and resume
rebuilds at the frozen program position. EOS includes DSP/delay and lagging video
tails. These are experimental execution rules, not a second Next authority.

Explicit flush/resume retires the old HTML capture input/DSP and binds a fresh
one; the AudioContext/gain and program lease stay owned by the same renderer.
This deliberately pays a rebind cost rather than assuming native media Seek
flushes WebKit's capture queue. `play()` observes the ready output leg while
retaining rejection handling for a possibly late-resolving media Promise.
The test coordinator prepares Audience frame zero before automatic Play.
A local renderer epoch carries explicit seeks across the follower's ordinary
drift deadband and rejects retired segments; it never replaces AppState's
business generation. These startup/recovery costs and remaining timing errors
must be measured before any production adoption.

`scripts/validate-audio-first-round-a.mjs` checks opening mapping plus real virtual
sink tones/mute. `scripts/validate-media-timing.mjs` separately compares actual
PulseAudio PCM pulses with decoded video barcodes. It calibrates browser clocks
against Node's monotonic clock, records pipe/callback uncertainty and separates
recovery from steady state. An 80ms virtual observation bound is a diagnostic
gate, **not** the product's physical one-frame synchronization acceptance.
Failed gates return exit code 2; unrun or unobservable physical timing remains
NOT QUALIFIED. Never relabel the functional test's coarse 450ms transport check
as synchronization evidence.

## Review qualification

[Final validation](../../docs/round-a-validation.md) includes capture-ready PCM
and decoded-frame evidence. Signed opening content/mapping is implemented, but
both engines still fail some precise virtual timing gates; this is not a
production-ready decoder retirement. Recorder readiness is observed from actual
data, and source-zero tone is checked explicitly. Production remains unchanged.
