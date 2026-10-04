// Explicit native media acceptance. Rust owns comparison/operation semantics;
// same-build ffmpeg/ffprobe remain TEST oracles, never product fallbacks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { root, runNative } from '../tests/desktop_construction_support.mjs';
import { buildMediaDriver, buildMediaTests } from '../tests/native_runtime_artifacts.mjs';
import { pcmWave } from './fixture_audio.mjs';

const paths = ['driver', 'companion', 'prefix', 'fixtures', 'long-fixture', 'out', 'old-companion', 'shim-test', 'remux-old-companion', 'fault-companion', 'fragmented-fixture', 'flac-old-companion'];
const { values: options } = parseArgs({ options: { ...Object.fromEntries(paths.map(name => [name, { type: 'string' }])),
  ...Object.fromEntries(['packet-scan', 'copy-remux', 'flac'].map(name => [name, { type: 'boolean', default: false }])) } });
if (options.flac) options['copy-remux'] = true;
if (options['copy-remux']) options['packet-scan'] = true;
const required = ['companion', 'prefix', 'fixtures', 'long-fixture', 'out',
  ...(options['packet-scan'] ? ['old-companion', 'shim-test'] : []),
  ...(options['copy-remux'] ? ['remux-old-companion', 'fault-companion', 'fragmented-fixture'] : []),
  ...(options.flac ? ['flac-old-companion'] : [])];
