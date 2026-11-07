import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ciPlan, checkCiGate, groupCiPlatformResults, readCiPlatformMatrix, ciPlatforms, changeKind, resolveCiPlan, verifyCiPlatformJobs} from '../scripts/ci_scope.mjs';

const required = {
  full: ['desktop', 'mobile', 'auxiliary'], frontend: ['frontend', 'auxiliary'], docs: ['docs'],
};
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), AsyncFunction = (async () => {}).constructor;
const script = job => workflow.split(`\n  ${job}:\n`)[1].split('          script: |\n')[1]
  .split('\n\n  ')[0].split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const core = {warning() {}, info() {}, setOutput() {}, summary: {addHeading() {return this;}, addRaw() {return this;}, async write() {}}};
const evaluateGate = (results, f = jobsFixture()) => new AsyncFunction('process', 'require', 'core', 'github', 'context', script('gate'))(
  {env: {RESULTS: JSON.stringify(results), GITHUB_WORKSPACE: root, GITHUB_RUN_ATTEMPT: String(f.runAttempt)}}, require, core, f.github, f.context);
const physical = {platforms: 'desktop', frontend: 'frontend', auxiliary: 'auxiliary', docs: 'docs'};
const healthy = plan => ({preflight: {result: 'success', outputs: {plan: JSON.stringify(plan)}},
  ...Object.fromEntries(Object.entries(physical).map(([name, group]) => [name, {result: plan.jobs[group] ? 'success' : 'skipped'}]))});

test('auxiliary real-CLI consumers install locked dependencies and explicit Full calls cannot cancel a parallel Bundle', () => {
  const auxiliary = workflow.split('\n  auxiliary:\n')[1].split('\n  docs:\n')[0];
  assert.ok(auxiliary.indexOf('actions/setup-node@v6') < auxiliary.indexOf('run: npm ci'));
  assert.ok(auxiliary.indexOf('run: npm ci') >= 0 && auxiliary.indexOf('run: npm ci') < auxiliary.indexOf('run: npm run test:auxiliary'));
  assert.ok(workflow.includes("inputs.scope == 'full' && github.run_id"));
});

test('private CI skips both Plan and the always-running Gate before allocating any runner', () => {
  const jobs = new Map([...workflow.split('\njobs:\n')[1].matchAll(/^  ([a-z][\w-]*):\n([\s\S]*?)(?=^  [a-z][\w-]*:\n|$(?![\s\S]))/gm)]
    .map(([, id, block]) => [id, block]));
  assert.ok(jobs.has('preflight') && jobs.has('gate'));
  for (const id of ['preflight', 'gate']) {
    const condition = jobs.get(id).match(/^    if: (.+)$/m)?.[1];
    assert.ok(condition, `${id} must reject private repositories before runner allocation`);
    const allowed = new Function('github', 'always', `return ${condition};`);
    for (const repository of ['VZRXS/bilikara', 'VZRXS/bilikara-next', 'someone/bilikara']) {
      assert.equal(allowed({repository}, () => true), repository === 'VZRXS/bilikara', `${id}/${repository}`);
    }
  }
  assert.match(jobs.get('gate'), /^    if: always\(\) && /m, 'public Gate still evaluates failed and skipped dependencies');
  for (const [id, block] of jobs) {
    if (['preflight', 'gate'].includes(id)) continue;
    assert.match(block, /^    needs: preflight$/m, `${id} must depend on the guarded Plan`);
    assert.doesNotMatch(block.match(/^    if: (.+)$/m)?.[1] || '', /always\(/, `${id} must retain dependency-success gating`);
  }
});

test('the actual Gate accepts only the complete plan and its explicitly expected skips', async () => {
  for (const kind of Object.keys(required)) {
    const plan = ciPlan(kind, 'changed-files');
    assert.deepEqual(Object.keys(plan.jobs).filter(name => plan.jobs[name]), required[kind]);
    await evaluateGate(healthy(plan));
    for (const name of ['preflight', ...Object.keys(physical)]) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
        const facts = healthy(plan);
        if (facts[name].result === result) continue;
        facts[name].result = result;
        await assert.rejects(evaluateGate(facts), undefined, `${kind}/${name}/${result}`);
      }
    }
  }
  const duplicate = ciPlan('full', 'open-pr', false);
  await evaluateGate(healthy(duplicate));
  for (const alter of [p => {p.scope = 'fast';}, p => {p.jobs.desktop = false;}, p => {delete p.jobs.mobile;},
    p => {p.version = 0;}, p => {p.reason = '';}, p => {p.run = false;}]) {
    const plan = ciPlan(); alter(plan); assert.throws(() => checkCiGate(groupCiPlatformResults(healthy(plan), readCiPlatformMatrix(workflow))));
  }
  const facts = healthy(ciPlan()); facts.preflight.outputs = {};
  await assert.rejects(evaluateGate(facts));
});

