// Real Linux desktop acceptance of the native GStreamer engine (v0.9 Preview 1).
// The assembled shell supervises its Rust Host, which caches two synthetic songs
// with Rust Native from a restricted local TLS fixture. The Host page binds each
// claimed program to the GStreamer engine in the shell; frames are composited
// beneath the transparent WebView on Xvfb and audio reaches a private
// PulseAudio null sink. Each fixture second has its own video colour and audio
// tone, so screenshots and the sink monitor independently identify the played
// position. Opt-in: BILIKARA_TEST_GSTREAMER_DESKTOP=1 with BILIKARA_TEST_TAURI_EXE
// and BILIKARA_TEST_PULSE_SERVER (parec from PATH or BILIKARA_TEST_PAREC);
// requested runs fail when an input is missing.
// Virtual output only: this does not qualify physical displays or audio devices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, executableOnPath, runNative } from './desktop_construction_support.mjs';
import { CapturedProcess } from './macos_smoke_process.mjs';
import { HttpClient, isolatedEnvironment, waitFor } from './native_host_support.mjs';
import { videoFixture } from './video_service_fixture.mjs';
import { pngRgba } from '../scripts/png-rgba.mjs';

const requested = process.env.BILIKARA_TEST_GSTREAMER_DESKTOP === '1';
const SECONDS = 14, FPS = 30;
// One saturated colour per fixture second (RGB), away from the UI palette.
const PALETTE = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0],
  [128, 0, 255], [0, 255, 128], [255, 0, 128], [128, 255, 0], [0, 128, 255], [128, 64, 0], [64, 128, 0]];
const tone = second => 300 + 100 * second;
const SONGS = [{ bvid: 'BV1xx411c7mD', aid: 1101, cid: 2101 }, { bvid: 'BV1xx411c7mE', aid: 1102, cid: 2102 }];

async function ffmpeg(args, cwd) {
  const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { ...process.env, CUDA_VISIBLE_DEVICES: '' }, 120000, cwd);
  assert.equal(result.status, 0, result.stderr);
}

