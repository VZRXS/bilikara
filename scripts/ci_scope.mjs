// A missing, truncated or failed comparison must retain the native matrix.
import assert from 'node:assert/strict';

export const ciJobs = ['desktop', 'mobile', 'frontend', 'auxiliary', 'docs'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

export function changeKind(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length >= 300) return 'full';
  let frontend = false;
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.includes('..') || file.startsWith('/') || file.includes('\\')) return 'full';
    if (/^(?:docs\/[\w./-]+\.md|README(?:\.[a-z-]+)?\.md|AGENTS\.md|LICENSE)$/.test(file)) continue;
    // Script, generated-asset, build, platform and security edits remain Full.
    if (/^static\/(?:[\w-]+\.css|(?:index|remote|presentation|controller)\.html)$/.test(file)) {frontend = true; continue;}
    return 'full';
  }
  return frontend ? 'frontend' : 'docs';
}

export const automaticScope = files => changeKind(files) === 'full' ? 'full' : 'fast';

export function ciPlan(kind = 'full', reason = 'requested-full', run = true) {
  assert.ok(['full', 'frontend', 'docs'].includes(kind));
  assert.equal(typeof run, 'boolean');
  assert.ok(['requested-full', 'release', 'changed-files', 'incomplete-diff', 'comparison-failed', 'open-pr'].includes(reason));
  assert.ok(reason === 'changed-files' || kind === 'full', 'only a complete diff can select Fast');
  assert.equal(!run, reason === 'open-pr', 'only a matching open PR can suppress the entire run');
  return {version: 1, run, scope: kind === 'full' ? 'full' : 'fast', kind, reason,
    jobs: Object.fromEntries(ciJobs.map(job => [job, run && (kind === 'full'
      ? ['desktop', 'mobile', 'auxiliary'].includes(job)
      : kind === 'frontend' ? ['frontend', 'auxiliary'].includes(job) : job === 'docs')]))};
}

function filenames(files) {
  if (!Array.isArray(files) || files.some(file => typeof file?.filename !== 'string'
    || (file.status === 'renamed' && typeof file.previous_filename !== 'string'))) return undefined;
  return files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
}

