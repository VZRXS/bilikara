import { readSourceText } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { root, runNative, executableOnPath } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { markupSummary } from './frontend_contract_support.mjs';

const read = file => readSourceText(path.join(root, file));
const workflow = read('.github/workflows/internet-remote-sync.yml');
const markup = markupSummary(read('static/remote.html'));
const resources = new Set(), scripts = new Set();
for (const [tag, attributes] of markup.elements) {
  const source = tag === 'script' ? attributes.src : tag === 'link' ? attributes.href : null;
  if (!source || /^[a-z][\w+.-]*:|^\/\//i.test(source)) continue;
  const file = source.split(/[?#]/)[0].replace(/^\/+/, '');
  resources.add(file); if (tag === 'script') scripts.add(file);
}
function eventPaths(event) {
  const block = workflow.split(`\n  ${event}:\n`)[1].split(/\n  [a-z_]+:/)[0];
  return new Set([...block.matchAll(/^      - ([^\n]+)$/gm)].map(match => match[1]));
}

const powershell = executableOnPath(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')
  ?? executableOnPath(process.platform === 'win32' ? 'powershell.exe' : 'powershell');
test('actual PowerShell sync replaces stale exports and copies every current Remote resource byte',
  {skip: !powershell && process.env.BILIKARA_REQUIRE_REMOTE_SYNC_TEST !== '1'}, async () => {
    assert.ok(powershell, 'Required Remote sync verification needs PowerShell');
    for (const required of ['export-guard.js', 'export-download.js']) assert.ok(scripts.has(required));
    const destination = ownedDirectory('Remote sync 中文');
    try {
      for (const file of ['export-guard.js', 'export-download.js']) writeFileSync(path.join(destination, file), 'stale export script');
      const result = await runNative(powershell, ['-NoProfile', '-File', path.join(root, 'scripts/sync_internet_remote_assets.ps1'), '-Destination', destination], process.env, 30_000);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const file of new Set([...resources, 'remote.html', 'i18n.json'])) {
        assert.deepEqual(readFileSync(path.join(destination, file)), readFileSync(path.join(root, 'static', file)), file);
      }
    } finally { rmSync(destination, {recursive: true, force: true}); }
  });

test('production syntax gate covers every actual local Remote script', () => {
  const checked = new Set([...workflow.matchAll(/node --check static\/([^\s]+)/g)].map(match => match[1]));
  assert.deepEqual([...scripts].filter(file => !checked.has(file)), []);
});

test('push paths match the actual sync allowlist including styles and separate pictures', () => {
  const source = read('scripts/sync_internet_remote_assets.ps1');
  const allowlist = source.match(/\$files = @\((.*?)\)/s); assert.ok(allowlist);
  const assets = new Set([...allowlist[1].matchAll(/"([^"]+)"/g)].map(match => match[1]));
  for (const file of resources) if (!file.startsWith('pic/')) assert.ok(assets.has(file), file);
  assert.deepEqual(eventPaths('push'), new Set([...assets].map(file => `static/${file}`).concat(['static/pic/*', 'scripts/sync_internet_remote_assets.ps1'])));
});

test('test/workflow/Host-only edits do not deploy; PR validation/manual redeployment remain available', () => {
  const push = eventPaths('push');
  const matches = (file, pattern) => new RegExp('^' + pattern.split('*').map(RegExp.escape).join('.*') + '$').test(file);
  for (const file of ['tests/internet_remote_frontend_contract.test.mjs', 'tests/internet_remote_deployment.test.mjs', 'tests/frontend_contract_support.mjs',
    '.github/workflows/internet-remote-sync.yml', 'static/app.js', 'static/index.html', 'static/internet-remote-host.js', 'static/styles.css']) {
    assert.ok(![...push].some(pattern => matches(file, pattern)), file);
  }
  const pr = eventPaths('pull_request');
  for (const file of ['.github/workflows/internet-remote-sync.yml', 'tests/internet_remote_frontend_contract.test.mjs', 'tests/internet_remote_deployment.test.mjs',
    'tests/frontend_contract_support.mjs', 'static/**']) assert.ok(pr.has(file));
  assert.ok(workflow.includes('\n  workflow_dispatch:'));
  assert.ok(workflow.includes("github.event_name != 'pull_request'"));
  const validate = workflow.split('\n  validate:\n')[1].split('\n  dispatch:\n')[0];
  assert.ok(validate.indexOf('uses: actions/setup-node') < validate.indexOf('node --test'));
  assert.ok(validate.includes('BILIKARA_REQUIRE_REMOTE_SYNC_TEST: "1"'));
  assert.ok(!/python|setup-python/.test(validate));
});
