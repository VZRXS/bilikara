// Independent release-transport expectations. These small bytes exercise the
// gate, not native package architecture/signatures or physical installation.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectRelease, prepareDraft, publishDraft, verifyPublishedAssets, mirrorReleaseMetadata} from '../scripts/ci_release.mjs';
import {verifyReleaseBytes} from '../scripts/ci_release_verify.mjs';
import {releaseDryRun} from '../scripts/ci_release_dry_run.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567', tag = 'v0.9.0-preview.3', runId = 123;
const names = ['bilikara-v0.9.0-preview.3-windows-x64.zip', 'bilikara-v0.9.0-preview.3-windows-arm64.zip',
  'bilikara-v0.9.0-preview.3-macos-arm64.zip', 'bilikara-v0.9.0-preview.3-macos-x64.zip',
  'bilikara-v0.9.0-preview.3-android-arm64.apk', `bilikara-ios-device-arm64-unsigned-${sha}`];
const ipaName = 'bilikara-v0.9.0-preview.3-ios-arm64-unsigned.ipa';
const unsignedFixture = options => execFileSync(process.platform === 'win32' ? 'python' : 'python3',
  [fileURLToPath(new URL('./fixtures/ios_unsigned.py', import.meta.url))],
  {input: JSON.stringify({sha, runId, ...options}), maxBuffer: 1024 * 1024});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bilikara-ci-release-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'download'); await fs.mkdir(directory);
  const artifacts = [];
  for (const [index, name] of names.entries()) {
    const body = index === 5 ? unsignedFixture({}) : Buffer.from(`independent target fixture ${index}`);
    const file = path.join(directory, `${index}.raw`); await fs.writeFile(file, body);
    artifacts.push({name, expired: false, size_in_bytes: body.length,
      digest: 'sha256:' + createHash('sha256').update(body).digest('hex'),
      workflow_run: {id: runId, head_sha: sha}});
  }
  return {tag, sha, runId, artifacts, directory, destination: path.join(root, 'release')};
}

test('release requires six current-SHA artifacts and distributes the original unsigned IPA directly', async t => {
  const input = await fixture(t); const manifest = await collectRelease(input);
  assert.deepEqual(manifest.assets.map(row => row.name), [...names.slice(0, 5), ipaName, 'SHA256SUMS']);
  assert.equal(manifest.assets[5].unsigned, true);
  assert.deepEqual(await fs.readFile(path.join(input.destination, ipaName)), unsignedFixture({direct: true}));
  await verifyReleaseBytes(manifest, input.destination);
  for (const [index, name] of names.slice(0, 5).entries()) {
    assert.deepEqual(await fs.readFile(path.join(input.destination, name)), Buffer.from(`independent target fixture ${index}`));
  }
  const sums = await fs.readFile(path.join(input.destination, 'SHA256SUMS'), 'utf8');
  assert.equal(sums.trim().split('\n').length, 6);
  assert.ok(sums.includes(ipaName));
  const file = path.join(input.destination, names[0]);
  const bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes);
  await assert.rejects(verifyReleaseBytes(manifest, input.destination), /SHA-256/);
});

test('IPA extraction rejects unsafe/ambiguous envelopes, provenance, signatures, Simulator and wrong application bytes', async t => {
  for (const sample of ['path', 'outer-path', 'duplicate', 'provisioning', 'signed', 'simulator', 'architecture',
    'identity', 'version', 'extra-app', 'extra-ipa-file', 'icons', 'commit', 'run', 'checksum', 'extra-envelope']) {
    const input = await fixture(t);
    const bytes = unsignedFixture({case: sample});
    await fs.writeFile(path.join(input.directory, '5.raw'), bytes);
    input.artifacts[5].digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    input.artifacts[5].size_in_bytes = bytes.length;
    await assert.rejects(collectRelease(input), undefined, sample);
    await assert.rejects(fs.stat(input.destination), {code: 'ENOENT'}, sample);
  }
});

