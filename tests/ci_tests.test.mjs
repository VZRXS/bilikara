import {desktopWorkflow} from './ci_workflow_support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {groups, selectTests} from '../scripts/ci_tests.mjs';

const {scripts} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('actual workflow reader handles Windows CRLF checkouts without losing jobs or steps', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ci-workflow-crlf-'));
  try {
    mkdirSync(path.join(directory, 'tests'));
    mkdirSync(path.join(directory, '.github/workflows'), {recursive: true});
    writeFileSync(path.join(directory, 'tests/ci_workflow_support.mjs'), readFileSync(new URL('./ci_workflow_support.mjs', import.meta.url)));
    for (const name of ['ci', 'bundle']) {
      const text = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      writeFileSync(path.join(directory, `.github/workflows/${name}.yml`), text.replaceAll('\n', '\r\n'));
    }
    for (const action of ['desktop-checks', 'mobile-checks', 'desktop-bundle', 'mobile-bundle']) {
      const destination = path.join(directory, `.github/actions/${action}`);
      mkdirSync(destination, {recursive: true});
      const text = readFileSync(new URL(`../.github/actions/${action}/action.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      writeFileSync(path.join(destination, 'action.yml'), text.replaceAll('\n', '\r\n'));
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {desktopChecks,mobileChecks,desktopPackages,mobilePackages} from './tests/ci_workflow_support.mjs'; for (const job of [desktopChecks,mobileChecks,desktopPackages,mobilePackages]) {if (!job.includes('steps:') || job.includes('\\r')) throw Error('Invalid Windows workflow');}"],
    {cwd: directory, encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 0, result.stderr);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
test('CI shared selection retains every public suite test exactly once, including former native-media imports', () => {
  const plan = selectTests(groups.shared, scripts);
  assert.equal(plan.files.length, new Set(plan.files).size);
  for (const file of ['ios_playback', 'ios_playback_browser', 'media_output_transport', 'media_output_browser',
    'app_update_startup', 'app_update_startup_browser', 'internet_remote_deployment', 'internet_remote_provisioning',
    'shared_host_layout_browser', 'mobile_host_browser', 'fullscreen_player_browser', 'shared_workspace_icon', 'native_desktop_media',
    'native_transport', 'native_transport_browser', 'mobile_focus_browser', 'android_webview_admission', 'bilibili_video_link', 'bilibili_video_browser']) {
    assert.ok(plan.files.includes(`tests/${file}.test.mjs`), file);
  }
  // Independently derive the expected union of the original public suite arguments.
  const expected = new Set();
  for (const suite of groups.shared) {
    for (const file of scripts[`test:${suite}`].split(' ').slice(2)) {
      if (file === 'tests/frontend_tests.test.mjs') {
        for (const match of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').matchAll(/import '\.\/([^']+)'/g)) expected.add(`tests/${match[1]}`);
      } else expected.add(file);
    }
  }
  assert.deepEqual(new Set(plan.files), expected);
  assert.equal(plan.duplicates, 14, 'V7 playback/clock and P0/OEM suites retain their shared aggregate coverage');
  const fast = selectTests(groups.frontend, scripts);
  assert.ok(!fast.files.includes('tests/native_desktop_media.test.mjs'));
  assert.ok(fast.files.includes('tests/ios_playback_browser.test.mjs'));
});

test('selection refuses shell commands, unsupported flags and aggregates that also define tests', () => {
  for (const command of ['node --test tests/a.test.mjs && deploy', 'node --test --test-name-pattern=skip tests/a.test.mjs',
    'node other.mjs', undefined]) assert.throws(() => selectTests(['bad'], {'test:bad': command}));
  const fake = {'test:aggregate': 'node --test tests/aggregate.test.mjs', 'test:a': 'node --test tests/a.test.mjs'};
  const read = file => file.includes('aggregate') ? "import './a.test.mjs';\nimport './b.test.mjs';\n" : '';
  const plan = selectTests(['aggregate', 'a'], fake, read);
  assert.equal(plan.duplicates, 1); assert.deepEqual(plan.entries, ['tests/aggregate.test.mjs']);
  assert.throws(() => selectTests(['a', 'aggregate'], fake, read), /partially overlapping/);
  assert.throws(() => selectTests(['aggregate'], fake, () => "import './a.test.mjs';\ntest('own',()=>{});"), /only imports/);
});

test('Linux C cache saves only after real prerequisites pass and before unrelated test gates', () => {
  const workflow = desktopWorkflow;
  const restore = workflow.indexOf('name: Cache verified Linux media test libraries');
  const build = workflow.indexOf('name: Build libav prerequisite');
  const verify = workflow.indexOf('name: Verify real libav prerequisite contracts');
  const save = workflow.indexOf('name: Save verified Linux media test libraries');
  const tests = workflow.indexOf('name: Run unit tests');
  assert.ok(restore >= 0 && restore < build && build < verify && verify < save && save < tests);
  const browsers = workflow.indexOf('npm exec -- playwright install --with-deps chromium webkit');
  assert.ok(browsers >= 0 && browsers < verify, 'real L1 decoder tests need both installed engines before their first consumer');
  assert.match(workflow.slice(restore, build), /actions\/cache\/restore@v5/);
  const saving = workflow.slice(save, tests);
  assert.match(saving, /actions\/cache\/save@v5/);
  assert.match(saving, /steps\.test-libav-key\.outputs\.key/);
  assert.doesNotMatch(saving, /always\(\)|continue-on-error/);
});