async function fixtures(directory) {
  const inputs = PALETTE.flatMap(([r, g, b]) => ['-f', 'lavfi', '-i',
    `color=c=0x${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}:s=640x360:r=${FPS}:d=1`]);
  const video = path.join(directory, 'video.mp4'), audio = path.join(directory, 'audio.m4a');
  await ffmpeg([...inputs, '-filter_complex', `${PALETTE.map((_, i) => `[${i}:v]`).join('')}concat=n=${PALETTE.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '10', '-g', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], directory);
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*(300+100*floor(t))*t)':s=48000:d=${SECONDS},aformat=channel_layouts=stereo`,
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', audio], directory);
  return { video: readFileSync(video), audio: readFileSync(audio) };
}

function serve(files, url, headers) {
  const data = url.pathname.endsWith('video.mp4') ? files.video : files.audio;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(headers.range || '');
  const begin = match ? Number(match[1]) : 0, end = match && match[2] ? Number(match[2]) : data.length - 1;
  return { fixtureResponse: { status: match ? 206 : 200, headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
    ...(match ? { 'Content-Range': `bytes ${begin}-${end}/${data.length}` } : {}) }, rawBody: data.subarray(begin, end + 1) } };
}

// Dominant fixture colour inside the stage: palette index or -1.
function videoSecond(png) {
  const { width, height, pixels } = pngRgba(png), counts = new Array(PALETTE.length).fill(0);
  for (let i = 0; i < width * height * 4; i += 4) {
    const index = PALETTE.findIndex(([r, g, b]) => Math.abs(pixels[i] - r) < 28 && Math.abs(pixels[i + 1] - g) < 28 && Math.abs(pixels[i + 2] - b) < 28);
    if (index >= 0) counts[index]++;
  }
  const order = counts.map((count, index) => [count, index]).sort((a, b) => b[0] - a[0]);
  return { second: order[0][0] > 20000 && order[0][0] > 3 * order[1][0] ? order[0][1] : -1, counts };
}

// Fixture second whose tone dominates the samples (Goertzel power over every
// fixture tone), or -1 when the window is silent or ambiguous.
function audioSecond(samples) {
  if (samples.length < 4800) return -1;
  const power = hz => {
    const k = 2 * Math.cos(2 * Math.PI * hz / 48000); let a = 0, b = 0;
    for (const value of samples) { const c = value / 32768 + k * a - b; b = a; a = c; }
    return (a * a + b * b - k * a * b) / samples.length ** 2;
  };
  const ranked = Array.from({ length: SECONDS }, (_, second) => [power(tone(second)), second]).sort((x, y) => y[0] - x[0]);
  return ranked[0][0] > 1e-4 && ranked[0][0] > 4 * ranked[1][0] ? ranked[0][1] : -1;
}

// Continuous raw recording of the private sink's monitor (parec, 10 ms
// fragments; ffmpeg's PulseAudio input drops packets whose wall-clock
// timestamps are not monotonic). Frames cannot reach this process before the
// sink played them, so the earliest arrival bound anchors the continuous
// 48 kHz sample clock (Date.now() milliseconds, like the shell's log); it is
// late by at most the smallest delivery latency.
function startMonitor(parec, pulse, sink, cwd) {
  const child = spawn(parec, ['--raw', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=10',
    `--server=${pulse}`, `--device=${sink}.monitor`], { cwd, env: { ...process.env, PULSE_SERVER: pulse }, stdio: ['ignore', 'pipe', 'pipe'] });
  const values = []; let carry = Buffer.alloc(0), stderr = '', origin = Infinity;
  child.stdout.on('data', data => {
    const arrived = Date.now(), bytes = Buffer.concat([carry, data]), frames = Math.floor(bytes.length / 4);
    for (let j = 0; j < frames; j++) values.push(bytes.readInt16LE(j * 4));
    carry = bytes.subarray(frames * 4);
    origin = Math.min(origin, arrived - values.length / 48);
  });
  child.stderr.on('data', data => { stderr += data; });
  const span = (from, to) => [Math.max(0, Math.round((from - origin) * 48)), Math.min(values.length, Math.round((to - origin) * 48))];
  return {
    // Fixture second heard around `at` (300 ms window).
    secondAt: at => { const [a, b] = span(at - 150, at + 150); return audioSecond(values.slice(a, Math.max(a, b))); },
    // Milliseconds from `at` to the first audible frame, searching from
    // `lead` ms before it (an early sound is reported as negative).
    onset: (at, within, lead = 500) => {
      const [a, b] = span(at - lead, at + within);
      for (let i = a; i < b; i++) if (Math.abs(values[i]) > 1600) return origin + i / 48 - at;
      return null;
    },
    // Longest silent run (ms) between `from` and `to`, in 10 ms blocks.
    longestSilence: (from, to) => {
      const [a, b] = span(from, to); let run = 0, longest = 0;
      for (let block = a; block + 480 <= b; block += 480) {
        let energy = 0; for (let i = block; i < block + 480; i++) energy += values[i] ** 2;
        if (Math.sqrt(energy / 480) < 300) { run += 10; longest = Math.max(longest, run); } else run = 0;
      }
      return longest;
    },
    // When the dominant tone changes from fixture second `second` to the next
    // one (20 ms windows every 5 ms): the audible position of that boundary.
    boundary: (from, to, second) => {
      const [a, b] = span(from, to);
      const power = (start, hz) => {
        const k = 2 * Math.cos(2 * Math.PI * hz / 48000); let x = 0, y = 0;
        for (let i = start; i < start + 960; i++) { const z = values[i] / 32768 + k * x - y; y = x; x = z; }
        return x * x + y * y - k * x * y;
      };
      for (let i = a; i + 960 <= b; i += 240) {
        const before = power(i, tone(second)), after = power(i, tone(second + 1));
        if (after > before && after > 1) return origin + (i + 480) / 48;
      }
      return null;
    },
    latest: () => origin + values.length / 48,
    describe: () => ({ origin, frames: values.length, rate: 48000 }),
    save: file => { const buffer = Buffer.alloc(values.length * 2); values.forEach((v, i) => buffer.writeInt16LE(v, i * 2)); writeFileSync(file, buffer); },
    stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } return stderr; },
  };
}