export async function resolveCiPlan({github, context, requested = 'fast', warn = () => {}}) {
  assert.ok(['fast', 'full'].includes(requested), 'Unknown CI scope');
  if (context.ref?.startsWith('refs/tags/')) return ciPlan('full', 'release');
  // Explicit reusable/manual Full calls never depend on change-list APIs or PR deduplication.
  if (requested === 'full' || context.eventName === 'workflow_dispatch') return ciPlan();
  try {
    if (context.eventName === 'pull_request') {
      const pr = context.payload.pull_request;
      const files = await github.paginate(github.rest.pulls.listFiles, {...context.repo, pull_number: pr.number, per_page: 100});
      if (!Number.isSafeInteger(pr.changed_files) || files.length !== pr.changed_files || files.length >= 300) return ciPlan('full', 'incomplete-diff');
      const names = filenames(files);
      return ciPlan(changeKind(names), names ? 'changed-files' : 'incomplete-diff');
    }
    if (context.eventName === 'push' && context.ref?.startsWith('refs/heads/')) {
      const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({...context.repo, commit_sha: context.sha, per_page: 100});
      if (response.data.some(pr => pr.state === 'open' && pr.head.sha === context.sha
        && pr.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`
        && pr.head.ref === context.ref.slice('refs/heads/'.length))) return ciPlan('full', 'open-pr', false);
      if (!sha(context.payload.before) || !sha(context.sha) || context.payload.forced || context.payload.deleted) return ciPlan('full', 'incomplete-diff');
      const {data} = await github.rest.repos.compareCommitsWithBasehead({...context.repo, basehead: `${context.payload.before}...${context.sha}`});
      // GitHub returns at most 300 files and 250 commits in this response.
      if (data.status !== 'ahead' || !Number.isSafeInteger(data.total_commits) || data.total_commits > 250
        || data.commits?.length !== data.total_commits || !Array.isArray(data.files) || data.files.length >= 300) return ciPlan('full', 'incomplete-diff');
      const names = filenames(data.files);
      return ciPlan(changeKind(names), names ? 'changed-files' : 'incomplete-diff');
    }
    // A manual Fast request has no complete diff to justify skipped native work.
    return ciPlan('full', 'incomplete-diff');
  } catch (error) {
    warn(`Change discovery failed; selecting Full CI (${error.message})`);
    return ciPlan('full', 'comparison-failed');
  }
}

// Keep the complete definition reviewable in ci.yml. Gate validates that actual
// definition, not a second preflight output that could drift from execution.
export const ciPlatforms = [
  {label: 'Linux', os: 'ubuntu-latest', kind: 'desktop'},
  {label: 'Windows', os: 'windows-latest', kind: 'desktop'},
  {label: 'macOS', os: 'macos-latest', kind: 'desktop'},
  {label: 'Android', os: 'ubuntu-latest', kind: 'mobile'},
  {label: 'iOS', os: 'xcode-27', kind: 'mobile'},
];

export function readCiPlatformMatrix(workflow) {
  const block = workflow.replace(/\r\n/g, '\n').split('\n  platforms:\n')[1]?.split(/\n  [a-z][\w-]*:\n/)[0];
  assert.ok(block, 'Missing CI platform job');
  assert.ok(block.includes("    if: needs.preflight.outputs.run == 'true' && needs.preflight.outputs.scope == 'full'\n"));
  assert.ok(!block.includes('continue-on-error'), 'Platform failures must be fatal');
  assert.equal((block.match(/^      matrix:/gm) ?? []).length, 1, 'Ambiguous platform matrix');
  const definition = block.match(/    strategy:\n      fail-fast: false\n(?:      #.*\n)*      matrix: (\{[^\n]+\})\n/);
  assert.ok(definition, 'Expected a static, non-fail-fast platform matrix');
  const matrix = JSON.parse(definition[1]);
  assert.deepEqual(matrix, {include: ciPlatforms}, 'Incomplete or unexpected CI platforms');
  return matrix;
}

export function groupCiPlatformResults(results, matrix) {
  assert.deepEqual(matrix, {include: ciPlatforms}, 'Incomplete or unexpected CI platforms');
  assert.deepEqual(Object.keys(results).sort(),
    ['preflight', 'platforms', 'frontend', 'auxiliary', 'docs'].sort(), 'Missing/unexpected CI job results');
  // Retain the aggregate check, then independently verify actual platform jobs
  // in Full plans: runner-allocation failures can escape the aggregate result.
  const grouped = Object.fromEntries(['preflight', 'frontend', 'auxiliary', 'docs'].map(name => [name, results[name]]));
  grouped.desktop = grouped.mobile = {result: results.platforms?.result};
  return grouped;
}

export function checkCiGate(results) {
  assert.equal(results.preflight?.result, 'success', 'CI preflight did not succeed');
  const plan = JSON.parse(results.preflight.outputs.plan);
  assert.deepEqual(plan, ciPlan(plan.kind, plan.reason, plan.run), 'invalid CI plan');
  for (const job of ciJobs) {
    const expected = plan.jobs[job] ? 'success' : 'skipped';
    assert.equal(results[job]?.result, expected, `${job}: expected ${expected}`);
  }
  return plan;
}

export async function verifyCiPlatformJobs({github, context, runAttempt}) {
  assert.ok(Number.isSafeInteger(context.runId) && context.runId > 0, 'Invalid workflow run ID');
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt > 0, 'Invalid workflow run attempt');
  const jobs = [];
  let total;
  for (let page = 1; total === undefined || jobs.length < total; page++) {
    // Read all attempts: a partial rerun legitimately reuses successful jobs
    // from older attempts. Select each exact job name's latest attempt below.
    const {status, data} = await github.rest.actions.listJobsForWorkflowRun({
      ...context.repo, run_id: context.runId, filter: 'all', per_page: 100, page,
    });
    assert.equal(status, 200, 'Cannot read workflow jobs');
    assert.ok(Number.isSafeInteger(data?.total_count) && data.total_count >= 0
      && Array.isArray(data.jobs), 'Malformed workflow jobs response');
    total ??= data.total_count;
    assert.equal(data.total_count, total, 'Workflow jobs changed during pagination');
    assert.equal(data.jobs.length, Math.min(100, total - jobs.length), 'Incomplete workflow jobs page');
    jobs.push(...data.jobs);
  }
  const ids = new Set();
  for (const job of jobs) {
    assert.ok(job && Number.isSafeInteger(job.id) && job.id > 0 && !ids.has(job.id), 'Missing/duplicate workflow job ID');
    ids.add(job.id);
    assert.equal(job.run_id, context.runId, 'Job belongs to another workflow run');
    assert.ok(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 && job.run_attempt <= runAttempt,
      'Invalid workflow job attempt');
    assert.ok(typeof job.name === 'string' && job.name.length > 0, 'Invalid workflow job name');
  }
  // Derive the exact workflow_call namespace from the currently executing Gate.
  // A bare suffix match could borrow successes from another reusable workflow.
  const gates = jobs.filter(job => (job.name === 'Gate' || job.name.endsWith(' / Gate'))
    && job.run_attempt === runAttempt && job.status === 'in_progress');
  assert.equal(gates.length, 1, 'Missing/ambiguous running CI Gate');
  const prefix = gates[0].name.slice(0, -'Gate'.length);
  return ciPlatforms.map(({label}) => {
    const name = prefix + label;
    const executions = jobs.filter(job => job.name === name);
    assert.ok(executions.length > 0, `Missing platform job: ${name}`);
    const attempt = Math.max(...executions.map(job => job.run_attempt));
    const latest = executions.filter(job => job.run_attempt === attempt);
    assert.equal(latest.length, 1, `Duplicate platform job: ${name} (attempt ${attempt})`);
    const job = latest[0];
    assert.equal(job.status, 'completed', `${name}: latest execution is incomplete`);
    assert.equal(job.conclusion, 'success', `${name}: latest execution did not succeed`);
    return {name, id: job.id, attempt};
  });
}
