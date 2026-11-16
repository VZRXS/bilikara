// Child Cargo builds, never links Runtime into xtask or selects a stale glob.
import assert from 'node:assert/strict';
import path from 'node:path';
import {appendFileSync, constants, copyFileSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import { root, runNative } from './desktop_construction_support.mjs';

// Test files run concurrently against one Cargo target (scripts/ci_tests.mjs uses
// --test-concurrency=2). The builds below are not mutually fresh: an example
// build (dev-dependencies unified) and a bin/integration-test build relink each
// other's outputs, so building the desktop Host rewrites examples/native_host_alpha
// and vice versa. Each relink removes <profile>/<name> or <profile>/examples/<name>
// before hard-linking the new file, so another file's build could make the path
// this process is about to spawn briefly absent (spawn ENOENT). Builds and
// publication are serialized by a lock in Cargo's selected target directory, and
// each process receives its own hard link next to the Cargo artifact (same parent,
// so resource and current_exe semantics are unchanged). A later relink creates a
// new file; it never replaces or removes that link or the inode it names.
const manifest = path.join(root, 'rust-runtime/Cargo.toml');
const published = [];
let targetDirectory, sequence = 0;

const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CARGO_BUILD_TARGET'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function selectedTargetDirectory() {
  if (targetDirectory) return targetDirectory;
  const result = await runNative('cargo', ['metadata', '--manifest-path', manifest, '--locked', '--offline', '--no-deps', '--format-version=1'], environment());
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout).target_directory;
  assert.ok(typeof selected === 'string' && path.isAbsolute(selected), 'Cargo metadata selects an absolute target directory');
  return (targetDirectory = selected);
}

// Inter-process mutual exclusion through an atomic mkdir. A holder records its PID
// immediately; only a dead holder, or a directory left without a PID for a minute,
// is reclaimed. The deadline exceeds one bounded child build (300 s).
export async function exclusive(directory, action, {timeout = 900_000, poll = 100} = {}) {
  const lock = path.join(directory, '.bilikara-test-artifacts.lock'), owner = path.join(lock, 'owner');
  mkdirSync(directory, {recursive: true});
  const deadline = Date.now() + timeout;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let holder = 0, age;
    try { holder = Number(readFileSync(owner, 'utf8')); } catch {}
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
    if (Number.isSafeInteger(holder) && holder > 0 ? !alive(holder) : age > 60_000) {
      rmSync(lock, {recursive: true, force: true});
      continue;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for the Cargo artifact lock ${lock}`);
    await delay(poll);
  }
  try {
    writeFileSync(owner, String(process.pid), 'utf8');
    return await action();
  } finally {
    rmSync(lock, {recursive: true, force: true});
  }
}

// Publish a process-owned name for the current Cargo artifact. Only names matching
// this exact pattern beside the artifact are ever removed: this process's own at
// exit, and those of processes that no longer exist.
export function publish(executable, directory) {
  const relative = path.relative(directory, executable);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Cargo artifact ${executable} is outside its target ${directory}`);
  const {dir, name, ext} = path.parse(executable);
  const pattern = new RegExp(`^${literal(name)}\\.bilikara-test-(\\d+)-\\d+${literal(ext)}$`);
  for (const entry of readdirSync(dir)) {
    const pid = Number(pattern.exec(entry)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) rmSync(path.join(dir, entry), {force: true});
  }
  const destination = path.join(dir, `${name}.bilikara-test-${process.pid}-${++sequence}${ext}`);
  try {
    linkSync(executable, destination);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(error.code)) throw error;
    copyFileSync(executable, destination, constants.COPYFILE_EXCL);
  }
  if (!published.length) process.once('exit', () => { for (const file of published) try { unlinkSync(file); } catch {} });
  published.push(destination);
  return destination;
}

async function artifact(args, name, test) {
  const directory = await selectedTargetDirectory();
  return exclusive(directory, async () => {
    const result = await runNative('cargo', [...args, '--manifest-path', manifest,
      '--locked', '--target', 'host-tuple', '--message-format=json'], environment(), 300_000);
    const messages = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(result.status, 0, messages.filter(record => record.reason === 'compiler-message').map(record => record.message.rendered).join('\n') + result.stderr);
    const records = messages.filter(record => record.reason === 'compiler-artifact'
      && record.target.name === name && record.profile.test === test && record.executable);
    assert.equal(records.length, 1, 'one current host-native Runtime compiler-artifact is required');
    if (process.env.BILIKARA_CARGO_DIAGNOSTICS) {
      const artifacts = messages.filter(record => record.reason === 'compiler-artifact');
      appendFileSync(process.env.BILIKARA_CARGO_DIAGNOSTICS, JSON.stringify({name, args,
        fresh: artifacts.filter(record => record.fresh).length,
        rebuilt: artifacts.filter(record => !record.fresh).length}) + '\n', 'utf8');
    }
    return publish(records[0].executable, directory);
  });
}
export const buildMediaDriver = () => artifact(['build', '--example', 'libav_metadata'], 'libav_metadata', false);
export const buildCatalogMaintenance = () => artifact(['build', '--bin', 'bilikara-catalog-refresh'], 'bilikara-catalog-refresh', false);
export const buildMediaTests = () => artifact(['test', '--lib', '--no-run'], 'bilikara_runtime', true);
export const buildPurekTests = () => artifact(['test', '--features', 'native-host', '--lib', '--no-run'], 'bilikara_runtime', true);
export const buildNativeHost = () => artifact(['build', '--features', 'native-host', '--bin', 'bilikara-desktop-host'], 'bilikara-desktop-host', false);
export const buildNativeHostHttp = () => artifact(['test', '--features', 'native-host', '--test', 'native_host_http', '--no-run'], 'native_host_http', true);
export const buildNativeAlpha = () => artifact(['build', '--features', 'native-host', '--example', 'native_host_alpha'], 'native_host_alpha', false);
export const buildUpdatePreferences = () => artifact(['build', '--features', 'native-host', '--example', 'update_preferences_fixture'], 'update_preferences_fixture', false);
export const buildPortableLoudnessAlpha = () => artifact(['build', '--features', 'native-host,portable-loudness', '--example', 'portable_loudness_alpha'], 'portable_loudness_alpha', false);
export const buildPortableLoudnessTests = () => artifact(['test', '--features', 'native-host,portable-loudness', '--lib', '--no-run'], 'bilikara_runtime', true);
export const buildNativeImages = () => artifact(['test', '--test', 'native_images', '--no-run'], 'native_images', true);
export const buildDesktopLoginTests = () => artifact(['test', '--test', 'native_desktop_login', '--no-run'], 'native_desktop_login', true);
export const buildPlaylistStressTests = () => artifact(['test', '--test', 'native_playlist_stress', '--no-run'], 'native_playlist_stress', true);
