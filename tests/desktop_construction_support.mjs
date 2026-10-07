// Black-box test setup only: actual xtask, compiled native command fixtures.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertInventory, expectedPackage, inventory, nativeTarget, suffix } from './desktop_construction_expectations.mjs';

export const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function assertCommands(actual, expected) {
  // Rust Path::join retains a slash inside a joined component on Windows,
  // while Node path.join emits native separators. Compare only those native
  // manifest paths semantically; all flags and other argument bytes stay exact.
  const normalize = commands => commands.map(command => command.map((argument, index) =>
    index > 0 && command[index - 1] === '--manifest-path' ? path.normalize(argument) : argument));
  assert.deepEqual(normalize(actual), normalize(expected));
}

export function runNative(program, args, env = process.env, timeout = 120_000, cwd = root, encoding = 'utf8', input, windowsVerbatimArguments = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments });
    const stdout = [], stderr = []; let size = 0, failure, cleanupTimer;
    function terminate(error) {
      if (failure) return;
      failure = error;
      if (child.pid) {
        if (process.platform === 'win32') {
          // Kill the tree while its leader is still alive; killing the leader
          // first would prevent taskkill from finding its descendant processes.
          const killed = spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { timeout: 10_000, windowsHide: true });
          if (killed.status !== 0) child.kill('SIGKILL');
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') failure = cause; }
        }
      }
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); reject(failure);
      }, 10_000);
    }
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > 32 * 1024 * 1024) terminate(new Error(`${program} exceeded the test log bound`));
      else chunks.push(bytes);
    });
    child.on('error', terminate);
    if (input !== undefined) {
      // An early child exit closes the pipe; retain its real exit status and
      // stderr rather than replacing those diagnostics with an EPIPE error.
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') terminate(error); });
      child.stdin.end(input, 'utf8');
    }
    const deadline = setTimeout(() => terminate(Object.assign(new Error(`${program} exceeded ${timeout}ms`), { code: 'ETIMEDOUT' })), timeout);
    child.on('close', (status, signal) => {
      clearTimeout(deadline); clearTimeout(cleanupTimer);
      if (failure) reject(failure);
      else if (signal) reject(new Error(`${program} terminated by ${signal}`));
      else {
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
        resolve({ status, signal, stdout: encoding === null ? out : out.toString(encoding), stderr: encoding === null ? err : err.toString(encoding) });
      }
    });
  });
}

// Shared bootstrap only; real-libav checks do not instantiate command fixtures.
export async function buildXtask() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CARGO_BUILD_TARGET'));
  const build = await runNative('cargo', ['build', '--manifest-path', path.join(root, 'xtask/Cargo.toml'),
    '--locked', '--target', 'host-tuple', '--message-format=json'], environment, 300_000);
  assert.equal(build.status, 0, build.stderr);
  const records = build.stdout.trim().split('\n').map(JSON.parse);
  const compiledTargets = records.filter(record => record.reason === 'compiler-artifact').map(record => record.target.name);
  const artifacts = records.filter(record =>
    record.reason === 'compiler-artifact' && record.target.name === 'bilikara-xtask' && record.executable);
  assert.equal(artifacts.length, 1, 'one current host-native compiler artifact is required');
  const tool = artifacts[0].executable;
  assert.ok(existsSync(tool));
  return { tool, compiledTargets, environment };
}

export function executableOnPath(name, environment = process.env) {
  const search = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const directory of search.split(path.delimiter)) {
    const file = path.join(directory, name);
    if (existsSync(file)) return file;
  }
}

export class ConstructionFixtures {
  static async create() {
    const fixtures = new ConstructionFixtures(); await fixtures.initialize(); return fixtures;
  }
  constructor() {
    mkdirSync(path.join(root, '.tmp'), { recursive: true });
    this.temporary = mkdtempSync(path.join(root, '.tmp/desktop-construction-fixtures-'));
  }
  async initialize() {
    try {
      const { tool, compiledTargets, environment } = await buildXtask();
      this.tool = tool; this.compiledTargets = compiledTargets;
      this.fixture = path.join(this.temporary, `fixture${suffix}`);
      const compile = await runNative('rustc', ['--edition=2024', '--target', nativeTarget(), '--crate-name', 'desktop_commands',
        path.join(root, 'tests/fixtures/desktop_prepare_cargo.rs'), '-o', this.fixture], environment);
      assert.equal(compile.status, 0, compile.stderr);
    } catch (error) { this.close(); throw error; }
  }
  close() { rmSync(this.temporary, { recursive: true, force: true }); }
  scenario(t, release = false) {
    const directory = mkdtempSync(path.join(this.temporary, 'desktop 中文 空 $() & '));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return new ConstructionCase(this, directory, release);
  }
}

