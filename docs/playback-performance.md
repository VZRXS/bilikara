# Playback performance measurements

Measure the whole route, keeping product qualification separate from component
profiles. Single-screen normally includes one local video decoder and the
separate audio/DSP graph. Independent Audience adds a muted video decoder and
compositor. DLNA L0 copies compatible H.264/AAC packets into live MPEG-TS; L1
retains video packet copy while decoding, adjusting and encoding AAC audio.
Neither mode implies realtime H.264 video encoding. Include the actual local
preview behavior and receiver buffers when comparing configurations.

## Reproducible Linux software profile

Use the repository's configured build wrapper/environment and prepared full
libav companion. Keep outputs, browser caches and temporary media in the user's
chosen build volume. No GPU is needed. For example:

```bash
CUDA_VISIBLE_DEVICES='' .tmp/local-build-run.sh node scripts/profile-playback.mjs \
  --profile 1280x720:30 --engine chromium --seconds 60 \
  --modes idle,single,dual,dlna-l0,dlna-l1,native-single,native-dual \
  --output /absolute/path/outside-the-checkout/profile-720p-chromium
```

Always fetch the latest private `main` before choosing a baseline; historical
SHAs are provenance, not a prerequisite. Record the actual source SHA, dirty
state and tracked diff digest for each run. Compare pre-change and optimized
sources under identical conditions; disclose differences rather than relabeling
old measurements. Do not run builds or tests concurrently with steady samples.

For comparisons across invocations, use the SAME explicit
`--fixture-cache /absolute/HDD/path/outside-the-checkout`. The tool retains the
synthetic H.264/AAC bitstreams and verifies their SHA-256 before reuse; matching
encoder settings alone do not prove matching compressed inputs. Keep this cache
and its manifest with the evidence. An incomplete or modified cache is rejected
rather than silently overwritten. Different resolutions/durations use separate
cache entries. `--static-dir /baseline-checkout/static` can serve a preserved
pre-change frontend through the same current Rust fixture and observer. Reports
record frontend commit/dirty/static-tree independently from tooling/backend SHA
and Runtime tree; verify the backend trees match before comparing UI changes.

Use `--repeats 3` for isolated repetitions (each owns fresh Host/browser processes).
`--host-viewport 1280x800` and `--audience-viewport 1920x1080` set the independent
logical viewports. Host and Audience have separate software browser processes
so their CPU/PSS can be attributed; this differs from the older shared-browser
profile and its extra process overhead must not be interpreted as a regression.
`--seconds` accepts 10–1800 seconds; 60 seconds is the ordinary comparison window,
while a 10-second diagnostic does not qualify a steady or sustained result.
`--build-mode dev` records the existing debug-only alpha companion admission;
this harness explicitly rejects a release label. A packaged release measurement
requires a separate native product launch, not a renamed dev result.

The `native-single`/`native-dual` modes select the actual Rust L1 local output,
fetch its authenticated HLS and decode it in the shipped sink. They require the
real full companion. An unavailable decoder is recorded `UNSUPPORTED` without
selecting a fake pipeline. DLNA uses an independent consuming SOAP/TS fixture;
it is neither Native HLS nor a qualified physical receiver.

Measurement-only switches (never shipping player settings):

- `--dual-experiment baseline|pause|retire|static`: current dual behavior;
  pause only the Host video; additionally release its source; or retain the
  Audience bridge/overlay without its video. Pause/retire suppress the paired
  pause handler and automatic video play only within this diagnostic. Remaining
  readiness, seek/EOS and restoration dependencies can still fail: use
  `--actions` and inspect each outcome, never call a paused video an optimization.
- `--overlay on|off` enables a synthetic five-row countdown; `--qr-bytes N`
  adds a bounded synthetic data image for serialization attribution. Reports
  retain lengths/timings only, never QR, password, authorization or media URLs.
- `--effects baseline|flat` removes CSS blur/shadow/animation only in the
  measurement page for attribution; it never changes shipped appearance.
- `--hls-worker off|on` rewrites only the test-loaded decoder configuration.
  Worker creation and HLS/SourceBuffer events are observations, not evidence
  of Tauri asset/CSP, Android or iOS worker compatibility. `--worker-policy production`
  retains the actual Host CSP and records blocked/fallback worker admission.
  The separate `allow-blob` diagnostic changes only the test document's
  `worker-src` header, retaining other directives; compare worker off/on under
  this same diagnostic policy. It never changes product CSP or proves that a
  packaged application supports blob workers.
- `--actions` separately records pause/resume, seek, Next, actual EOS and return
  to single-screen after steady sampling. Seek waits for the local position or the new authoritative HLS generation; full media/PCM regressions remain mandatory.

Use `--frame-observer counters` to check observation overhead without registering
continuous requestVideoFrameCallback loops. Decode/quality counters and media
clocks remain observable; zero callback samples in this mode means NOT OBSERVED,
not zero delivered frames. Compare it with the same cached input and normal
observer before attributing hidden-video costs.

`--cpu-profile` captures separate Chromium Host/Audience main-thread CDP CPU
samples. It redacts script URLs to known static basenames and filters function
names before persistence; no arguments or QR contents are retained. Keep this
sampling diagnostic separate from ordinary resource comparisons. It does not
sample native decoder/Rust threads or qualify a native OS bridge.

