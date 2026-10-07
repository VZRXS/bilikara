// Actual macOS Tauri/embedded-backend launch. Foreign fixtures never qualify it.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { CapturedProcess } from './macos_smoke_process.mjs';
import { root, runNative } from './desktop_construction_support.mjs';
import { isolatedEnvironment } from './native_host_support.mjs';

export function smokeTimeout(environment) {
  const raw = environment.BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS?.trim();
  const timeout = raw ? Number(raw) : 90;
  assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= 300, 'BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS must be positive and at most 300'); return timeout;
}
export const finderEnvironment = (home, directory, log) => ({BILIKARA_DESKTOP_STARTUP_LOG: log, HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', RUST_BACKTRACE: '1', TMPDIR: directory});

export async function verifyTauri() {
  assert.equal(process.platform, 'darwin', 'required Tauri smoke must execute on macOS');
  const executable = path.resolve(process.env.BILIKARA_TEST_TAURI_EXE || path.join(root, 'dist_release/bilikara-desktop.app/Contents/MacOS/bilikara'));
  accessSync(executable, constants.X_OK); const sourceApp = path.dirname(path.dirname(path.dirname(executable)));
  const embedded = 'Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host';
  accessSync(path.join(sourceApp, embedded), constants.X_OK);
  assert.ok(process.env.HOME?.trim(), 'HOME required for Finder-like launch');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tauri smoke 中文 '));
  try {
    for (const profile of ['shell-environment', 'finder-like-environment']) {
      const own = path.join(directory, profile), isolated = path.join(own, 'isolated-app'), app = path.join(isolated, 'bilikara-desktop.app'); mkdirSync(isolated, {recursive: true});
      const copy = await runNative('/usr/bin/ditto', [sourceApp, app]); assert.equal(copy.status, 0, copy.stderr);
      accessSync(path.join(app, 'Contents/MacOS/bilikara'), constants.X_OK); accessSync(path.join(app, embedded), constants.X_OK); assert.equal(existsSync(path.join(isolated, 'bilikara.app')), false);
      const cwd = path.join(own, 'unrelated-cwd'); mkdirSync(cwd); const log = path.join(cwd, 'desktop-startup.log');
      // Both launches use test-owned HOME/data. Even a declared real candidate
      // must never load the runner's Application Support or saved credentials.
      const home = path.join(own, 'home'); mkdirSync(home);
      const env = profile === 'finder-like-environment' ? finderEnvironment(home, cwd, log) : {...isolatedEnvironment(home), PATH: process.env.PATH,
        BILIKARA_NATIVE_DATA_DIR: path.join(home, 'native-data'), BILIKARA_DESKTOP_STARTUP_LOG: log, RUST_BACKTRACE: '1'};
      const capture = new CapturedProcess([path.join(app, 'Contents/MacOS/bilikara')], cwd, env);
      try {
        const url = await capture.waitForOutput((name, line) => name === 'stdout' && line.includes('Backend ready at ') ? line.split('Backend ready at ')[1].trim() : null, smokeTimeout(process.env));
        assert.ok(url, `Tauri readiness missing; status=${capture.process.exitCode}; stdout=${capture.output.stdout}; stderr=${capture.output.stderr}`);
        // Read only the private candidate's loopback endpoint; disable ambient proxy.
        const parsed = new URL(url); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)); assert.equal(parsed.protocol, 'http:');
        parsed.pathname = '/api/health';
        const status = await new Promise((resolve, reject) => {const request = http.get(parsed, {timeout: 5000}, response => {response.resume(); resolve(response.statusCode);}); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('native shell HTTP deadline')));});
        assert.equal(status, 200); assert.equal(capture.exited, false, 'Tauri survives readiness');
        const text = readFileSync(log, 'utf8');
        for (const value of ['event=desktop_start', 'event=backend_resolved', 'candidate_type=macos-embedded-backend', 'candidate_exists=true', 'candidate_executable=true', 'event=backend_spawn status=ok child_pid=', 'event=backend_ready', 'ready_marker_received=true']) assert.ok(text.includes(value), value);
        for (const value of ['event=packaged_backend_missing', 'Authorization:', 'BILIKARA_SHUTDOWN_TOKEN', 'Cookie:', 'SESSDATA=', 'qrcode_key=']) assert.equal(text.includes(value), false, value);
      } finally {assert.equal(await capture.terminate(), true, `native ${profile} process group must terminate`);}
    }
  } finally {rmSync(directory, {recursive: true, force: true});}
}