for (const name of required) {
  assert.ok(options[name] && path.isAbsolute(options[name]), `--${name} requires an absolute native input; no skipped acceptance`);
  if (name !== 'out') assert.ok(existsSync(options[name]), `--${name} input is missing; no skipped acceptance`);
}
assert.ok(options.out !== root && !options.out.startsWith(`${root}${path.sep}`), '--out must be outside the repository');
if (options['packet-scan']) assert.equal(process.platform, 'linux', 'the existing wait4 packet-scan acceptance requires native Linux');
mkdirSync(options.out, { recursive: true });
const driver = await buildMediaDriver(), runtimeTests = await buildMediaTests();
if (options.driver) {
  assert.ok(path.isAbsolute(options.driver) && existsSync(options.driver), '--driver must be a current native compiler artifact');
  assert.deepEqual(readFileSync(options.driver), readFileSync(driver), '--driver is stale or differs from the current host-native Cargo artifact');
}
const environment = { ...process.env, LD_LIBRARY_PATH: path.join(options.prefix, 'lib') }; delete environment.FFREPORT;
const fixture = name => path.join(options.fixtures, name);
const saved = (name, value) => writeFileSync(path.join(options.out, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const secrets = [options.out, options.prefix, 'FAKE_PRIVATE_PATH', 'SECRET_TITLE', 'SIGNED_SECRET', 'AUTH_SECRET', 'COOKIE_SECRET', 'ROOM_SECRET'];
function privacy(text, extra = []) { for (const value of [...secrets, ...extra]) assert.ok(!text.includes(value), `private field leaked in comparison report: ${value}`); }
let testsRun = 0, failures = 0;
async function check(name, body) {
  await test(name, { timeout: 600_000 }, async t => {
    testsRun++;
    try { await body(t); } catch (error) { failures++; throw error; }
  });
}
async function rustTest(name, extra, ignored = false) {
  const result = await runNative(runtimeTests, [name, '--exact', ...(ignored ? ['--ignored'] : [])], { ...process.env, ...extra }, 120_000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed; 0 failed; 0 ignored/, 'explicit current Rust integration test must execute');
}
async function cli(args, pcm = false, strict = false) {
  const result = await runNative(path.join(options.prefix, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ['-v', 'error', ...(strict ? ['-xerror'] : []), '-nostdin', ...args], environment, 20_000, root, pcm ? null : 'utf8');
  assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
async function pair(name, source, { kind = 'audio', repeat = 1, companion = options.companion, prefix = options.prefix, extra = [] } = {}) {
  const result = await runNative(driver, ['compare', companion, prefix, source, name, '--pure-rust', kind, '--repeat', String(repeat), ...extra], process.env, 60_000);
  assert.ok(Buffer.byteLength(result.stdout) <= 128 * 1024 * repeat);
  const rows = result.stdout.trim().split('\n').map(JSON.parse); assert.ok(rows.length);
  writeFileSync(path.join(options.out, `${name}.jsonl`), result.stdout, 'utf8');
  for (const row of rows) {
    assert.equal(row.fixture_label, name); assert.equal(row.inspection.complete_media_validation, 'not_established');
    assert.equal(row.inspection.media_acceptance, 'not_requested');
  }
  return [result.status, rows];
}

await check('native existing missing-mdat normalization rejection', () => rustTest('experimental_libav::comparison::tests::live_existing_missing_mdat_normalization_rejection', {
  BILIKARA_LIBAV_COMPANION: options.companion, BILIKARA_LIBAV_FIXTURES: options.fixtures, BILIKARA_M2_CONTRACT_REPORT: path.join(options.out, 'normalization-contract.json'),
}, true));
await check('native default Runtime remains isolated from missing companion', () => rustTest('experimental_libav::tests::missing_companion_is_unavailable_and_default_state_still_initializes', {
  BILIKARA_LIBAV_COMPANION: path.join(options.out, 'absent.so'), BILIKARA_M1_DEFAULT_INPUT: fixture('video.mp4'),
}));
await check('real metadata corpus and independent pinned version/outcome table', async () => {
  const cases = [ ['video', fixture('video.mp4'), 'video', 'success', 'success'], ['aac', fixture('aac.m4a'), 'audio', 'success', 'success'],
    ['multi-stream', fixture('av.mp4'), 'video', 'success', 'media_contract_violation'], ['raw-flac', fixture('audio.flac'), 'audio', 'success', 'invalid_media'],
    ['flac-mp4', fixture('flac.mp4'), 'audio', 'success', 'success'], ['unknown-duration', fixture('unknown-duration.flac'), 'audio', 'success', 'invalid_media'],
    ['missing-mdat', fixture('missing-mdat.m4a'), 'audio', 'success', 'success'], ['truncated-header', fixture('truncated.mp4'), 'audio', 'invalid_media', 'invalid_media'],
    ['malformed-header', fixture('unknown.bin'), 'audio', 'invalid_media', 'invalid_media'], ['long-flac', options['long-fixture'], 'audio', 'success', 'success'] ];
  for (const [name, source, kind, enumeration, pure] of cases) {
    const [code, rows] = await pair(name, source, { kind, repeat: 3 });
    assert.equal(code, enumeration === 'success' ? 0 : 1); assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.same_build, true);
      for (const backend of ['libav', 'ffprobe']) {
        assert.equal(row[backend].outcome, enumeration); assert.equal(row.identity[backend].version, '9.0.1');
        assert.deepEqual(row.identity[backend].library_versions_format_codec_util, [4129125, 4129125, 3998053]);
      }
      assert.equal(row.pure_rust.outcome, pure);
      assert.ok(!row.primary.kinds.includes('semantic_mismatch')); assert.ok(!row.secondary.kinds.includes('potential_safety_mismatch'));
      assert.deepEqual(row.primary.kinds, [enumeration === 'success' ? 'matching_comparable_metadata' : 'backend_or_reference_error']);
      if (enumeration === 'success') assert.ok(row.secondary.kinds.includes('depth_or_contract_difference'));
    }
    if (name === 'unknown-duration') {
      assert.equal(rows[0].libav.metadata.duration_us, null);
      assert.ok(rows[0].primary.fields.some(field => field.field === 'container.duration_us' && field.kind === 'not_comparable'));
    }
    if (name === 'multi-stream') assert.equal(rows[0].libav.metadata.streams.length, 2);
  }
});
await check('actual unavailable companion/reference and precancelled outcomes', async () => {
  let [code, rows] = await pair('missing-companion', fixture('aac.m4a'), { companion: path.join(options.out, 'absent.so') });
  assert.equal(code, 1); assert.equal(rows[0].libav.outcome, 'unavailable'); assert.equal(rows[0].same_build, false);
  assert.deepEqual(rows[0].primary.kinds, ['backend_or_reference_error']);
  [code, rows] = await pair('missing-reference', fixture('aac.m4a'), { prefix: path.join(options.out, 'absent-prefix') });
  assert.equal(code, 1); assert.equal(rows[0].libav.outcome, 'success'); assert.equal(rows[0].ffprobe.outcome, 'unavailable'); assert.equal(rows[0].same_build, false);
  [code, rows] = await pair('precancelled', fixture('aac.m4a'), { repeat: 3, extra: ['--cancelled'] });
  assert.equal(code, 1); assert.equal(rows.length, 1); assert.equal(rows[0].comparison_cancelled, true);
  for (const backend of ['libav', 'ffprobe', 'pure_rust']) assert.equal(rows[0][backend].outcome, 'cancelled');
});
await check('recording reference error-path cancellation reaps the actually started child', async () => {
  assert.notEqual(process.platform, 'win32', 'this existing POSIX signal/reference fixture needs native POSIX execution');
  const prefix = mkdtempSync(path.join(options.out, 'cancel-prefix-')); mkdirSync(path.join(prefix, 'bin'));
  const tool = path.join(prefix, 'bin/ffprobe'), pidfile = path.join(prefix, 'child-pid');
  writeFileSync(tool, '#!/bin/sh\necho $$ > "${0%/*}/../child-pid"\nexec /bin/sleep 30\n', 'utf8'); chmodSync(tool, 0o700);
  const child = spawn(driver, ['compare', options.companion, prefix, fixture('aac.m4a'), 'inflight-cancel'], { cwd: root, env: process.env, detached: true });
  let bytes = 0; const stdout = []; child.stdout.on('data', data => { bytes += data.length; if (bytes <= 128 * 1024) stdout.push(data); else process.kill(-child.pid, 'SIGKILL'); }); child.stderr.resume();
  const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve({ status, signal })); });
  const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10_000);
  try {
    for (let n = 0; n < 500 && !existsSync(pidfile); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(pidfile), 'recording reference must have actually started');
    const pid = Number(readFileSync(pidfile, 'utf8')); assert.ok(Number.isInteger(pid) && pid > 0);
    child.kill('SIGINT'); const result = await finished; assert.equal(result.status, 1); assert.equal(result.signal, null);
    assert.ok(bytes <= 128 * 1024); const output = Buffer.concat(stdout), report = JSON.parse(output);
    assert.equal(report.comparison_cancelled, true); assert.equal(report.ffprobe.outcome, 'cancelled');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the actual reference child must be reaped');
    writeFileSync(path.join(options.out, 'inflight-cancel.jsonl'), output);
  } finally {
    clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await finished; rmSync(prefix, { recursive: true, force: true });
  }
});
await check('real report privacy and original metadata-only invocation ignores test CLI discovery', async () => {
  const source = path.join(options.out, 'FAKE_PRIVATE_PATH_SECRET_TITLE.m4a');
  await cli(['-y', '-i', fixture('aac.m4a'), '-c', 'copy', '-metadata', 'title=SECRET_TITLE', '-metadata', 'comment=https://example.invalid/SIGNED_SECRET?auth=AUTH_SECRET; cookie=COOKIE_SECRET; room=ROOM_SECRET', source]);
  const [code, rows] = await pair('privacy', source); assert.equal(code, 0); privacy(JSON.stringify(rows));
  const canary = mkdtempSync(path.join(options.out, 'default-canary-')), tool = path.join(canary, 'ffprobe');
  try {
    writeFileSync(tool, '#!/bin/sh\ntouch "${0%/*}/called"\nexit 91\n', 'utf8'); chmodSync(tool, 0o700);
    const result = await runNative(driver, [options.companion, fixture('video.mp4')], { ...process.env, PATH: `${canary}${path.delimiter}${process.env.PATH}`, BILIKARA_LIBAV_FFMPEG_PREFIX: canary }, 20_000);
    assert.equal(result.status, 0, result.stderr); assert.ok(!('primary' in JSON.parse(result.stdout))); assert.equal(existsSync(path.join(canary, 'called')), false);
  } finally { rmSync(canary, { recursive: true, force: true }); }
});