test('docs and safe frontend diffs select different jobs; build, platform and unknown paths retain Full', () => {
  assert.equal(changeKind(['docs/ios-host.md', 'README.ja.md']), 'docs');
  assert.equal(changeKind(['static/host-layout.css', 'static/index.html', 'docs/ios-host.md']), 'frontend');
  for (const files of [null, [], Array(300).fill('README.md'), ['static/app.js'], ['static/compat83/styles.css'], ['static/ios-startup.html'],
    ['src-tauri/src/ios.rs'], ['rust/src/lib.rs'], ['media-libav/probe.c'], ['package-lock.json'],
    ['.github/workflows/ci.yml'], ['scripts/ci_tests.mjs'], ['security.txt'], ['unknown'], ['../README.md'],
    ['/README.md'], ['docs\\readme.md'], [null], ['static/index.html', 'scripts/ios.mjs']]) assert.equal(changeKind(files), 'full');
});

function fixture() {
  const context = {eventName: 'push', ref: 'refs/heads/feature/ios', sha: 'b'.repeat(40),
    repo: {owner: 'VZRXS', repo: 'bilikara-next'}, payload: {before: 'a'.repeat(40)}};
  const data = {status: 'ahead', total_commits: 1, commits: [{}], files: [{filename: 'static/host-layout.css', status: 'modified'}]};
  const prs = [], warnings = [];
  const github = {rest: {repos: {
    listPullRequestsAssociatedWithCommit: async () => ({data: prs}),
    compareCommitsWithBasehead: async args => {assert.equal(args.basehead, `${'a'.repeat(40)}...${'b'.repeat(40)}`); return {data};},
  }, pulls: {listFiles: Symbol('files')}}, paginate: async () => data.files};
  return {context, github, data, prs, warnings, resolve: requested => resolveCiPlan({github, context, requested, warn: message => warnings.push(message)})};
}

test('actual preflight emits a complete frontend plan and Full bypasses discovery', async () => {
  const f = fixture(), outputs = {};
  await new AsyncFunction('process', 'require', 'core', 'github', 'context', script('preflight'))(
    {env: {GITHUB_WORKSPACE: root, CI_SCOPE: 'fast'}}, require,
    {...core, setOutput(name, value) {outputs[name] = value;}}, f.github, f.context);
  assert.deepEqual(JSON.parse(outputs.plan), ciPlan('frontend', 'changed-files'));
  assert.equal(outputs.desktop, 'false'); assert.equal(outputs.frontend, 'true');
  f.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => {throw Error('must not query');};
  assert.deepEqual(await f.resolve('full'), ciPlan());
  f.context.ref = 'refs/tags/v0.9.0';
  assert.deepEqual(await f.resolve('fast'), ciPlan('full', 'release'));
  await assert.rejects(f.resolve('unsafe'));
});

test('pagination truncation, renames, API errors, new/forced branches and unknown manual diffs fail closed', async () => {
  for (const alter of [f => {delete f.data.files;}, f => {f.data.files = Array(300).fill({filename: 'README.md'});},
    f => {f.data.total_commits = 251;}, f => {f.data.commits = [];}, f => {f.data.status = 'diverged';},
    f => {f.data.files = [{filename: 'README.md', status: 'renamed', previous_filename: 'src-tauri/src/ios.rs'}];},
    f => {f.data.files = [{filename: 'README.md', status: 'renamed'}];},
    f => {f.context.payload.before = '0'.repeat(40);}, f => {f.context.payload.forced = true;},
    f => {f.context.eventName = 'workflow_dispatch';},
    f => {f.github.rest.repos.compareCommitsWithBasehead = async () => {throw Error('API unavailable');};}]) {
    const f = fixture(); alter(f); const plan = await f.resolve('fast');
    assert.equal(plan.kind, 'full'); assert.equal(plan.run, true);
  }
  for (const count of [1, 2, 300, undefined]) {
    const f = fixture(); f.context.eventName = 'pull_request'; f.context.payload.pull_request = {number: 12, changed_files: count};
    assert.equal((await f.resolve('fast')).kind, count === 1 ? 'frontend' : 'full');
  }
});