Reports include per-process/tree CPU and RSS/PSS, average/p95 CPU, frame callback
intervals/counters and actual media state, clock drift, bounded JS function
samples, actual DOM mutations, long tasks where supported, HLS/SourceBuffer
activity and Chromium layout/style/task counters. The Node relay round trip and
message age are measured fixture IPC, not native OS bridge latency. Physical
presentation, audible output, hardware decode, audio underruns and native CPU
flamegraphs remain unavailable unless separately collected. An empty error list
never proves these signals. No arbitrary CPU threshold is a CI acceptance gate.

Repeat independently with `--engine webkit`, `--profile 1920x1080:30` and
`1920x1080:60` as needed. Each evidence directory is unique; do not overwrite a
previous report. Run one profile at a time without competing builds/tests and
record shared-machine load. The tool selects current native fixtures through
Cargo unless explicitly supplied already-built fixture paths. Cached media is
published through the isolated Native Host fixture's real Rust AppState; the
debug-only companion admission reuses the native L0/L1 capability probe.
This is not a packaged Tauri desktop launch or an Android APK.

The generated H.264 fixture uses a bounded target bitrate (2/5/8 Mbit/s for
720p30/1080p30/1080p60) and AAC at 192 kbit/s. Generation, builds, startup and
three-second warmup are outside the steady sampling window. The report records
source commit/dirty flag, engine/version, machine/CPU/affinity/nice, fixture and
per-process-tree CPU/PSS/RSS samples. CPU 100% means one logical core. PSS counts
shared pages proportionally; summing RSS overestimates physical memory. Samples
follow owned child processes across threads, and may miss CPU spent by a very
short-lived child between samples. Browser/Host are counted separately; the
independent synthetic receiver and measurement driver are excluded.

Presented video-frame callbacks, decoded/dropped counters, actual media clocks,
pause/readiness state and delivered TS bytes are retained. Frame counters are
plain JavaScript properties, never per-frame DOM mutations. Do not infer zero
decoded work from a reset counter: the report's legacy
`decoded` field is the browser's `totalVideoFrames`, not an independent decoder
thread count. Seek/source changes may reset it and invalidate endpoint deltas.
A local video paused under admitted DLNA is recorded as paused; do not label that mode as an active
local preview. L0 uses the diagnostic pipeline endpoint with local playback;
L1 uses the ordinary explicit player-output selection. Compare these different
ownership modes explicitly. The dual-screen OS relay and DLNA renderer are
local test fixtures, not a physical output path. WebKit's hardware H.264 plugin
ranks and Chromium's acceleration are disabled for this software comparison.

Run `tests/presentation_timing_browser.test.mjs` for its mandatory clock/PCM matrix,
including repeated delay, pitch, paused seeks and foreground recovery. A
performance sample does not replace those assertions or native acceptance.

## Android and desktop product measurements

On Android, record APK commit/hash, ABI, signature mode, Android version,
WebView package/version, display dimensions and thermal/power state. Include
the Host app and its isolated WebView renderers, native runtime, Audience and
media components. Use owned-process CPU/PSS samples and process-targeted
Perfetto/Android Studio traces; distinguish UI frame times from presented video
frames. A headless software-rendered emulator can expose WebView CPU/heap,
decoder stalls and relative costs. It cannot model ARM hardware decoding,
GPU/codec power, temperature, physical external displays or complete native
product overhead when only the current Web UI is under test.

For Windows, profile the extracted native app, its Host and all WebView2 child
processes, including Video Decode/Encode/3D GPU engines. For macOS, include the
native shell, Host and WebKit processes with Time Profiler/VM measurements.
Keep single/dual output, 720p30/1080p30/1080p60, DSP bypass/on, and concurrent
download/automatic analysis as separate scenarios. Measure CPU core-ms/s,
private/PSS memory, presented/dropped frames, drift, stall/recovery p50/p95,
audio underruns, output queue/backpressure, power and temperature. Include idle
and warm-cache baselines; repeat sustained tests for at least 30 minutes on
the actual candidate hardware and operating system.

Do not translate a Linux CPU percentage, emulator vCPU count or DevTools CPU
throttling factor into a named ARM/Intel/AMD minimum. A minimum recommendation
needs sustained acceptable playback/interaction with memory and thermal
headroom on actual low-end devices. Hardware H.264/AAC support, available RAM
after OS/background processes, two-decoder admission and receiver/network
capacity are independent constraints. State provisional assumptions and avoid
claiming that a successful compile or a short software profile qualifies them.

## iOS AirPlay comparison

Physical iPhone/iPad transmission is required. Linux WebKit and Simulator can
exercise the shared media/state logic but cannot certify the AirPlay encoder,
AVAudioSession route, radio/network, receiver decode or end-to-end AV delay.
Use the same cached, time-coded sample and OS/app version across:

- single-screen local playback;
- system screen mirroring;
- independent UIKit Audience output;
- video-element handoff control/default arms, separately from DLNA;
- the Windows AirPlay server and a second known receiver/network, preferably
  with a wired comparison where supported.

Collect the bounded application playback trace, sender device CPU/memory,
receiver process CPU/memory and actual presented timestamps. Bind symptom
occurrence to repeated Next, Seek, audio-track/output switches and foreground
return. External time-coded observation is needed for physical display/audio
latency; software clock equality alone does not measure lip sync. Keep video
handoff, system mirror/independent display and native DLNA as separate routes.
Do not infer an app root cause solely from a Windows receiver stutter report.
