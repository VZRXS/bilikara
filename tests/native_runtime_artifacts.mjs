// Child Cargo builds, never links Runtime into xtask or selects a stale glob.
import assert from 'node:assert/strict';
import path from 'node:path';
import {appendFileSync} from 'node:fs';
import { root, runNative } from './desktop_construction_support.mjs';

async function artifact(args, name, test) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CARGO_BUILD_TARGET'));
  const result = await runNative('cargo', [...args, '--manifest-path', path.join(root, 'rust-runtime/Cargo.toml'),
    '--locked', '--target', 'host-tuple', '--message-format=json'], environment, 300_000);
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
  return records[0].executable;
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