test('only an open PR for this exact repository, branch and HEAD can suppress a branch push', async () => {
  const f = fixture(), pr = {state: 'open', head: {sha: f.context.sha, ref: 'feature/ios', repo: {full_name: 'VZRXS/bilikara-next'}}};
  f.prs.push(pr);
  assert.deepEqual(await f.resolve('fast'), ciPlan('full', 'open-pr', false));
  for (const altered of [{...pr, state: 'closed'}, {...pr, head: {...pr.head, sha: 'c'.repeat(40)}},
    {...pr, head: {...pr.head, ref: 'other'}}, {...pr, head: {...pr.head, repo: {full_name: 'fork/other'}}}]) {
    f.prs[0] = altered; assert.equal((await f.resolve('fast')).run, true);
  }
});


test('the actual static matrix contains every required platform exactly once and rejects partial execution definitions', () => {
  const expected = [
    ['Linux', 'ubuntu-latest', 'desktop'], ['Windows', 'windows-latest', 'desktop'],
    ['macOS', 'macos-latest', 'desktop'], ['Android', 'ubuntu-latest', 'mobile'], ['iOS', 'xcode-27', 'mobile'],
  ];
  const matrix = readCiPlatformMatrix(workflow);
  assert.deepEqual(matrix.include.map(row => [row.label, row.os, row.kind]), expected);
  assert.equal(new Set(matrix.include.map(row => row.label)).size, 5);
  for (const mutate of [m => m.include.pop(), m => m.include.push(m.include[0]),
    m => m.include[4].os = 'ubuntu-latest', m => m.include[3].kind = 'desktop',
    m => m.exclude = [m.include[0]], m => m.include.reverse()]) {
    const bad = structuredClone(matrix); mutate(bad);
    assert.throws(() => readCiPlatformMatrix(workflow.replace(JSON.stringify(matrix), JSON.stringify(bad))));
    assert.throws(() => groupCiPlatformResults(healthy(ciPlan()), bad));
  }
  for (const modified of [workflow.replace('fail-fast: false', 'fail-fast: true'),
    workflow.replace('    strategy:', '    continue-on-error: true\n    strategy:'),
    workflow.replace("needs.preflight.outputs.scope == 'full'", "matrix.label == 'Linux'")]) assert.throws(() => readCiPlatformMatrix(modified));
  const missing = healthy(ciPlan()); delete missing.platforms;
  assert.throws(() => groupCiPlatformResults(missing, matrix));
  assert.ok(!workflow.split('  workflow_dispatch:')[1].split('  workflow_call:')[0].includes('inputs:'));
});

test('manual CI always requests complete checks without consulting change APIs', async () => {
  const f = fixture(); f.context.eventName = 'workflow_dispatch';
  f.github.rest.repos.listPullRequestsAssociatedWithCommit = () => {throw Error('unexpected API');};
  assert.deepEqual(await f.resolve('fast'), ciPlan());
});

// Exercise the actual REST request/response boundary, including every page.
function jobsFixture(prefix = '', runAttempt = 1) {
  const context = {repo: {owner: 'VZRXS', repo: 'bilikara-next'}, runId: 777};
  const job = (name, id, attempt = runAttempt) => ({name: prefix + name, id, run_id: context.runId,
    run_attempt: attempt, status: 'completed', conclusion: 'success'});
  const jobs = ['Linux', 'Windows', 'macOS', 'Android', 'iOS'].map((name, index) => job(name, index + 1));
  jobs.push({...job('Gate', 6), status: 'in_progress', conclusion: null});
  const calls = [];
  const github = {rest: {actions: {listJobsForWorkflowRun: async args => {
    calls.push(args);
    assert.deepEqual(args, {...context.repo, run_id: 777, filter: 'all', per_page: 100, page: calls.length});
    return {status: 200, data: {total_count: jobs.length, jobs: jobs.slice((args.page - 1) * 100, args.page * 100)}};
  }}}};
  return {github, context, runAttempt, jobs, job, calls};
}