class ConstructionCase {
  constructor(fixtures, directory, release) {
    this.fixture = fixtures.fixture; this.tool = fixtures.tool; this.directory = directory;
    this.bin = path.join(directory, 'native fixture bin'); mkdirSync(this.bin);
    copyFileSync(this.fixture, path.join(this.bin, `cargo${suffix}`));
    const remaining = (Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '')
      .split(path.delimiter).filter(p => !existsSync(path.join(p, `BBDown${suffix}`)));
    this.environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:BILIKARA_|TAURI_ENV_|GITHUB_|BB_DOWN_|XTASK_|CARGO_TARGET_DIR$|CARGO_BUILD_TARGET$|PATH$)/i.test(key)));
    Object.assign(this.environment, { PATH: [this.bin, ...remaining].join(path.delimiter), BILIKARA_VERSION: 'v0.8.0-preview.3-contract' });
    if (release) {
      this.toolFixture();
      if (process.platform === 'win32') {
        copyFileSync(this.fixture, path.join(this.bin, 'npm-fixture.exe'));
        writeFileSync(path.join(this.bin, 'npm.cmd'), '@echo off\r\n"%~dp0npm-fixture.exe" %*\r\n');
      } else { copyFileSync(this.fixture, path.join(this.bin, 'npm')); }
      this.prepared = this.prefix();
      const archive = path.join(this.prepared, 'source/ffmpeg-9.0.1.tar.xz');
      Object.assign(this.environment, {
        BILIKARA_LIBAV_PREFIX: this.prepared, BILIKARA_BBDOWN_VERSION: '1.6.3', BILIKARA_FFMPEG_SOURCE_VERSION: '9.0.1',
        BILIKARA_FFMPEG_SOURCE_ARCHIVE: archive, BILIKARA_FFMPEG_SOURCE_URL: 'https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz',
        BILIKARA_FFMPEG_SOURCE_SHA256: digest(readFileSync(archive)),
      });
      this.dist = path.join(directory, 'release dist 音楽 $() &');
      this.product = path.join(this.dist, process.platform === 'darwin' ? 'bilikara.app' : 'bilikara');
    }
  }
  toolFixture() { copyFileSync(this.fixture, path.join(this.bin, `BBDown${suffix}`)); }
  prefix() {
    const prefix = path.join(this.directory, 'prepared prefix 音楽');
    mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const companion = { win32: 'bilikara_media_libav.dll', darwin: 'libbilikara_media_libav.dylib', linux: 'libbilikara_media_libav.so' }[process.platform];
    const dependency = { win32: 'avcodec-63.dll', darwin: 'libavcodec.63.dylib', linux: 'libavcodec.so.63' }[process.platform];
    const testCompanion = process.platform === 'win32' ? 'bilikara_media_libav_test.dll' : companion.replace('libav.', 'libav_test.');
    const manifest = { schema_version: 1, kind: 'libav', version: '9.0.1', target: nativeTarget(),
      runtime_files: [companion, dependency], build_run: 'contract', build_attempt: '1',
      binaries: Object.fromEntries([companion, dependency, testCompanion].map(name => [name, {}])), drivers: { 'libav-runtime-tests': {} } };
    for (const name of [...manifest.runtime_files, testCompanion, `ffmpeg${suffix}`, `ffprobe${suffix}`, `bilikara_runtime${suffix}`]) {
      copyFileSync(this.fixture, path.join(prefix, 'bin', name));
    }
    mkdirSync(path.join(prefix, 'driver')); copyFileSync(this.fixture, path.join(prefix, `driver/libav-runtime-tests${suffix}`));
    mkdirSync(path.join(prefix, 'records')); writeFileSync(path.join(prefix, 'records/driver-build.log'), 'private build output');
    writeFileSync(path.join(prefix, 'bin/ffmpeg-runtime.json'), JSON.stringify(manifest));
    for (const name of ['source/ffmpeg-9.0.1.tar.xz', 'source/ffmpeg-9.0.1.tar.xz.asc', 'licenses/COPYING.LGPLv2.1', 'build-info.json']) {
      const file = path.join(prefix, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'provenance fixture');
    }
    return prefix;
  }
  async invoke(action, environment, args = [], error) {
    const result = await runNative(this.tool, [action, ...(action === 'prepare-desktop' ? [] : ['--dist-dir', this.dist]), ...args], environment);
    if (error) {
      assert.notEqual(result.status, 0, result.stdout); assert.ok(result.stderr.includes(error), result.stderr);
    } else { assert.equal(result.status, 0, result.stdout + result.stderr); }
    return result;
  }
  async runPreparation(name = 'prepared', overrides = {}, args = [], error) {
    const base = path.join(this.directory, name); mkdirSync(base, { recursive: true });
    const log = path.join(base, 'commands.jsonl'); rmSync(log, { force: true });
    const env = { ...this.environment, XTASK_FIXTURE_OUTPUT: path.join(base, 'outputs'), XTASK_FIXTURE_LOG: log, ...overrides };
    await this.invoke('prepare-desktop', env, args, error);
    const commands = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const target = commands.find(command => command.includes('--target'));
    const profile = ['false', '0'].includes(env.TAURI_ENV_DEBUG) ? 'release' : 'debug';
    const output = path.join(env.CARGO_TARGET_DIR || path.join(env.XTASK_FIXTURE_OUTPUT, 'src-tauri'),
      target ? target[target.indexOf('--target') + 1] : '', profile);
    return { output, commands, env };
  }
  async checkPreparation(overrides = {}, args = [], error, retainedRuntime = new Map()) {
    const result = await this.runPreparation('prepared', overrides, args, error);
    if (!error) {
      const release = ['false', '0'].includes(result.env.TAURI_ENV_DEBUG);
      assertCommands(result.commands, [backendCommand(release, result.commands[0].includes('--target')), ...['rust-runtime', 'src-tauri'].map(metadataCommand)]);
      const expected = expectedPackage(this.fixture, result.env, { development: !release, prefix: result.env.BILIKARA_LIBAV_PREFIX });
      for (const [name, record] of retainedRuntime) {
        assert.ok(name === 'runtime' || name.startsWith('runtime/'), 'only pre-existing test user data may be retained');
        expected.set(name, record);
      }
      assertInventory(expected, inventory(result.output));
    }
    return result;
  }
  async releasePath(overrides = {}, args = [], error, full = true) {
    const base = path.join(this.directory, 'release'); mkdirSync(base, { recursive: true });
    const log = path.join(base, 'commands.jsonl'); rmSync(log, { force: true });
    const env = { ...this.environment, XTASK_FIXTURE_OUTPUT: path.join(base, 'cargo outputs 空'), XTASK_FIXTURE_LOG: log, ...overrides };
    await this.invoke(full ? 'build-desktop' : 'build-backend', env, args, error);
    const commands = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { commands, env };
  }
  async checkRelease(overrides = {}, args = [], error, full = true) {
    const result = await this.releasePath(overrides, args, error, full);
    if (!error) {
      const target = result.commands[0].includes('--target');
      const expectedCommands = [backendCommand(true, target), metadataCommand('rust-runtime')];
      if (full) expectedCommands.push(['exec', '--', 'tauri', 'build', ...(process.platform === 'darwin' ? ['--bundles', 'app'] : ['--no-bundle']),
        ...(target ? ['--target', nativeTarget()] : []), '--', '--locked'], metadataCommand('src-tauri'));
      assertCommands(result.commands, expectedCommands);
      const expected = expectedPackage(this.fixture, result.env, {
        development: false, prefix: this.prepared, macosApp: process.platform === 'darwin', compliance: true, shell: full,
      });
      assertInventory(expected.backend, inventory(this.product));
      if (full && process.platform === 'darwin') assertInventory(expected.desktop, inventory(path.join(this.dist, 'bilikara-desktop.app')));
    }
    return result;
  }
  nativeOnlyPath() {
    const directory = path.join(this.directory, 'only native tools 空 $()'); mkdirSync(directory);
    for (const entry of readdirSync(this.bin)) copyFileSync(path.join(this.bin, entry), path.join(directory, entry));
    const names = { linux: ['readelf'], darwin: ['lipo', 'otool', 'plutil', 'codesign', 'ditto'], win32: [] }[process.platform];
    for (const name of names) {
      const source = executableOnPath(name); assert.ok(source, `native ${name} is required`);
      copyFileSync(source, path.join(directory, name));
    }
    for (const name of ['python', 'python3', 'python.exe', 'py.exe']) assert.equal(executableOnPath(name, { PATH: directory }), undefined);
    return directory;
  }
}

function backendCommand(release, target) {
  return ['build', '--manifest-path', path.join(root, 'rust-runtime/Cargo.toml'), '--locked', '--features', 'native-host',
    '--bin', 'bilikara-desktop-host', '--bin', 'bilikara-updater', ...(release ? ['--release'] : []), ...(target ? ['--target', nativeTarget()] : [])];
}
function metadataCommand(crate) {
  return ['metadata', '--manifest-path', path.join(root, crate, 'Cargo.toml'), '--format-version', '1', '--no-deps', '--locked'];
}