test('dry-run source labels never authorize publication or change release production inputs', async t => {
  const input = await fixture(t);
  const manifest = await collectRelease({...input, dryRun: true, sourceNames: names, applicationVersion: '0.9.0'});
  const github = {rest: {repos: new Proxy({}, {get() {throw Error('Publication API must not be called');}})}};
  await assert.rejects(prepareDraft({github, manifest}), /dry-run/);
  await assert.rejects(publishDraft({github, manifest}), /dry-run/);
  await assert.rejects(collectRelease({...input, destination: input.destination + '-other', sourceNames: names}), /overrides/);
});

for (const event of ['push','workflow_dispatch']) test(`${event} offline distribution rehearsal includes six original packages, metadata URLs and real-byte failure checks`, async t => {
  const input = await fixture(t), ref = 'work/ci-validation-fixture';
  const sourceNames = ['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64']
    .map(target => `bilikara-${target}-work-ci-validation-fixture-${sha.slice(0, 12)}.zip`);
  sourceNames.push(`bilikara-beta-work-ci-validation-fixture-android-arm64-${event==='push'?'ephemeral-debug':'debug'}.apk`, names[5]);
  input.artifacts.forEach((row, index) => {row.name = sourceNames[index];});
  const output = input.destination + '-dry-run';
  const sourceRun = {id:runId,head_sha:sha,head_branch:ref,event};
  const result = await releaseDryRun({...input, ref, output, applicationVersion: '0.9.0', sourceRun});
  assert.equal(result.source_event,event);
  assert.equal(result.publication_api_calls, 0);
  assert.equal(result.dry_run, true);
  assert.equal(result.assets.length, 7);
  assert.deepEqual(result.negative_checks, ['missing', 'corrupt', 'wrong-run']);
  const metadata = JSON.parse(await fs.readFile(path.join(output, 'metadata/tag.json'), 'utf8'));
  const ipa = metadata.assets.find(row => row.name.endsWith('.ipa'));
  assert.equal(ipa.browser_download_url, `https://dry-run.invalid/bilikara/releases/download/v0.9.0/bilikara-v0.9.0-ios-arm64-unsigned.ipa?sha256=${ipa.digest.slice(7)}`);
  for (const base of ['http://insecure.invalid/', 'https://user:password@example.invalid/', 'https://example.invalid/?token=x']) {
    assert.throws(() => mirrorReleaseMetadata(metadata, base));
  }
});

test('distribution rehearsal rejects guessed events and mismatched source run provenance', async t => {
  const input = await fixture(t), ref = 'work/source';
  const sourceRun = {id:runId,head_sha:sha,head_branch:ref,event:'push'};
  for (const change of [{event:'workflow_call'},{head_sha:'a'.repeat(40)},{id:runId+1},{head_branch:'main'}]) {
    const output = input.destination+'-rejected';
    await assert.rejects(releaseDryRun({...input,ref,output,applicationVersion:'0.9.0',sourceRun:{...sourceRun,...change}}));
    await assert.rejects(fs.stat(output), {code:'ENOENT'});
  }
});

test('missing, expired, duplicate, wrong-SHA/run/size/hash or unsafe artifacts fail before staging', async t => {
  const input = await fixture(t);
  for (const mutate of [rows => rows.pop(), rows => rows.push(rows[0]), rows => rows[0].expired = true,
    rows => rows[0].workflow_run.head_sha = 'a'.repeat(40), rows => rows[0].workflow_run.id++,
    rows => rows[0].size_in_bytes++, rows => rows[0].digest = 'sha256:' + 'b'.repeat(64),
    rows => rows[0].name = '../bilikara-windows.zip', rows => delete rows[0].workflow_run,
    rows => rows[5].name = 'bilikara-ios-device-arm64-unsigned-old']) {
    const artifacts = structuredClone(input.artifacts); mutate(artifacts);
    await assert.rejects(collectRelease({...input, artifacts}));
    await assert.rejects(fs.stat(input.destination), {code: 'ENOENT'});
  }
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(input.directory, '0.raw'), path.join(input.directory, 'extra-link'));
    await assert.rejects(collectRelease(input), /links/);
  }
});

