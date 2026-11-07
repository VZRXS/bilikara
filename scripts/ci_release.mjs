// Release tooling, not application policy. Only this run's verified six-target
// outputs can reach a draft. The unsigned IPA is a direct release asset.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectTargets} from './ci_targets.mjs';

export function releaseTargets(tag, sha) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-preview\.\d+)?$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  return [
    ...selectTargets('all', tag).desktop.include.map(row => ({
      name: `bilikara-${tag}-${row.slug}-${row.arch}.zip`, distribute: true,
    })),
    {name: `bilikara-${tag}-android-arm64.apk`, distribute: true},
    {name: `bilikara-ios-device-arm64-unsigned-${sha}`, distribute: true,
      asset: `bilikara-${tag}-ios-arm64-unsigned.ipa`},
  ];
}

export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function filesBelow(directory, depth = 0) {
  assert.ok(depth <= 3, 'Unexpected artifact nesting');
  const files = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    assert.ok(!entry.isSymbolicLink(), 'Artifact links are forbidden');
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(file, depth + 1));
    else {assert.ok(entry.isFile()); files.push(file);}
    assert.ok(files.length <= 32, 'Unexpected artifact file count');
  }
  return files;
}

export async function collectRelease({tag, sha, runId, artifacts, directory, destination,
  dryRun = false, sourceNames, applicationVersion}) {
  assert.equal(typeof dryRun, 'boolean');
  assert.ok(dryRun || (sourceNames === undefined && applicationVersion === undefined), 'Source overrides require a dry-run');
  const wanted = releaseTargets(tag, sha);
  if (dryRun) {
    assert.ok(Array.isArray(sourceNames) && sourceNames.length === 6 && new Set(sourceNames).size === 6);
    assert.ok(sourceNames.every(name => typeof name === 'string' && /^bilikara-[\w.-]+$/.test(name)));
    wanted.forEach((row, index) => {row.asset = row.asset ?? row.name; row.name = sourceNames[index];});
    assert.match(applicationVersion, /^\d+\.\d+\.\d+$/);
  }
  const packages = artifacts.filter(row => row.name?.startsWith('bilikara-'));
  assert.equal(packages.length, wanted.length, 'All six and only six package artifacts are required');
  assert.equal(new Set(packages.map(row => row.name)).size, wanted.length, 'Duplicate package artifacts');
  const files = await filesBelow(directory);
  assert.equal(files.length, wanted.length, 'Download must retain raw artifacts (skip-decompress)');
  const byHash = new Map();
  for (const file of files) {
    const hash = await digest(file);
    assert.ok(!byHash.has(hash), 'Ambiguous artifact bytes');
    byHash.set(hash, file);
  }
  const result = [];
  for (const target of wanted) {
    const row = packages.find(row => row.name === target.name);
    assert.ok(row && !row.expired, `Missing/expired artifact: ${target.name}`);
    assert.equal(row.workflow_run?.id, runId, 'Artifact belongs to another run');
    assert.equal(row.workflow_run?.head_sha, sha, 'Artifact belongs to another commit');
    assert.match(row.digest, /^sha256:[a-f0-9]{64}$/, 'Artifact SHA-256 is required');
    assert.ok(Number.isSafeInteger(row.size_in_bytes) && row.size_in_bytes > 0 && row.size_in_bytes <= 2 ** 31,
      'Invalid package artifact size');
    const file = byHash.get(row.digest);
    assert.ok(file, `Artifact digest mismatch: ${target.name}`);
    assert.equal((await fs.stat(file)).size, row.size_in_bytes, 'Artifact size mismatch');
    result.push({...target, file, digest: row.digest, size: row.size_in_bytes});
  }
  // Independently verify the envelope, embedded provenance, original IPA and
  // application before creating the all-or-nothing distributable directory.
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'bilikara-release-ipa-'));
  try {
    const row = result[5], original = path.join(temporary, 'original.ipa');
    const args = [fileURLToPath(new URL('./verify_ios_unsigned.py', import.meta.url)), row.file,
      '--sha', sha, '--run-id', String(runId), '--version', applicationVersion ?? tag.slice(1).split('-preview.')[0],
      '--identifier', 'com.bilikara.app', '--output', original];
    const receipt = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', args,
      {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024}));
    assert.equal(await digest(original), receipt.digest);
    row.file = original; row.digest = receipt.digest; row.size = receipt.size;
    row.verification = receipt;
  await fs.mkdir(destination);
  const assets = [];
  for (const row of result.filter(row => row.distribute)) {
    const name = row.asset ?? row.name;
    const file = path.join(destination, name);
    await fs.copyFile(row.file, file, fs.constants.COPYFILE_EXCL);
    assert.equal(await digest(file), row.digest, 'Artifact changed during staging');
    assets.push({name, digest: row.digest, size: row.size,
      ...(row.verification ? {verification: row.verification, unsigned: true} : {})});
  }
  const sums = assets.map(row => `${row.digest.slice(7)}  ${row.name}\n`).join('');
  const sumsFile = path.join(destination, 'SHA256SUMS');
  await fs.writeFile(sumsFile, sums, {encoding: 'utf8', flag: 'wx'});
  assets.push({name: 'SHA256SUMS', digest: await digest(sumsFile), size: Buffer.byteLength(sums)});
  return {schema_version: 1, tag, sha, run_id: runId, assets, dry_run: dryRun,
    source_artifacts: packages.map(({id, name, digest, size_in_bytes}) => ({id, name, digest, size: size_in_bytes}))};
  } finally {await fs.rm(temporary, {recursive: true, force: true});}
}