let wait4;
async function scan(name, source, { index = 0, kind = 'audio', repeat = 1, companion = options.companion, extra = [], measured = false } = {}) {
  const args = ['compare', companion, options.prefix, source, name, '--scan-stream', String(index), '--scan-kind', kind, '--repeat', String(repeat), ...extra];
  const result = measured ? await runNative(wait4, [path.join(options.out, 'paired-maxrss-kib.txt'), driver, ...args], process.env, 60_000) : await runNative(driver, args, process.env, 60_000);
  assert.ok(Buffer.byteLength(result.stdout) < 64 * 1024 * repeat); const rows = result.stdout.trim().split('\n').map(JSON.parse); assert.ok(rows.length);
  writeFileSync(path.join(options.out, `${name}.jsonl`), result.stdout, 'utf8');
  for (const row of rows) { assert.equal(row.operation, 'packet_scan'); assert.equal(row.inspection.media_acceptance, 'not_requested'); assert.equal(row.inspection.complete_media_validation, 'not_established'); privacy(JSON.stringify(row)); }
  return [result.status, rows];
}
if (options['packet-scan']) {
  const measurement = mkdtempSync(path.join(options.out, 'native-wait4-')); wait4 = path.join(measurement, 'media-wait4');
  const compiled = await runNative(process.env.CC || 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(root, 'tests/fixtures/media_wait4.c'), '-o', wait4]); assert.equal(compiled.status, 0, compiled.stderr);
  await check('real packet corpus, muxed selection and long-input complete scan with native wait4 memory', async () => {
    const cases = [['scan-video', fixture('video.mp4'), 0, 'video', 60], ['scan-aac', fixture('aac.m4a'), 0, 'audio', 48],
      ['scan-mux-video', fixture('av.mp4'), 0, 'video', 60], ['scan-mux-audio', fixture('av.mp4'), 1, 'audio', 48],
      ['scan-raw-flac', fixture('audio.flac'), 0, 'audio', 12], ['scan-flac-mp4', fixture('flac.mp4'), 0, 'audio', 12],
      ['scan-unknown-duration', fixture('unknown-duration.flac'), 0, 'audio', 12], ['scan-missing-mdat', fixture('missing-mdat.m4a'), 0, 'audio', 48], ['scan-long', options['long-fixture'], 0, 'audio', 3520]];
    for (const [name, source, index, kind, count] of cases) {
      const [code, rows] = await scan(name, source, { index, kind, repeat: 3, measured: name === 'scan-long' }); assert.equal(code, 0); assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.scan_capability_schema, 1); assert.deepEqual(row.same_build, { inventory: true, operational: true });
        for (const backend of ['libav', 'ffprobe', 'ffmpeg']) assert.equal(row.identity[backend].version, '9.0.1');
        assert.equal(row.libav.clean_eof, true); assert.equal(row.libav.terminal, 'eof'); assert.equal(row.libav.selected.index, index);
        assert.equal(row.libav.selected.packet_count, count); assert.equal(row.ffprobe.streams[0].packet_count, count);
        assert.deepEqual(row.primary.kinds, ['matching_comparable_packet_scan']); assert.deepEqual(row.operational_comparison.kinds, ['matching_comparable_packet_scan']);
      }
      if (name.includes('mux')) assert.equal(rows[0].libav.demuxed_packets, 108);
      if (name === 'scan-long') {
        const selected = rows[0].libav.selected, memory = Number(readFileSync(path.join(options.out, 'paired-maxrss-kib.txt'), 'utf8'));
        assert.ok(selected.pts_ticks.max / 96000 > 299); assert.ok(memory > 0);
        saved('memory-and-timing.json', { scope: 'Linux wait4 ru_maxrss, sequential native scan and test CLI references; not a native-only allocation or constant-RSS guarantee', max_rss_kib: memory, fixture_filesystem_bytes: statSync(source).size, selected_packet_count: count, selected_payload_bytes: selected.payload_bytes, elapsed_us: rows.map(row => row.elapsed_us) });
      }
    }
  });
  rmSync(measurement, { recursive: true, force: true });
  await check('real late truncation retains metadata success and scan/operational failure evidence', async () => {
    const small = path.join(options.out, 'four-seconds.mp4'); await cli(['-y', '-i', options['long-fixture'], '-t', '4', '-map', '0:0', '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', small]);
    assert.ok(statSync(small).size < 4 * 1024 * 1024); const late = path.join(options.out, 'late-truncated.mp4'), bytes = readFileSync(small); writeFileSync(late, bytes.subarray(0, Math.floor(bytes.length * 95 / 100)));
    const [metadataCode, metadata] = await pair('late-metadata', late); assert.equal(metadataCode, 0); assert.equal(metadata[0].libav.outcome, 'success');
    const [code, rows] = await scan('scan-late-truncated', late); assert.equal(code, 1); const row = rows[0];
    assert.equal(row.libav.terminal, 'eof'); assert.equal(row.libav.outcome, 'invalid_media'); assert.equal(row.libav.clean_eof, false);
    assert.equal(row.libav.selected.packet_count, 45); assert.equal(row.libav.selected.corrupt_packets, 1); assert.equal(row.ffprobe.streams[0].packet_count, 45);
    assert.equal(row.ffprobe.diagnostics_present, true); assert.equal(row.ffprobe.outcome, 'success'); assert.equal(row.ffmpeg.outcome, 'execution_error'); assert.ok(!row.primary.kinds.includes('matching_comparable_packet_scan'));
  });
  await check('native scan lifecycle, older capability and private shim real-read fault injection', async () => {
    const env = { BILIKARA_LIBAV_COMPANION: options.companion, BILIKARA_LIBAV_FIXTURES: options.fixtures, BILIKARA_M3_OLD_COMPANION: options['old-companion'] };
    for (const name of ['live_scan_lifecycle_and_selection', 'live_old_companion_keeps_metadata_without_scan']) await rustTest(`experimental_libav::scan::tests::${name}`, env, true);
    const shim = await runNative(options['shim-test'], [], { ...process.env, BILIKARA_M3_SHIM_INPUT: fixture('aac.m4a') }, 20_000);
    assert.equal(shim.status, 0, shim.stderr); assert.ok(shim.stdout.includes('real reads + injected')); writeFileSync(path.join(options.out, 'shim-lifecycle.txt'), shim.stdout, 'utf8');
    const [code, rows] = await scan('scan-old-companion', fixture('aac.m4a'), { companion: options['old-companion'] });
    assert.equal(code, 1); assert.equal(rows[0].scan_capability_schema, null); assert.equal(rows[0].libav.outcome, 'unavailable'); assert.equal(rows[0].libav.clean_eof, false);
  });
  await check('native scan invalid selection, cancellation and malformed media stay incomplete', async () => {
    for (const [name, source, index, kind, extra, expected] of [['scan-no-index', 'aac.m4a', 31, 'audio', [], 'invalid_request'], ['scan-wrong-kind', 'aac.m4a', 0, 'video', [], 'invalid_request'], ['scan-precancelled', 'aac.m4a', 0, 'audio', ['--cancelled'], 'cancelled'], ['scan-truncated-header', 'truncated.mp4', 0, 'audio', [], 'invalid_media']]) {
      const [code, rows] = await scan(name, fixture(source), { index, kind, extra }); assert.equal(code, 1); assert.equal(rows[0].libav.outcome, expected); assert.equal(rows[0].libav.clean_eof, false); assert.equal(rows[0].libav.terminal, 'incomplete');
    }
  });
  await check('independent bounded 48-packet CLI accumulator spot check and scan privacy', async () => {
    const result = await runNative(path.join(options.prefix, 'bin/ffprobe'), ['-v', 'error', '-select_streams', '0', '-show_packets', '-show_entries', 'packet=stream_index,size,pts,dts', '-of', 'json', fixture('aac.m4a')], environment, 10_000);
    assert.equal(result.status, 0, result.stderr); assert.ok(Buffer.byteLength(result.stdout) <= 32768); const packets = JSON.parse(result.stdout).packets; assert.equal(packets.length, 48);
    const [, rows] = await scan('scan-spot-check', fixture('aac.m4a')), selected = rows[0].libav.selected;
    assert.equal(selected.payload_bytes, packets.reduce((sum, packet) => sum + Number(packet.size), 0));
    for (const field of ['pts', 'dts']) { const values = packets.filter(packet => field in packet).map(packet => packet[field]); assert.deepEqual(selected[`${field}_ticks`], { min: Math.min(...values), max: Math.max(...values) }); }
    saved('accumulator-spot-check.json', { packet_count: packets.length, payload_bytes: selected.payload_bytes, pts_ticks: selected.pts_ticks, dts_ticks: selected.dts_ticks, time_base: selected.time_base, compared: true });
    const [code] = await scan('scan-privacy', path.join(options.out, 'FAKE_PRIVATE_PATH_SECRET_TITLE.m4a')); assert.equal(code, 0);
  });
}