test('draft asset verification rejects missing, unexpected, duplicate and same-size replacements', () => {
  const manifest = {assets: [{name: 'one.zip', size: 5, digest: 'sha256:' + 'a'.repeat(64)}]};
  verifyPublishedAssets(structuredClone(manifest.assets), manifest);
  for (const rows of [[], [...manifest.assets, ...manifest.assets], [{...manifest.assets[0], digest: 'sha256:' + 'b'.repeat(64)}],
    [{...manifest.assets[0], name: 'unknown.zip'}], [{...manifest.assets[0], size: 6}]]) {
    assert.throws(() => verifyPublishedAssets(rows, manifest));
  }
});

test('real draft preparation refuses moved tags, published or foreign drafts; upload failure never publishes', async t => {
  const input = await fixture(t); const manifest = await collectRelease(input);
  const repo = {owner: 'fixture', repo: 'private'};
  const calls = [];
  let commit = sha, releases = [], assets = [], uploadFails = false;
  const api = {
    getCommit: async () => ({data: {sha: commit}}),
    listReleases: async () => releases,
    listReleaseAssets: async () => assets,
    createRelease: async value => {calls.push(value); return {data: {id: 7, draft: true, target_commitish: sha}};},
    deleteReleaseAsset: async () => {throw new Error('unexpected deletion');},
    updateRelease: async () => {throw new Error('draft preparation cannot publish');},
    uploadReleaseAsset: async value => {
      if (uploadFails) throw new Error('independent upload failure');
      assets.push({id: assets.length + 1, name: value.name, size: value.data.length,
        digest: 'sha256:' + createHash('sha256').update(value.data).digest('hex')});
    },
  };
  const github = {rest: {repos: api}, paginate: method => method()};
  const invoke = () => prepareDraft({github, repo, manifest, directory: input.destination});
  commit = 'a'.repeat(40); await assert.rejects(invoke(), /tag moved/); assert.equal(calls.length, 0);
  commit = sha; releases = [{tag_name: tag, draft: false}]; await assert.rejects(invoke(), /published release/);
  releases = [{tag_name: tag, draft: true, target_commitish: 'other'}]; await assert.rejects(invoke(), /commit mismatch/);
  releases = []; uploadFails = true; await assert.rejects(invoke(), /upload failure/);
  assert.ok(calls.every(row => row.draft === true && row.target_commitish === sha));
  uploadFails = false; assert.equal(await invoke(), 7);
  verifyPublishedAssets(assets, manifest);
});

test('final publication rechecks tag, draft identity and every digest before publishing', async () => {
  const assets = [{name: 'one.zip', size: 5, digest: 'sha256:' + 'a'.repeat(64)}];
  const manifest = {dry_run: false, tag, sha, assets};
  let commit = sha, draft = {draft: true, target_commitish: sha}, actual = structuredClone(assets);
  const mutations = [];
  const api = {getCommit: async () => ({data: {sha: commit}}), getRelease: async () => ({data: draft}),
    listReleaseAssets: async () => actual, updateRelease: async input => {mutations.push(input); return {data: {draft: false}};}};
  const github = {rest: {repos: api}, paginate: method => method()};
  const invoke = () => publishDraft({github, repo: {owner: 'fixture', repo: 'private'}, manifest, releaseId: 8, sha});
  commit = 'a'.repeat(40); await assert.rejects(invoke());
  commit = sha; draft.draft = false; await assert.rejects(invoke());
  draft.draft = true; draft.target_commitish = 'other'; await assert.rejects(invoke());
  draft.target_commitish = sha; actual[0].digest = 'sha256:' + 'b'.repeat(64); await assert.rejects(invoke());
  assert.equal(mutations.length, 0);
  actual = structuredClone(assets); assert.equal((await invoke()).draft, false);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].make_latest, 'false', 'preview must not replace stable latest');
});
