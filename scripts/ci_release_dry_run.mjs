// Offline transport rehearsal: consumes real, run-bound artifacts and cannot
// import a publication client or contact GitHub/R2. Outputs are never publishable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ANDROID_SOURCE_KIT, collectRelease, mirrorReleaseMetadata} from './ci_release.mjs';
import {verifyReleaseBytes} from './ci_release_verify.mjs';
import {verifyReleaseMirror} from './verify_release_mirror.mjs';
import {desktopTargets} from './ci_targets.mjs';
import {buildMetadata} from './android_release.mjs';

export async function releaseDryRun({sha, runId, ref, artifacts, directory, output, applicationVersion, sourceRun}) {
  assert.ok(sourceRun && ['push','workflow_dispatch'].includes(sourceRun.event), 'A real source run event is required');
  assert.equal(sourceRun.id, runId, 'Source run identity mismatch');
  assert.equal(sourceRun.head_sha, sha, 'Source run commit mismatch');
  assert.equal(sourceRun.head_branch, ref, 'Source run branch mismatch');
  assert.match(applicationVersion, /^\d+\.\d+\.\d+$/);
  const rehearsalTag = `v${applicationVersion}`;
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
  const sourceNames = [
    ...desktopTargets.map(row => `bilikara-${row.slug}-${row.arch}-${safeRef}-${sha.slice(0, 12)}.zip`),
    buildMetadata({GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: ref, GITHUB_EVENT_NAME: sourceRun.event}).apk,
    `bilikara-ios-device-arm64-unsigned-${sha}`,
    ANDROID_SOURCE_KIT,
  ];
  await fs.mkdir(output, {recursive: false});
  const destination = path.join(output, 'assets');
  const manifest = await collectRelease({tag: rehearsalTag, sha, runId, artifacts, directory, destination,
    dryRun: true, sourceNames, applicationVersion});
  await verifyReleaseBytes(manifest, destination);
  const metadata = path.join(output, 'metadata'), readback = path.join(output, 'readback');
  await fs.mkdir(metadata);
  await fs.mkdir(path.join(readback, 'metadata'), {recursive: true});
  await fs.cp(destination, path.join(readback, 'assets'), {recursive: true});
  const release = {tag_name: manifest.tag, draft: false, assets: manifest.assets,
    body: 'UNSIGNED iOS IPA: requires signing before device installation. Offline dry-run only.'};
  const mirrored = mirrorReleaseMetadata(release, 'https://dry-run.invalid/bilikara/releases/download');
  for (const [name, value] of Object.entries({'current-github.json': release, 'tag.json': mirrored, 'releases.json': [mirrored]})) {
    await fs.writeFile(path.join(metadata, name), JSON.stringify(value, null, 2));
    if (name !== 'current-github.json') await fs.copyFile(path.join(metadata, name), path.join(readback, 'metadata', name));
  }
  const receipt = await verifyReleaseMirror(metadata, destination, readback);
  assert.equal(receipt.assets.length, 8);
  assert.ok(manifest.assets.some(row => row.name === ANDROID_SOURCE_KIT), 'Android corresponding source is distributed');
  assert.ok(mirrored.assets.some(row => row.name.endsWith('-ios-arm64-unsigned.ipa') && row.browser_download_url.includes('?sha256=')));
  // Real-byte negative checks; each must fail closed before any publication.
  const victim = path.join(readback, 'assets', manifest.assets[0].name);
  await fs.unlink(victim);
  await assert.rejects(verifyReleaseBytes(manifest, path.dirname(victim)));
  await fs.copyFile(path.join(destination, manifest.assets[0].name), victim);
  const handle = await fs.open(victim, 'r+');
  const byte = Buffer.alloc(1);
  try {await handle.read(byte, 0, 1, 0); byte[0] ^= 1; await handle.write(byte, 0, 1, 0);} finally {await handle.close();}
  await assert.rejects(verifyReleaseBytes(manifest, path.dirname(victim)));
  await fs.copyFile(path.join(destination, manifest.assets[0].name), victim);
  await assert.rejects(collectRelease({tag: rehearsalTag, sha, runId: runId + 1, artifacts, directory,
    destination: path.join(output, 'must-not-exist'), dryRun: true, sourceNames, applicationVersion}));
  await verifyReleaseBytes(manifest, path.dirname(victim));
  const result = {...manifest, verification: receipt, negative_checks: ['missing', 'corrupt', 'wrong-run'], publication_api_calls: 0, source_event:sourceRun.event};
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [metadata, directory, output] = process.argv.slice(2);
  const result = await releaseDryRun({...JSON.parse(await fs.readFile(metadata, 'utf8')), directory, output});
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### Release distribution dry-run\n\nVerified six packages, the Android corresponding-source kit and SHA256SUMS, including the original unsigned IPA.\n\n`
    + result.assets.map(row => `- ${row.name}: ${row.size} bytes; ${row.digest}\n`).join('')
    + '\nLocal round-trip and missing/corrupt/wrong-run negatives passed. No publication API was called.\n');
}