export function verifyPublishedAssets(assets, manifest) {
  assert.equal(assets.length, manifest.assets.length, 'Unexpected or missing release assets');
  assert.equal(new Set(assets.map(row => row.name)).size, assets.length);
  for (const expected of manifest.assets) {
    const asset = assets.find(row => row.name === expected.name);
    assert.ok(asset, `Missing release asset: ${expected.name}`);
    assert.equal(asset.digest, expected.digest, `Release digest: ${expected.name}`);
    assert.equal(asset.size, expected.size, `Release size: ${expected.name}`);
  }
}

export function mirrorReleaseMetadata(release, baseUrl) {
  const base = new URL(baseUrl);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.ok(typeof release.tag_name === 'string' && release.tag_name.length > 0);
  return {...release, assets: (release.assets ?? []).map(asset => {
    assert.equal(path.basename(asset.name), asset.name);
    const query = /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ? `?sha256=${asset.digest.slice(7)}` : '';
    return {...asset, browser_download_url: `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}${query}`};
  })};
}

export async function prepareDraft({github, repo, manifest, directory}) {
  assert.equal(manifest.dry_run, false, 'A dry-run must never publish');
  // Resolve again immediately before mutation: a moved tag is not this run.
  const commit = await github.rest.repos.getCommit({...repo, ref: manifest.tag});
  assert.equal(commit.data.sha, manifest.sha, 'Release tag moved after build');
  // Rehash originals before issuing the first mutation.
  for (const asset of manifest.assets) {
    assert.equal(await digest(path.join(directory, asset.name)), asset.digest);
  }
  const releases = await github.paginate(github.rest.repos.listReleases, {...repo, per_page: 100});
  const matches = releases.filter(row => row.tag_name === manifest.tag);
  assert.ok(matches.length <= 1, 'Ambiguous release tag');
  let release = matches[0];
  if (release) {
    assert.equal(release.draft, true, 'Refusing to rewrite a published release');
    assert.equal(release.target_commitish, manifest.sha, 'Draft commit mismatch');
  } else {
    release = (await github.rest.repos.createRelease({...repo, tag_name: manifest.tag,
      target_commitish: manifest.sha, name: manifest.tag, draft: true,
      prerelease: manifest.tag.includes('-preview.'), generate_release_notes: manifest.tag.includes('-preview.'),
      body: 'The iOS ARM64 IPA is unsigned and normally requires signing before device installation. It is not App Store, TestFlight, or Ad Hoc signed.'})).data;
  }
  const current = await github.paginate(github.rest.repos.listReleaseAssets, {...repo, release_id: release.id, per_page: 100});
  for (const asset of current) assert.ok(manifest.assets.some(row => row.name === asset.name), 'Unexpected draft asset');
  for (const expected of manifest.assets) {
    const existing = current.find(row => row.name === expected.name);
    if (existing?.digest === expected.digest && existing.size === expected.size) continue;
    if (existing) await github.rest.repos.deleteReleaseAsset({...repo, asset_id: existing.id});
    await github.rest.repos.uploadReleaseAsset({...repo, release_id: release.id, name: expected.name,
      data: await fs.readFile(path.join(directory, expected.name)),
      headers: {'content-type': 'application/octet-stream', 'content-length': expected.size}});
  }
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, {...repo, release_id: release.id, per_page: 100});
  verifyPublishedAssets(uploaded, manifest);
  return release.id;
}

export async function publishDraft({github, repo, manifest, releaseId, sha}) {
  assert.equal(manifest.dry_run, false, 'A dry-run must never publish');
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0, 'Missing verified draft');
  const commit = await github.rest.repos.getCommit({...repo, ref: manifest.tag});
  assert.equal(commit.data.sha, sha, 'Release tag moved');
  assert.equal(manifest.sha, sha, 'Release manifest commit changed');
  const draft = (await github.rest.repos.getRelease({...repo, release_id: releaseId})).data;
  assert.ok(draft.draft && draft.target_commitish === sha, 'Draft identity changed');
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {...repo, release_id: releaseId, per_page: 100});
  verifyPublishedAssets(assets, manifest);
  const notice = 'The iOS ARM64 IPA is unsigned and normally requires signing before device installation. It is not App Store, TestFlight, or Ad Hoc signed.';
  const published = await github.rest.repos.updateRelease({...repo, release_id: releaseId,
    draft: false, make_latest: manifest.tag.includes('-preview.') ? 'false' : 'true',
    body: (draft.body ?? '').includes(notice) ? draft.body : `${draft.body ?? ''}\n\n${notice}`.trim()});
  return {...published.data, assets};
}