test('Full Gate independently verifies all five successful jobs, using only read permission', async () => {
  const f = jobsFixture();
  assert.deepEqual(await verifyCiPlatformJobs(f), ['Linux', 'Windows', 'macOS', 'Android', 'iOS']
    .map((name, index) => ({name, id: index + 1, attempt: 1})));
  assert.equal(f.calls.length, 1);
  await evaluateGate(healthy(ciPlan()));
  await evaluateGate(healthy(ciPlan('full', 'release')), jobsFixture('CI / '));
  assert.match(workflow, /permissions:\n(?:  [\w-]+: read\n)*  actions: read/);
});

test('individual platform failure, cancellation without a runner and incompleteness defeat a successful aggregate', async () => {
  for (const name of ['Linux', 'Windows', 'macOS', 'Android', 'iOS']) {
    for (const [status, conclusion] of [['completed', 'failure'], ['completed', 'cancelled'],
      ['completed', 'skipped'], ['completed', 'neutral'], ['completed', 'timed_out'],
      ['completed', null], ['queued', null], ['in_progress', null], ['queued', 'success']]) {
      const f = jobsFixture();
      Object.assign(f.jobs.find(job => job.name === name), {status, conclusion, runner_id: 0, runner_name: null});
      await assert.rejects(evaluateGate(healthy(ciPlan()), f), undefined, `${name}/${status}/${conclusion}`);
    }
  }
  for (const name of ['Linux', 'Windows', 'macOS', 'Android', 'iOS', 'Gate']) {
    const f = jobsFixture(); f.jobs.splice(f.jobs.findIndex(job => job.name === name), 1);
    await assert.rejects(evaluateGate(healthy(ciPlan()), f), /Missing/);
  }
  const f = jobsFixture(); f.jobs.push(f.job('iOS', 7));
  await assert.rejects(evaluateGate(healthy(ciPlan()), f), /Duplicate platform job: iOS/);
});

test('workflow_call jobs must share the running Gate exact prefix; unrelated names cannot substitute', async () => {
  for (const prefix of ['', 'CI / ', 'Release / CI / ']) {
    const f = jobsFixture(prefix);
    f.jobs.push({...f.job('iOS', 7), name: 'Other / iOS', conclusion: 'failure'},
      {...f.job('Gate', 8), name: 'Other / Gate'});
    await evaluateGate(healthy(ciPlan()), f);
    f.calls.length = 0;
    f.jobs.find(job => job.name === prefix + 'iOS').name = 'Unrelated / iOS';
    await assert.rejects(evaluateGate(healthy(ciPlan()), f), /Missing platform job/);
  }
  const f = jobsFixture('CI / ');
  for (const suffix of ['iOS (extra)', 'iOS / nested', 'Not iOS']) {
    f.jobs[4].name = 'CI / ' + suffix; f.calls.length = 0;
    await assert.rejects(verifyCiPlatformJobs(f), /Missing platform job/);
  }
  f.jobs[4].name = 'CI / iOS';
  f.jobs.push({...f.job('Gate', 7), name: 'Other / Gate', status: 'in_progress'}); f.calls.length = 0;
  await assert.rejects(verifyCiPlatformJobs(f), /ambiguous running CI Gate/);
});

test('partial reruns use the latest execution per exact name, retaining only unrepeated earlier successes', async () => {
  const f = jobsFixture('CI / ', 3);
  f.jobs.slice(0, 5).forEach(job => job.run_attempt = 1);
  // Unordered attempts: neither job ID nor list order is the attempt ordering.
  f.jobs[4].conclusion = 'failure';
  f.jobs.push(f.job('iOS', 20, 3), {...f.job('iOS', 30, 2), conclusion: 'cancelled'},
    {...f.job('Gate', 40, 1), conclusion: 'failure'});
  await evaluateGate(healthy(ciPlan()), f);
  f.calls.length = 0;
  const checked = await verifyCiPlatformJobs(f);
  assert.deepEqual(checked.map(job => job.attempt), [1, 1, 1, 1, 3]);
  assert.equal(checked[4].id, 20);
  // A prior success cannot hide the most recent cancellation or queued rerun.
  for (const [status, conclusion] of [['completed', 'cancelled'], ['queued', null]]) {
    Object.assign(f.jobs.find(job => job.id === 20), {status, conclusion});
    f.jobs[4].conclusion = 'success'; f.calls.length = 0;
    await assert.rejects(evaluateGate(healthy(ciPlan()), f), /latest execution/);
  }
  Object.assign(f.jobs.find(job => job.id === 20), {status: 'completed', conclusion: 'success'});
  f.jobs.push(f.job('iOS', 50, 3)); f.calls.length = 0;
  await assert.rejects(verifyCiPlatformJobs(f), /Duplicate platform job/);
});