async function remux(label, source, { kind = 'audio', extra = [], companion = options.companion, keep, profile = '--copy-remux' } = {}) {
  const temporary = path.join(options.out, 'remux-temporary'); mkdirSync(temporary, { recursive: true });
  const result = await runNative(driver, ['compare', companion, options.prefix, source, label, profile, kind, ...extra, ...(keep ? ['--keep-outputs', keep] : [])], { ...process.env, TMPDIR: temporary }, 60_000);
  assert.ok(Buffer.byteLength(result.stdout) < 128 * 1024); const row = JSON.parse(result.stdout); assert.deepEqual(readdirSync(temporary), [], 'owned scratch must be released');
  privacy(result.stdout, [source]); assert.equal(row.operation, 'copy_remux'); assert.equal(row.inspection.media_acceptance, 'not_requested'); writeFileSync(path.join(options.out, `${label}.json`), result.stdout, 'utf8');
  return [result.status, row];
}
if (options['copy-remux']) {
  await check('real remux corpus preserves packets/configuration/timestamps and extended fixture diagnostics', async () => {
    const directory = mkdtempSync(path.join(options.out, 'm5-fixtures-')), summary = [];
    try {
      const extended = path.join(directory, 'extended-aac.m4a'), positive = path.join(directory, 'positive-start.m4a');
      await rustTest('media_backend::tests::export_extended_aac_fixture_for_m5', { BILIKARA_M5_EXTENDED_FIXTURE: extended }, true);
      await cli(['-copyts', '-itsoffset', '1.234567', '-i', fixture('aac.m4a'), '-map', '0:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-use_editlist', '1', '-n', positive]);
      for (const [label, source, kind, count, configSize] of [['h264', fixture('video.mp4'), 'video', 60, 39], ['aac', fixture('aac.m4a'), 'audio', 48, 5], ['extended-aac', extended, 'audio', 4, 4], ['fragmented', options['fragmented-fixture'], 'audio', 88, 5], ['positive-start', positive, 'audio', 48, 5]]) {
        const original = readFileSync(source), [code, row] = await remux(`remux-${label}`, source, { kind }); assert.equal(code, 0, row.outcome); assert.equal(row.outcome, 'success'); assert.equal(row.same_build, true);
        const native = row.companion.result; assert.ok(native.finalized_and_published && native.leading_moov); assert.deepEqual(row.reference.layout, { leading_moov: true, fragmented: false }); assert.equal(native.input.selected.packet_count, count);
        for (const value of Object.values(row.content_comparison)) {
          assert.equal(value.matches, true); assert.deepEqual(value.mismatches, []); assert.equal(value.configuration_bytes_left, configSize); assert.equal(value.configuration_bytes_right, configSize);
          assert.equal(value.packets_left, count); assert.equal(value.packets_right, count); assert.equal(value.max_rounding_us, 0);
        }
        assert.deepEqual(readFileSync(source), original); if (label === 'aac') assert.equal(native.input.selected.dts_ticks.min, -1024); if (label === 'positive-start') assert.ok(native.input.selected.dts_ticks.min > 0);
        if (label === 'extended-aac') { assert.equal(row.reference.diagnostics_present, true); assert.equal(row.clean_reference_execution, false); } else assert.equal(row.clean_reference_execution, true);
        summary.push(Object.fromEntries(['fixture_label', 'outcome', 'profile', 'content_comparison', 'clean_reference_execution', 'output_bytes', 'elapsed_us'].map(key => [key, row[key]])));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
    saved('copy-remux-summary.json', summary);
  });
  await check('native remux refusals do not invoke CLI fallback; old/missing/cancelled capability remains explicit', async () => {
    for (const [label, source, kind, expected] of [['wrong-kind', 'aac.m4a', 'video', 'media_contract_violation'], ['multi-stream', 'av.mp4', 'video', 'media_contract_violation'], ['missing-mdat', 'missing-mdat.m4a', 'audio', 'invalid_media'], ['truncated', 'truncated.mp4', 'audio', 'invalid_media'], ['unsupported-codec', 'flac.mp4', 'audio', 'unsupported_codec'], ['unsupported-format', 'audio.flac', 'audio', 'unsupported_format']]) {
      const [code, row] = await remux(`remux-${label}`, fixture(source), { kind }); assert.equal(code, 1); assert.equal(row.outcome, expected); assert.equal(row.companion?.published || false, false); assert.ok(!('reference' in row));
    }
    for (const [label, companion, extra, expected] of [['old', options['remux-old-companion'], [], 'unavailable'], ['missing', path.join(options.out, 'missing-remux.so'), [], 'unavailable'], ['cancelled', options.companion, ['--cancelled'], 'cancelled']]) {
      const [code, row] = await remux(`remux-${label}`, fixture('aac.m4a'), { companion, extra }); assert.equal(code, 1); assert.equal(row.outcome, expected);
    }
  });
  await check('native remux publication cancellation/late errors and old-library capability', async () => {
    for (const name of ['live_publication_cancellation_and_late_errors', 'live_old_companion_does_not_remux']) await rustTest(`experimental_libav::remux::tests::${name}`, { BILIKARA_LIBAV_COMPANION: options.companion, BILIKARA_LIBAV_FIXTURES: options.fixtures, BILIKARA_M5_FAULT_COMPANION: options['fault-companion'], BILIKARA_M5_OLD_COMPANION: options['remux-old-companion'] }, true);
  });
  await check('explicit retained remux outputs are distinct; remux report stays private', async () => {
    const directory = mkdtempSync(path.join(options.out, 'm5-keep-'));
    try {
      const keep = path.join(directory, 'outputs'), [code, row] = await remux('remux-kept', fixture('aac.m4a'), { keep }); assert.equal(code, 0); assert.equal(row.outputs_retained, true);
      assert.deepEqual(readdirSync(keep).sort(), ['companion.mp4', 'reference.mp4']); assert.notEqual(statSync(path.join(keep, 'companion.mp4')).ino, statSync(path.join(keep, 'reference.mp4')).ino);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const [code] = await remux('remux-privacy', path.join(options.out, 'FAKE_PRIVATE_PATH_SECRET_TITLE.m4a')); assert.equal(code, 0);
  });
}

if (options.flac) {
  const flacCli = (args, pcm = false) => cli(args, pcm, true);
  const directory = mkdtempSync(path.join(options.out, 'flac-fixtures-')), source = fixture('flac.mp4'), wav = path.join(directory, 'lower.wav'), lower = path.join(directory, 'lower.mp4');
  try {
    writeFileSync(wav, pcmWave(48000, 16, 48000, (n, channel) => channel === 0 ? (n * 257) % 65536 - 32768 : 32767 - (n * 509) % 65536));
    await flacCli(['-n', '-i', wav, '-map', '0:0', '-c:a', 'flac', path.join(directory, 'lower.flac')]);
    await flacCli(['-n', '-i', path.join(directory, 'lower.flac'), '-map', '0:0', '-c', 'copy', '-strict', '-2', lower]);
    await flacCli(['-n', '-copyts', '-itsoffset', '0.25', '-i', source, '-map', '0:0', '-c', 'copy', '-strict', '-2', '-use_editlist', '1', path.join(directory, 'offset.mp4')]);
    await flacCli(['-n', '-ss', '0.1', '-i', source, '-map', '0:0', '-c', 'copy', '-strict', '-2', '-use_editlist', '1', path.join(directory, 'trim.mp4')]);
    await flacCli(['-n', '-i', source, '-map', '0:0', '-map', '0:0', '-c', 'copy', '-strict', '-2', path.join(directory, 'two-audio.mp4')]);
    const raw = readFileSync(source), start = raw.indexOf('dfLa') + 12; assert.deepEqual(raw.subarray(start - 4, start), Buffer.from([128, 0, 0, 34]));
    const unknown = Buffer.from(raw); unknown.fill(0, start + 4, start + 10); unknown.writeBigUInt64BE(unknown.readBigUInt64BE(start + 10) & ~((1n << 36n) - 1n), start + 10); unknown.fill(0, start + 18, start + 34); writeFileSync(path.join(directory, 'unknown.mp4'), unknown);
    const invalid = Buffer.from(raw); invalid[start - 1] = 33; writeFileSync(path.join(directory, 'invalid-streaminfo.mp4'), invalid);
    let offset = 0, found = false;
    while (offset + 8 <= raw.length) { const size = raw.readUInt32BE(offset); if (raw.subarray(offset + 4, offset + 8).toString() === 'mdat') { raw.write('free', offset + 4); found = true; break; } assert.ok(size >= 8); offset += size; }
    assert.ok(found); writeFileSync(path.join(directory, 'missing-mdat.mp4'), raw);
    await check('real complete FLAC PCM, independent claxon decoder and known WAV/source preservation', async () => {
      for (const [label, input, knownWav, rate, bits, unknownInfo] of [['hires', source, fixture('synthetic.wav'), 96000, 24, false], ['lower', lower, wav, 48000, 16, false], ['unknown', path.join(directory, 'unknown.mp4'), fixture('synthetic.wav'), 96000, 24, true]]) {
        const original = readFileSync(input), keep = path.join(directory, `${label}-outputs`), [code, row] = await remux(`flac-${label}`, input, { keep, profile: '--flac' });
        assert.equal(code, 0, row.outcome); assert.equal(row.profile, 'mp4_single_flac_to_native_flac_v1'); assert.ok(row.same_build && row.companion.result.finalized_and_published); assert.equal(row.clean_reference_execution, true); assert.equal(row.pure_rust.outcome, 'success');
        assert.deepEqual(readdirSync(keep).sort(), ['companion.flac', 'pure-rust.flac', 'reference.flac']); assert.equal(new Set(readdirSync(keep).map(name => statSync(path.join(keep, name)).ino)).size, 3);
        const pcm = row.pcm_comparison; assert.deepEqual([pcm.sample_rate_hz, pcm.channels, pcm.bits_per_sample, pcm.source_samples_per_channel], [rate, 2, bits, rate]);
        for (const name of ['companion', 'reference', 'pure_rust']) {
          assert.equal(pcm[name].complete_pcm_equal, true); assert.deepEqual(pcm[name].claxon, { complete_pcm_equal: true, samples_per_channel: rate });
          assert.equal(pcm[name].streaminfo.md5_present, !unknownInfo); assert.equal(pcm[name].streaminfo.total_samples, unknownInfo ? null : rate); assert.equal(readFileSync(path.join(keep, `${name.replace('_', '-')}.flac`)).subarray(0, 4).toString(), 'fLaC');
        }
        for (const value of Object.values(row.content_comparison)) assert.equal(value.matches, true);
        // Read the WAV independently of the generator; original wave.open facts
        // and all source samples remain the oracle, not the three libav decodes.
        const known = readFileSync(knownWav); assert.equal(known.subarray(0, 4).toString(), 'RIFF'); assert.equal(known.subarray(8, 12).toString(), 'WAVE');
        let fmt, samples; for (let pos = 12; pos + 8 <= known.length;) { const size = known.readUInt32LE(pos + 4), tag = known.subarray(pos, pos + 4).toString(); assert.ok(pos + 8 + size <= known.length, 'truncated known WAV chunk'); if (tag === 'fmt ') fmt = known.subarray(pos + 8, pos + 8 + size); if (tag === 'data') samples = known.subarray(pos + 8, pos + 8 + size); pos += 8 + size + (size & 1); }
        assert.ok(fmt && samples); assert.deepEqual([fmt.readUInt32LE(4), fmt.readUInt16LE(2), fmt.readUInt16LE(14)], [rate, 2, bits]);
        const width = bits / 8, expected = Buffer.alloc(samples.length / width * 4);
        for (let i = 0; i < samples.length / width; i++) expected.writeInt32LE(samples.readIntLE(i * width, width) * 2 ** (32 - bits), i * 4);
        assert.deepEqual(await flacCli(['-n', '-i', input, '-map', '0:0', '-c:a', 'pcm_s32le', '-f', 's32le', 'pipe:1'], true), expected, 'complete source PCM equals known independent WAV samples');
        assert.deepEqual(readFileSync(input), original); row.known_fixture_pcm = { complete_source_pcm_equal: true, samples_per_channel: rate }; saved(`flac-${label}.json`, row);
      }
    });
    await check('real FLAC wrong-codec/kind/layout/container and old capability refusals publish nothing', async () => {
      for (const [label, input, kind, expected] of [['wrong-codec', fixture('aac.m4a'), 'audio', 'unsupported_codec'], ['wrong-kind', source, 'video', 'media_contract_violation'], ['video-audio', fixture('av.mp4'), 'audio', 'media_contract_violation'], ['two-audio', path.join(directory, 'two-audio.mp4'), 'audio', 'media_contract_violation'], ['raw-input', fixture('audio.flac'), 'audio', 'unsupported_format'], ['missing-mdat', path.join(directory, 'missing-mdat.mp4'), 'audio', 'invalid_media'], ['invalid-streaminfo', path.join(directory, 'invalid-streaminfo.mp4'), 'audio', 'invalid_media'], ['offset', path.join(directory, 'offset.mp4'), 'audio', 'unsupported_container_layout'], ['trim', path.join(directory, 'trim.mp4'), 'audio', 'unsupported_container_layout']]) {
        const original = readFileSync(input), keep = path.join(directory, `${label}-reject`), [code, row] = await remux(`flac-${label}`, input, { kind, keep, profile: '--flac' });
        assert.deepEqual([code, row.outcome], [1, expected]); assert.deepEqual(readdirSync(keep), []); assert.ok(!('reference' in row) && !('pure_rust' in row)); assert.deepEqual(readFileSync(input), original);
        if (label === 'missing-mdat') assert.equal(row.input.metadata.outcome, 'success', 'probe success cannot override normalization contract');
      }
      for (const [label, companion, extra, expected] of [['old-mp4', options['flac-old-companion'], [], 'unavailable'], ['missing', path.join(options.out, 'absent-flac.so'), [], 'unavailable'], ['cancelled', options.companion, ['--cancelled'], 'cancelled']]) {
        const [code, row] = await remux(`flac-${label}`, source, { companion, extra, profile: '--flac' }); assert.deepEqual([code, row.outcome], [1, expected]); assert.ok(!('reference' in row));
      }
      const [code] = await remux('old-mp4-still-works', fixture('aac.m4a'), { companion: options['flac-old-companion'] }); assert.equal(code, 0);
    });
    await check('quantized FLAC timestamps preserve complete samples and the exact inclusive 200ms bounds', async () => {
      const original = readFileSync(source), moov = original.indexOf('moov') - 4, stts = original.indexOf('stts') - 4;
      assert.equal(moov + original.readUInt32BE(moov), original.length); const oldSize = original.readUInt32BE(stts), count = original.readUInt32BE(stts + 12), lengths = [];
      for (let i = 0; i < count; i++) { const pos = stts + 16 + i * 8; for (let n = 0; n < original.readUInt32BE(pos); n++) lengths.push(original.readUInt32BE(pos + 4)); }
      assert.equal(lengths.reduce((a, b) => a + b, 0), 96000);
      for (const [label, driftSamples, accepted] of [['rounded', 144, true], ['previously-rejected-3ms', 288, true], ['positive-at-limit', 19200, true], ['negative-at-limit', -19200, true], ['positive-over-limit', 19201, false], ['negative-over-limit', -19201, false], ['intermediate-over-limit', -19201, false]]) {
        const boundaries = [0]; let encoded = 0;
        for (let i = 0; i < lengths.length; i++) {
          encoded += lengths[i]; let drift;
          if (['rounded', 'previously-rejected-3ms'].includes(label)) drift = -(i === lengths.length - 1 ? 48 : Math.min((i + 1) * 32, driftSamples));
          else if (label === 'intermediate-over-limit') drift = i === lengths.length - 1 ? -48 : -Math.min(Math.floor(encoded * 19201 / 72000), 19201);
          else drift = Math.floor(encoded * driftSamples / 96000); boundaries.push(encoded + drift);
        }
        assert.ok(boundaries.slice(1).every((value, i) => value > boundaries[i]));
        const replacement = Buffer.alloc(16 + lengths.length * 8); replacement.writeUInt32BE(replacement.length); replacement.write('stts', 4); replacement.writeUInt32BE(lengths.length, 12);
        for (let i = 0; i < lengths.length; i++) { replacement.writeUInt32BE(1, 16 + i * 8); replacement.writeUInt32BE(boundaries[i + 1] - boundaries[i], 20 + i * 8); }
        const changed = Buffer.from(original);
        for (const tag of ['moov', 'trak', 'mdia', 'minf', 'stbl']) { const pos = original.indexOf(tag) - 4; changed.writeUInt32BE(changed.readUInt32BE(pos) + replacement.length - oldSize, pos); }
        const data = Buffer.concat([changed.subarray(0, stts), replacement, changed.subarray(stts + oldSize)]), boxes = Object.fromEntries(['mvhd', 'tkhd', 'mdhd', 'elst'].map(tag => [tag, data.indexOf(tag) - 4]));
        for (const pos of Object.values(boxes)) assert.equal(data[pos + 8], 0); assert.equal(data.readUInt32BE(boxes.mdhd + 20), 96000);
        const duration = Math.floor((boundaries.at(-1) * data.readUInt32BE(boxes.mvhd + 20) + 95999) / 96000); data.writeUInt32BE(boundaries.at(-1), boxes.mdhd + 24);
        for (const pos of [boxes.mvhd + 24, boxes.tkhd + 28, boxes.elst + 16]) data.writeUInt32BE(duration, pos);
        const input = path.join(directory, `${label}.mp4`), keep = path.join(directory, `${label}-outputs`); writeFileSync(input, data);
        const [code, row] = await remux(`flac-${label}`, input, { keep, profile: '--flac' });
        if (accepted) { assert.deepEqual([code, row.outcome], [0, 'success']); assert.equal(row.pcm_comparison.source_samples_per_channel, 96000); assert.equal(row.pcm_comparison.companion.complete_pcm_equal, true); assert.equal(row.pcm_comparison.companion.claxon.complete_pcm_equal, true); assert.equal(row.pcm_comparison.companion.streaminfo.total_samples, 96000); }
        else { assert.deepEqual([code, row.outcome], [1, 'unsupported_container_layout']); assert.deepEqual(readdirSync(keep), []); }
      }
    });
    await check('native FLAC metadata tolerance and actual publisher cancellation/late finalization errors', async () => {
      await rustTest('experimental_libav::remux::tests::live_flac_metadata_tolerance', { BILIKARA_LIBAV_COMPANION: options.companion, BILIKARA_LIBAV_FIXTURES: options.fixtures }, true);
      await rustTest('experimental_libav::remux::tests::live_flac_publication_cancellation_and_late_errors', { BILIKARA_LIBAV_COMPANION: options.companion, BILIKARA_LIBAV_FIXTURES: options.fixtures, BILIKARA_M5_FAULT_COMPANION: options['fault-companion'] }, true);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
saved('live-results.json', { tests_run: testsRun, failures, errors: 0, skipped: 0, passed: failures === 0 });
