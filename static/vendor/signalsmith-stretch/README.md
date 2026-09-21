# Signalsmith Stretch Web

Official Web release **1.3.2**, pinned to
[`57b93f4e9206a089a45387eaa39bdc9f310d3308`](https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/57b93f4e9206a089a45387eaa39bdc9f310d3308/web).
MIT; see `LICENSE.txt`. `SignalsmithStretch.js` is the upstream
`web/release/SignalsmithStretch.mjs` ES module with embedded WASM, renamed so
both Host static servers use their existing JavaScript MIME mapping.

To reproduce, download that revision's `web/release/SignalsmithStretch.mjs`
and run `python scripts/vendor_signalsmith.py /path/to/SignalsmithStretch.mjs`.
The script applies bounded JS-only changes: share WASM compilation within the
worklet realm; add terminal `destroy()`/AbortSignal handling; reject outstanding
requests on initialization/processor errors or timeout; fix dynamic channel
reconfiguration and the optional output-channel count. DSP code/WASM bytes are
unchanged. No Emscripten build or runtime download is required.

The Host's `pitch-player.js` uses live input and the default preset (120 ms
analysis blocks, 30 ms interval at the AudioContext sample rate). Formant
compensation is disabled. Media elements retain decoding and playback rate;
the wrapper's buffered-input `input`/`rate` controls are not used. The module and
worklet load once per context, from the same local static tree as the player.
Secure context, WebAssembly and AudioWorklet support are required, including
successful resource loading under the actual origin's policy. Desktop Host
uses loopback HTTP; plain LAN HTTP does not provide the same capability.

Zero shift bypasses the processor. The transient running time mapping is
`audible media time = element currentTime - latency() * playbackRate`, separate
from the user's AV delay and from device output latency. A new route re-primes
from the selected audible position with video held. Dry and wet are never
mixed. Seeking, pausing and source retirement destroy the processor (upstream
`stop()` and `dropBuffers()` do not reset live history), retaining the single
MediaElementAudioSource. Nonzero parameter changes reuse the processor.
Natural end drains two live latencies for spectral overlap, with a bounded
wall-clock fallback if the context stops; explicit retirement immediately gates
and destroys it. An incompatible media-source clock (input position jumping
ahead of context time during priming) is reported unavailable and the Host
restores native playback with a fresh element. The requested key remains intact.
No PCM travels on the main thread.

Independent synthetic browser coverage lives in `tests/browser/signalsmith_dsp.cjs`;
the Host lifecycle regression is `tests/audio_pitch_lifecycle.cjs`.