test('Jobs API paginates past unrelated jobs and catches failures and duplicate IDs on later pages', async () => {
  const f = jobsFixture();
  f.jobs.unshift(...Array.from({length: 200}, (_, index) => f.job(`Other ${index}`, index + 100)));
  await evaluateGate(healthy(ciPlan()), f);
  assert.deepEqual(f.calls.map(call => call.page), [1, 2, 3]);
  f.jobs.find(job => job.name === 'iOS').conclusion = 'failure'; f.calls.length = 0;
  await assert.rejects(evaluateGate(healthy(ciPlan()), f), /iOS: latest execution/);
  f.jobs.find(job => job.name === 'iOS').conclusion = 'success';
  f.jobs[200].id = f.jobs[0].id; f.calls.length = 0;
  await assert.rejects(verifyCiPlatformJobs(f), /duplicate workflow job ID/);
});

test('Jobs API errors, malformed responses, inconsistent pagination and invalid metadata fail closed', async () => {
  const invalid = [undefined, null, {}, {total_count: 1}, {total_count: '6', jobs: []},
    {total_count: -1, jobs: []}, {total_count: 1.5, jobs: []}, {total_count: 7, jobs: []}];
  for (const data of invalid) {
    const f = jobsFixture(); f.github.rest.actions.listJobsForWorkflowRun = async () => ({status: 200, data});
    await assert.rejects(evaluateGate(healthy(ciPlan()), f));
  }
  for (const status of [403, 500]) {
    const f = jobsFixture(); f.github.rest.actions.listJobsForWorkflowRun = async () => ({status, data: {total_count: 0, jobs: []}});
    await assert.rejects(evaluateGate(healthy(ciPlan()), f), /Cannot read workflow jobs/);
  }
  const f = jobsFixture(); f.github.rest.actions.listJobsForWorkflowRun = async () => {throw Error('API unavailable');};
  await assert.rejects(evaluateGate(healthy(ciPlan()), f), /API unavailable/);
  for (const alter of [f => {f.jobs[0] = null;}, f => {delete f.jobs[0].id;},
    f => {f.jobs[0].id = f.jobs[1].id;}, f => {f.jobs[0].run_id = 888;},
    f => {delete f.jobs[0].name;}, f => {delete f.jobs[0].run_attempt;},
    f => {f.jobs[0].run_attempt = 0;}, f => {f.jobs[0].run_attempt = 2;},
    f => {f.context.runId = 0;}, f => {f.runAttempt = NaN;}]) {
    const f = jobsFixture(); alter(f); await assert.rejects(verifyCiPlatformJobs(f));
  }
  const pages = jobsFixture();
  pages.github.rest.actions.listJobsForWorkflowRun = async ({page}) => ({status: 200,
    data: page === 1 ? {total_count: 101, jobs: Array.from({length: 100}, (_, i) => pages.job(`Other ${i}`, i + 100))}
      : {total_count: 100, jobs: []}});
  await assert.rejects(verifyCiPlatformJobs(pages), /changed during pagination/);
  pages.github.rest.actions.listJobsForWorkflowRun = async ({page}) => {
    if (page > 1) throw Error('page unavailable');
    return {status: 200, data: {total_count: 101, jobs: Array.from({length: 100}, (_, i) => pages.job(`Other ${i}`, i + 100))}};
  };
  await assert.rejects(verifyCiPlatformJobs(pages), /page unavailable/);
});

test('Docs, Frontend and PR-deduplicated plans do not consult Jobs API; aggregate failures still fail first', async () => {
  const f = jobsFixture();
  f.github.rest.actions.listJobsForWorkflowRun = async () => {throw Error('unexpected Jobs API call');};
  for (const plan of [ciPlan('docs', 'changed-files'), ciPlan('frontend', 'changed-files'), ciPlan('full', 'open-pr', false)]) {
    await evaluateGate(healthy(plan), f);
  }
  const facts = healthy(ciPlan()); facts.platforms.result = 'failure';
  await assert.rejects(evaluateGate(facts, f), /desktop: expected success/);
});
