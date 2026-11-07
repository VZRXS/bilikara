// One target map for manual builds and tag releases. No credentials or I/O in
// selection; the CLI validates inputs before any native build job is scheduled.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const desktopTargets = [
  {os: 'windows-latest', label: 'Windows x64', slug: 'windows', arch: 'x64'},
  {os: 'windows-11-arm', label: 'Windows ARM64', slug: 'windows', arch: 'arm64'},
  {os: 'macos-latest', label: 'macOS ARM64', slug: 'macos', arch: 'arm64'},
  {os: 'macos-15-intel', label: 'macOS Intel', slug: 'macos', arch: 'x64'},
];
export const mobileTargets = [
  {platform: 'Android', os: 'ubuntu-latest', label: 'ARM64', rust_target: 'aarch64-linux-android', tauri_target: 'aarch64'},
  {platform: 'iOS', os: 'xcode-27', label: 'ARM64 unsigned', rust_target: 'aarch64-apple-ios', tauri_target: 'aarch64',
    export_arch: 'arm64', artifact_kind: 'device-arm64-unsigned'},
];

export function selectTargets(target = 'all', version = '', adhoc = false) {
  target = ({All: 'all', Desktop: 'desktop', Mobile: 'mobile', Windows: 'windows', macOS: 'macos', Android: 'android', iOS: 'ios'})[target] ?? target;
  if (!['all', 'desktop', 'mobile', 'windows', 'macos', 'android', 'ios'].includes(target)) throw new Error('Unknown bundle target');
  if (typeof version !== 'string' || version.length > 64 || (version !== '' && !/^v\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version))) {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH[-preview.N]');
  }
  if (typeof adhoc !== 'boolean') throw new Error('ios_adhoc must be boolean');
  const desktop = desktopTargets.filter(row => ['all', 'desktop', row.slug].includes(target));
  const mobile = mobileTargets.filter(row => ['all', 'mobile', row.platform.toLowerCase()].includes(target));
  if (adhoc && !mobile.some(row => row.platform === 'iOS')) throw new Error('Ad Hoc requires an iOS target');
  const matrix = {include: [...desktop.map(row => ({...row, kind: 'desktop', name: row.label})),
    ...mobile.map(row => ({...row, kind: 'mobile', name: `${row.platform} ${row.label}`}))]};
  return {desktop: {include: desktop}, mobile: {include: mobile}, has_desktop: desktop.length > 0,
    has_mobile: mobile.length > 0, ios_adhoc: adhoc, version, matrix};
}

function main() {
  const env = process.env;
  if (!['true', 'false'].includes(env.BUNDLE_IOS_ADHOC)) throw new Error('Invalid ios_adhoc input');
  const plan = selectTargets(env.BUNDLE_TARGET, '', env.BUNDLE_IOS_ADHOC === 'true');
  if (plan.ios_adhoc) {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !env.GITHUB_REF?.startsWith('refs/heads/')
      || !['VZRXS/bilikara', 'VZRXS/bilikara-next'].includes(env.GITHUB_REPOSITORY)) throw new Error('Ad Hoc requires a trusted manual branch build');
    for (const name of ['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION']) {
      if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
    }
  }
  fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) =>
    `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`).join(''), 'utf8');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    `\nBundle targets: ${[...plan.desktop.include.map(row => row.label), ...plan.mobile.include.map(row => `${row.platform} ${row.label}`)].join(', ')}.\n`
    + `iOS Ad Hoc: ${plan.ios_adhoc}; publication is owned exclusively by Release.\n`, 'utf8');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
