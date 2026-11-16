// Child Cargo builds, never links Runtime into xtask or selects a stale glob.
import assert from 'node:assert/strict';
import path from 'node:path';
import {appendFileSync, constants, copyFileSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
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

// Inter-process mutual exclusion granted in FIFO order: each caller enqueues a
// timestamped ticket and only the oldest live ticket may attempt the lock, so a
// process that releases and immediately builds again (alpha, then the desktop Host)
// cannot starve another file's waiting build. The lock itself is the mutex, because
// two tickets can briefly both appear to be first. Not re-entrant: an action must not
// call exclusive() again. One target directory must not be shared by processes of
// different operating systems (WSL and Windows cannot see each other's PIDs).
//
// A lock is a directory that always names its owner: it is staged with a unique
// "pid:uuid" token and renamed into place, which fails while any lock exists, and it
// is released by renaming it to a unique tombstone before deletion. A lock whose
// owner has exited is reclaimed by at most one process: the reclaimer must create the
// lock's "reclaim" claim exclusively, then confirm the same token is still present
// before moving the lock aside. While that stale lock occupies its path nobody can
// acquire, so a reclaimer that observed an older lock can never remove a newer one.
let tickets = 0, uniques = 0;
const LOCK = '.bilikara-test-artifacts.lock', BUSY = ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'];
const unique = (lock, label) => `${lock}.${label}-${process.pid}-${++uniques}`;

export async function exclusive(directory, action, {timeout = 900_000, poll = 100} = {}) {
  const lock = path.join(directory, LOCK), queue = path.join(directory, '.bilikara-test-artifacts.queue');
  mkdirSync(queue, {recursive: true});
  const ticket = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(10, '0')}-${String(++tickets).padStart(6, '0')}`;
  writeFileSync(path.join(queue, ticket), '', {flag: 'wx'});
  try {
    return await exclusiveTurn(directory, lock, queue, ticket, action, Date.now() + timeout, poll);
  } finally {
    rmSync(path.join(queue, ticket), {force: true});
  }
}

async function exclusiveTurn(directory, lock, queue, ticket, action, deadline, poll) {
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    const ahead = readdirSync(queue).filter(entry => /^\d{15}-\d{10}-\d{6}$/.test(entry) && entry < ticket);
    let waiting = false;
    for (const entry of ahead) {
      const pid = Number(entry.split('-')[1]);
      if (pid !== process.pid && !alive(pid)) rmSync(path.join(queue, entry), {force: true});
      else waiting = true;
    }
    if (waiting) {
      assert.ok(Date.now() < deadline, `timed out waiting for the Cargo artifact queue ${queue}`);
      await delay(poll);
      continue;
    }
    pruneLockLeftovers(directory);
    if (acquire(lock, token)) break;
    let held = '', age;
    try { held = readFileSync(path.join(lock, 'owner'), 'utf8'); } catch {}
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
    const holder = Number(held.split(':')[0]);
    if (held ? !(Number.isSafeInteger(holder) && holder > 0 && alive(holder)) : age > 60_000) {
      reclaim(lock, held);
      continue;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for the Cargo artifact lock ${lock}`);
    await delay(poll);
  }
  try {
    return await action();
  } finally {
    release(lock);
  }
}

export function acquire(lock, token) {
  const staged = unique(lock, 'new');
  mkdirSync(staged);
  try {
    writeFileSync(path.join(staged, 'owner'), token, 'utf8');
    renameSync(staged, lock);
    return true;
  } catch (error) {
    if (!BUSY.includes(error.code)) throw error;
    return false;
  } finally {
    rmSync(staged, {recursive: true, force: true});
  }
}

export function release(lock) {
  const tomb = unique(lock, 'released');
  renameSync(lock, tomb);
  rmSync(tomb, {recursive: true, force: true});
}

// Reclaim the lock instance whose owner token was observed as stale.
export function reclaim(lock, observed) {
  const claim = path.join(lock, 'reclaim');
  try {
    writeFileSync(claim, String(process.pid), {flag: 'wx'});
  } catch (error) {
    if (error.code === 'ENOENT') return false; // that instance is already gone
    if (error.code !== 'EEXIST') throw error;
    // Another reclaimer owns this instance. Only a claim abandoned by an exited
    // process for a minute is cleared, so the instance can be reclaimed again.
    try {
      const by = Number(readFileSync(claim, 'utf8'));
      if (!(by > 0 && alive(by)) && Date.now() - statSync(claim).mtimeMs > 60_000) rmSync(claim, {force: true});
    } catch {}
    return false;
  }
  let current = '';
  try { current = readFileSync(path.join(lock, 'owner'), 'utf8'); } catch {}
  if (current !== observed) { rmSync(claim, {force: true}); return false; }
  const tomb = unique(lock, 'stale');
  renameSync(lock, tomb);
  rmSync(tomb, {recursive: true, force: true});
  return true;
}

// Staging directories and tombstones left by exited processes.
function pruneLockLeftovers(directory) {
  const pattern = new RegExp(`^${literal(LOCK)}\\.(?:new|released|stale)-(\\d+)-\\d+$`);
  for (const entry of readdirSync(directory)) {
    const pid = Number(pattern.exec(entry)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) try { rmSync(path.join(directory, entry), {recursive: true, force: true}); } catch {}
  }
}

// Publish a process-owned name for the current Cargo artifact. Only names matching
// this exact pattern beside the artifact are ever removed: this process's own at
// exit, and those of processes that no longer exist. On Windows a name whose image is
// still running (an orphaned Host) cannot be removed; it is kept for a later attempt
// and never prevents publishing the new name.
const STILL_IN_USE = ['EBUSY', 'EPERM', 'EACCES'];
export function publish(executable, directory, {remove = unlinkSync} = {}) {
  const relative = path.relative(directory, executable);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Cargo artifact ${executable} is outside its target ${directory}`);
  const {dir, name, ext} = path.parse(executable);
  const pattern = new RegExp(`^${literal(name)}\\.bilikara-test-(\\d+)-\\d+${literal(ext)}$`);
  for (const entry of readdirSync(dir)) {
    const pid = Number(pattern.exec(entry)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    try { remove(path.join(dir, entry)); } catch (error) { if (error.code !== 'ENOENT' && !STILL_IN_USE.includes(error.code)) throw error; }
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