test('assembled Linux shell plays, seeks and advances songs on the native GStreamer engine', {
  skip: requested ? false : 'opt-in: set BILIKARA_TEST_GSTREAMER_DESKTOP=1 with BILIKARA_TEST_TAURI_EXE and BILIKARA_TEST_PULSE_SERVER',
  timeout: 600000,
}, async t => {
  assert.equal(process.platform, 'linux', 'the GStreamer desktop engine is qualified only on Linux in this preview');
  const selected = process.env.BILIKARA_TEST_TAURI_EXE, pulse = process.env.BILIKARA_TEST_PULSE_SERVER;
  const sink = process.env.BILIKARA_TEST_PULSE_SINK || 'bilikara_lab';
  assert.ok(selected && path.isAbsolute(selected) && existsSync(selected), 'declare an existing absolute BILIKARA_TEST_TAURI_EXE');
  assert.ok(pulse, 'declare BILIKARA_TEST_PULSE_SERVER for a private PulseAudio server with a null sink');
  assert.equal(process.env.CUDA_VISIBLE_DEVICES, '', 'run with CUDA_VISIBLE_DEVICES= (CPU-only policy)');
  const tools = Object.fromEntries(['Xvfb', 'openbox', 'scrot', 'xdotool', 'ffmpeg'].map(name => {
    const binary = executableOnPath(name); assert.ok(binary, `required test prerequisite missing: ${name}`); return [name, binary];
  }));
  tools.parec = process.env.BILIKARA_TEST_PAREC || executableOnPath('parec');
  assert.ok(tools.parec && existsSync(tools.parec), 'required test prerequisite missing: parec (or BILIKARA_TEST_PAREC)');
  const output = process.env.BILIKARA_TEST_EVIDENCE_DIR || mkdtempSync(path.join(root, '.tmp/gstreamer desktop 中文 '));
  mkdirSync(output, { recursive: true });
  const home = mkdtempSync(path.join(root, '.tmp/gstreamer desktop home '));
  // An explicit evidence directory keeps the isolated fixture home for diagnosis.
  if (!process.env.BILIKARA_TEST_EVIDENCE_DIR) t.after(() => rmSync(home, { recursive: true, force: true }));
  const files = await fixtures(home);
  const provider = await videoFixture(async (target, headers) => {
    const url = new URL(target, 'https://api.bilibili.com');
    const song = SONGS.find(s => url.searchParams.get('bvid') === s.bvid || url.searchParams.get('cid') === String(s.cid) || url.pathname.includes(s.bvid));
    if (url.pathname === '/x/web-interface/wbi/view' && song) return { code: 0, data: { aid: song.aid, bvid: song.bvid, title: `GStreamer fixture ${song.bvid.at(-1)}`, owner: { mid: 42, name: 'Fixture' }, pages: [{ page: 1, cid: song.cid, duration: SECONDS, part: 'P1' }] } };
    if (url.pathname.endsWith('/nav')) return { code: 0, data: { wbi_img: { img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png` } } };
    if (url.pathname === '/x/player/wbi/playurl' && song) return { code: 0, data: { dash: {
      video: [{ id: 64, codecid: 7, baseUrl: `https://api.bilibili.com/fixture/${song.bvid}/video.mp4`, bandwidth: 10 }],
      audio: [{ id: 30280, baseUrl: `https://api.bilibili.com/fixture/${song.bvid}/audio.m4a`, bandwidth: 10 }] } } };
    if (url.pathname.startsWith('/fixture/')) return serve(files, url, headers);
    return { code: 0, data: {} };
  });
  let display, wm, app, monitor;
  const deadline = setTimeout(() => { for (const owned of [app, wm, display]) if (owned) owned.signal('SIGKILL'); }, 570000);
  try {
    const env = isolatedEnvironment(home);
    display = new CapturedProcess([tools.Xvfb, '-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], home, env);
    const number = await display.waitForOutput((name, line) => name === 'stdout' && /^\d+\s*$/.test(line) ? line.trim() : null, 10);
    assert.ok(number, 'owned Xvfb must select a display');
    env.DISPLAY = `:${number}`;
    wm = new CapturedProcess([tools.openbox], home, env);
    const log = path.join(output, 'desktop-startup.log');
    // The fixture proxy deliberately covers every host except the provider's
    // own TLS endpoint; the shell must still reach its loopback Host directly.
    const appEnv = { ...env, ...provider.environment, DISPLAY: env.DISPLAY, WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
      BILIKARA_DESKTOP_STARTUP_LOG: log, BILIKARA_DISABLE_MEDIA_CLI: '1',
      BILIKARA_BILIBILI_COOKIE: '', PULSE_SERVER: pulse, PULSE_SINK: sink,
      // Virtual output with software rendering only: never a local GPU.
      CUDA_VISIBLE_DEVICES: '', LIBGL_ALWAYS_SOFTWARE: '1', __GLX_VENDOR_LIBRARY_NAME: 'mesa',
      // WebKit's default DMA-BUF renderer, with shared-memory buffers and CPU painting.
      WEBKIT_DMABUF_RENDERER_FORCE_SHM: '1', WEBKIT_DMABUF_RENDERER_DISABLE_GBM: '1', WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1',
      LIBVA_DRIVER_NAME: 'bilikara-cpu-only-none' };
    // Native video requires WebKit's default (DMA-BUF) renderer; an inherited
    // opt-out would correctly report the engine unavailable instead.
    for (const key of ['WEBKIT_DISABLE_DMABUF_RENDERER', 'WEBKIT_DISABLE_COMPOSITING_MODE']) delete appEnv[key];
    // Run a relocated copy: the shell writes runtime/ beside its executable.
    const installed = path.join(home, 'installed 空 & $name');
    assert.equal(existsSync(path.join(path.dirname(selected), 'runtime')), false, 'use a clean candidate without runtime data');
    cpSync(path.dirname(selected), installed, { recursive: true, dereference: false, verbatimSymlinks: true });
    app = new CapturedProcess([path.join(installed, path.basename(selected))], home, appEnv);
    const text = await waitFor(() => {
      assert.equal(app.exited, false, app.output.stderr || 'desktop exited before readiness');
      const content = existsSync(log) ? readFileSync(log, 'utf8') : '';
      return content.includes('event=window_navigate status=ok') && content;
    }, 'desktop window navigation', 100000);
    let origin = [...text.matchAll(/address=(http[^ ]+|127\.0\.0\.1:\d+)/g)].at(-1)[1].trim();
    if (!origin.startsWith('http')) origin = `http://${origin}`;
    const observations = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n')
      .filter(line => line.includes('event=media_engine_observation'))
      .map(line => ({ at: Number(/unix_ms=(\d+)/.exec(line)[1]), ...JSON.parse(line.slice(line.indexOf('{'))) }));
    const observed = (description, predicate, timeout = 60000) => waitFor(() => {
      assert.equal(app.exited, false, app.output.stderr || 'desktop exited');
      return observations().find(predicate);
    }, description, timeout);
    const window = await waitFor(async () => {
      const found = await runNative(tools.xdotool, ['search', '--onlyvisible', '--pid', String(app.process.pid)], env, 10000, home);
      return found.stdout.trim().split('\n').filter(Boolean).at(-1);
    }, 'visible Tauri window', 40000);
    await runNative(tools.xdotool, ['windowactivate', '--sync', window], env, 10000, home);
    const screenshot = async name => {
      const file = path.join(output, `${name}.png`);
      const shot = await runNative(tools.scrot, ['-o', file], env, 10000, home); assert.equal(shot.status, 0, shot.stderr);
      return videoSecond(readFileSync(file));
    };
    // Audio at the sink is monitored continuously from before the first Play.
    monitor = startMonitor(tools.parec, pulse, sink, home);
    const heardUntil = at => waitFor(() => monitor.latest() >= at, 'sink monitor reaches the checked time', 10000);

    // A LAN Remote registers and requests both songs; Rust Native caches them.
    const remote = new HttpClient(origin);
    assert.equal((await remote.request('/remote')).status, 200);
    await remote.api('/api/remote-identity/register', { name: 'Fixture singer' });
    for (const song of SONGS) await remote.api('/api/playlist/add', { url: `https://www.bilibili.com/video/${song.bvid}`, requester_name: 'Fixture singer' });
    const state = () => remote.api('/api/state');
    let last;
    await waitFor(async () => {
      const snapshot = last = await state(), items = [snapshot.current_item, ...(snapshot.playlist || [])].filter(Boolean);
      return items.length === 2 && items.every(item => item.cache_status === 'ready') && snapshot;
    }, 'both fixture songs cached by Rust Native', 120000).catch(error => {
      const items = [last?.current_item, ...(last?.playlist || [])].filter(Boolean)
        .map(({ title, cache_status, cache_message }) => ({ title, cache_status, cache_message }));
      writeFileSync(path.join(output, 'cache-failure.json'), JSON.stringify({ items, requests: provider.requests.length, tlsErrors: provider.tlsErrors }, null, 2));
      throw Object.assign(error, { message: `${error.message}: ${JSON.stringify(items)}` });
    });

    // The Host binds the claimed program to the native engine.
    let playing = await observed('native engine playing', o => o.type === 'playing', 30000).catch(() => null);
    if (!playing) {
      const snapshot = await state();
      await remote.api('/api/player/control', { action: 'toggle-play', item_id: snapshot.current_item.id, delta_seconds: 0, playback_generation: snapshot.playback_generation });
      playing = await observed('native engine playing after Remote play', o => o.type === 'playing', 30000).catch(async error => {
        await screenshot('not-playing');
        const after = await state();
        writeFileSync(path.join(output, 'not-playing-state.json'), JSON.stringify({ player_status: after.player_status, playback_generation: after.playback_generation,
          current: after.current_item && { title: after.current_item.title, cache_status: after.current_item.cache_status } }, null, 2));
        throw error;
      });
    }
    const first = playing.playback_generation;
    const ready = observations().find(o => o.type === 'ready' && o.playback_generation === first);
    assert.ok(ready, 'native ready precedes playing');
    // Expected positions follow the engine's own playing timestamp (position 0).
    const elapsed = at => (at - playing.at) / 1000;
    if (elapsed(Date.now()) < 2) await delay(2000 - (Date.now() - playing.at));
    const shotAt = Date.now(), shown = await screenshot('playing');
    await heardUntil(playing.at + 2600);
    // Sound begins with Play, also after the Host's paused countdown preroll,
    // and the 1 s -> 2 s tone boundary is heard when the engine clock says 2 s.
    const startOnset = monitor.onset(playing.at, 3000), heard = monitor.secondAt(playing.at + 1500);
    const startBoundary = monitor.boundary(playing.at + 1400, playing.at + 2600, 1);
    const startSyncMs = startBoundary === null ? null : startBoundary - (playing.at + 2000);
    if (process.env.BILIKARA_TEST_PACTL) {
      const inputs = await runNative(process.env.BILIKARA_TEST_PACTL, ['list', 'sink-inputs'], { ...process.env, PULSE_SERVER: pulse }, 10000, home);
      writeFileSync(path.join(output, 'sink-inputs.txt'), `${inputs.stdout}\n${inputs.stderr}`);
    }
    // Thread states of the shell, so a stalled GTK main loop is diagnosable.
    const threads = [];
    for (const task of readdirSync(`/proc/${app.process.pid}/task`)) {
      const read = name => { try { return readFileSync(`/proc/${app.process.pid}/task/${task}/${name}`, 'utf8').trim(); } catch { return '?'; } };
      threads.push(`${task} ${read('comm')} state=${read('stat').split(') ')[1]?.split(' ')[0]} wchan=${read('wchan')}`);
    }
    writeFileSync(path.join(output, 'shell-threads.txt'), threads.join('\n'));
    // CPU-only policy: neither the shell nor its WebKit children hold a GPU device.
    const owned = [String(app.process.pid), ...readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1] === String(app.process.pid); } catch { return false; }
    })];
    const devices = owned.flatMap(pid => { try { return readdirSync(`/proc/${pid}/fd`).map(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ''; } }); } catch { return []; } });
    assert.deepEqual(devices.filter(target => target.startsWith('/dev/dri') || target.startsWith('/dev/nvidia')), [], 'no GPU device is opened');
    const expectedVideo = elapsed(shotAt);
    writeFileSync(path.join(output, 'playing-check.json'), JSON.stringify({ paused_preroll_ms: playing.at - ready.at, start_onset_ms: startOnset,
      audio_minus_clock_ms: startSyncMs, shown: shown.second, expectedVideo, heard, expectedAudio: 1.5, monitor: monitor.describe(), playing_at: playing.at }, null, 2));
    assert.ok(shown.second >= 0 && Math.abs(shown.second + 0.5 - expectedVideo) <= 1,
      `video frame composited beneath the WebView at ${expectedVideo.toFixed(2)} s: ${JSON.stringify(shown)}`);
    assert.ok(monitor.describe().origin <= playing.at - 500, 'the sink monitor was recording before Play');
    assert.equal(heard, 1, 'the sink plays track second 1 at 1.5 s');
    // The repository's virtual synchronization gate is 80 ms (round-a-validation.md).
    assert.ok(startSyncMs !== null && Math.abs(startSyncMs) <= 80, `audio follows the engine clock: ${startSyncMs} ms`);
    assert.ok(startOnset !== null && startOnset >= -50 && startOnset <= 300, `sound starts with Play: ${startOnset} ms`);

    // Remote seek: the same program settles at the target, picture and sound.
    let snapshot = await state();
    const seekRequested = Date.now();
    await remote.api('/api/player/control', { action: 'seek-absolute', item_id: snapshot.current_item.id, delta_seconds: 0, playback_generation: snapshot.playback_generation, target_seconds: 9 });
    const settled = await observed('native seek settled', o => o.type === 'seek-settled' && o.playback_generation === first && o.at >= seekRequested - 50, 20000);
    const seekShown = await screenshot('seek');
    await heardUntil(settled.at + 1600);
    const seekHeard = monitor.secondAt(settled.at + 500), seekGap = monitor.longestSilence(seekRequested, settled.at + 800);
    // The target is 9 s, so the 9 s -> 10 s boundary follows the settled seek by 1 s.
    const seekBoundary = monitor.boundary(settled.at + 500, settled.at + 1600, 9);
    const seekSyncMs = seekBoundary === null ? null : seekBoundary - (settled.at + 1000);
    writeFileSync(path.join(output, 'seek-check.json'), JSON.stringify({ settle_ms: settled.at - seekRequested, shown: seekShown.second, heard: seekHeard,
      silence_ms: seekGap, audio_minus_settle_clock_ms: seekSyncMs }, null, 2));
    assert.ok(seekShown.second >= 9 && seekShown.second <= 10, `seek picture: ${JSON.stringify(seekShown)}`);
    assert.equal(seekHeard, 9, 'seek sound continues from the target');
    // A flushing accurate seek over loopback HTTP with software decoding is
    // audible as ~0.3 s of silence; the bound leaves room for a loaded machine
    // while still failing the former late-audio behavior (0.8 s and more).
    assert.ok(seekGap <= 500, `bounded silence across the seek: ${seekGap} ms`);
    assert.ok(seekSyncMs !== null && Math.abs(seekSyncMs) <= 80, `audio follows the settled seek: ${seekSyncMs} ms`);

    // Natural end: exactly one drained EOS, then the Host advances once.
    const eos = await observed('drained EOS of the first program', o => o.type === 'eos' && o.playback_generation === first, 20000);
    const next = await observed('next program playing', o => o.type === 'playing' && o.playback_generation > first, 30000);
    await delay(1500);
    await heardUntil(next.at + 1600);
    snapshot = await state();
    const eosCount = observations().filter(o => o.type === 'eos' && o.playback_generation === first).length;
    assert.equal(eosCount, 1, 'exactly one completion for the first program');
    assert.equal(eos.drained, true); assert.equal(eos.watchdog, false);
    assert.equal(snapshot.current_item?.title, 'GStreamer fixture E', 'the Host advanced to the second song');
    assert.equal((snapshot.playlist || []).length, 0, 'no duplicate advance');
    // Audible silence between the two programs and the next start, at the sink.
    // The Host's countdown deliberately fades its overlay in and out around the
    // configured interval (localAdvanceOverlayFadeMs); the rest is uncontrolled.
    const configured = (snapshot.player_settings?.song_advance_delay_seconds ?? 3) * 1000;
    const fadeMs = Number(/const localAdvanceOverlayFadeMs = (\d+);/u.exec(readFileSync(path.join(root, 'static/app.js'), 'utf8'))?.[1]);
    assert.ok(Number.isFinite(fadeMs), 'Host overlay fade duration');
    const nextLoading = observations().find(o => o.type === 'loading' && o.playback_generation === next.playback_generation);
    const nextReady = observations().find(o => o.type === 'ready' && o.playback_generation === next.playback_generation);
    const transitionMs = next.at - eos.at, silenceMs = monitor.longestSilence(eos.at - 1000, next.at + 1000);
    const nextOnset = monitor.onset(next.at, 1500), nextHeard = monitor.secondAt(next.at + 500);
    const nextBoundary = monitor.boundary(next.at + 500, next.at + 1600, 0);
    const timing = { configured_interval_ms: configured, host_overlay_fades_ms: 2 * fadeMs, eos_to_next_playing_ms: transitionMs,
      host_advance_ms: nextLoading.at - eos.at, engine_preroll_ms: nextReady.at - nextLoading.at, host_countdown_ms: next.at - nextReady.at,
      uncontrolled_overhead_ms: transitionMs - configured - 2 * fadeMs, audible_silence_ms: Math.round(silenceMs),
      next_start_onset_ms: nextOnset, next_heard_second: nextHeard,
      next_audio_minus_clock_ms: nextBoundary === null ? null : nextBoundary - (next.at + 1000) };
    writeFileSync(path.join(output, 'timing.json'), JSON.stringify(timing, null, 2));
    console.log(`GSTREAMER_DESKTOP_TIMING ${JSON.stringify(timing)}`);
    assert.ok(transitionMs >= configured - 100, `configured interval preserved: ${JSON.stringify(timing)}`);
    assert.ok(timing.uncontrolled_overhead_ms < 400, `bounded uncontrolled switching overhead: ${JSON.stringify(timing)}`);
    assert.ok(nextOnset !== null && nextOnset >= -50 && nextOnset <= 300, `next song's sound starts with its Play: ${JSON.stringify(timing)}`);
    assert.equal(nextHeard, 0, 'next song starts from its beginning at the sink');
    assert.ok(timing.next_audio_minus_clock_ms !== null && Math.abs(timing.next_audio_minus_clock_ms) <= 80, `next song's audio follows its clock: ${JSON.stringify(timing)}`);
    assert.ok(silenceMs <= transitionMs + 400, `audible gap follows the transition: ${JSON.stringify(timing)}`);
    const nextShown = await screenshot('next');
    assert.ok(nextShown.second >= 0 && nextShown.second <= 3, `second song from its start: ${JSON.stringify(nextShown)}`);
    assert.ok(!observations().some(o => o.type === 'error' && o.fatal), 'no fatal engine error');

    // A real key press handled by the window manager (as test:native-launcher).
    await runNative(tools.xdotool, ['windowactivate', '--sync', window], env, 10000, home);
    await runNative(tools.xdotool, ['key', 'alt+F4'], env, 10000, home);
    assert.equal(await app.waitForExit(40), true, 'WM close exits the shell');
    assert.equal(app.process.exitCode, 0, app.output.stderr);
    writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observations(), null, 2));
  } finally {
    clearTimeout(deadline);
    if (monitor) { const stderr = await monitor.stop(); monitor.save(path.join(output, 'sink-monitor.s16le')); if (stderr) writeFileSync(path.join(output, 'sink-monitor.log'), stderr); }
    if (app) writeFileSync(path.join(output, 'shell-output.log'), `${app.output.stdout.slice(-200000)}\n--- stderr ---\n${app.output.stderr.slice(-200000)}`);
    for (const owned of [app, wm, display]) if (owned && !owned.exited) await owned.terminate?.();
    await provider.close();
  }
});
