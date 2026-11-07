// Reclaim unused SDK packages only on disposable GitHub-hosted Linux runners.
// Use SDK Manager's package uninstall boundary, never recursive path deletion.
import assert from 'node:assert/strict';
import {existsSync, readdirSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sdkRoot = '/usr/local/lib/android/sdk';
const required = new Set(['ndk;27.0.12077973', 'platforms;android-36', 'build-tools;36.0.0']);
export function unusedSdkPackages(listing, mode) {
  assert.ok(['desktop', 'android'].includes(mode), 'invalid SDK preparation mode');
  const packages = new Set();
  for (const line of listing.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const name = parts[0].trim();
    if (!/^(?:ndk;\d+\.\d+\.\d+|build-tools;\d+\.\d+\.\d+|platforms;android-\d+|system-images;android-\d+;[A-Za-z0-9_-]+;[A-Za-z0-9_-]+)$/.test(name)) continue;
    if (mode === 'desktop' || !required.has(name)) packages.add(name);
  }
  return [...packages].sort();
}

function command(executable, args) {
  const result = spawnSync(executable, args, {encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error || result.status !== 0) {
    console.error((result.stderr || result.stdout || result.error?.message || '').slice(-8192));
    throw Error(`CI SDK preparation failed: ${path.basename(executable)}`);
  }
  return result.stdout;
}

export function prepareSdkSpace(mode, env = process.env) {
  assert.ok(['desktop', 'android'].includes(mode), 'invalid SDK preparation mode');
  assert.ok(process.platform === 'linux' && env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted', 'SDK preparation requires a disposable GitHub-hosted Linux runner');
  assert.equal(realpathSync(env.ANDROID_HOME || sdkRoot), sdkRoot, 'unexpected hosted SDK location');
  const tools = path.join(sdkRoot, 'cmdline-tools');
  const versions = readdirSync(tools).filter(name => /^(?:latest|\d+(?:\.\d+)*)$/.test(name))
    .sort((a, b) => a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a, 'en', {numeric: true}));
  const manager = versions.map(version => path.join(tools, version, 'bin/sdkmanager')).find(existsSync);
  assert.ok(manager && realpathSync(manager).startsWith(tools + '/'), 'SDK Manager must belong to the hosted SDK');
  console.log(command('df', ['-h', env.GITHUB_WORKSPACE]));
  const packages = unusedSdkPackages(command(manager, [`--sdk_root=${sdkRoot}`, '--list_installed']), mode);
  console.log(`Uninstalling unused ${mode} CI SDK packages: ${JSON.stringify(packages)}`);
  if (packages.length) console.log(command(manager, [`--sdk_root=${sdkRoot}`, '--uninstall', ...packages]));
  console.log(command('df', ['-h', env.GITHUB_WORKSPACE]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {prepareSdkSpace(process.argv[2]);} catch (error) {console.error(error.message); process.exitCode = 1;}
}
