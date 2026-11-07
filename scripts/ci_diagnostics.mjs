// Read-only Actions diagnostics. Missing telemetry must not mask a build result.
import fs from 'node:fs';

const text = value => String(value ?? 'unavailable').replace(/[\r\n|`<>]/g, ' ');
const duration = (start, end) => Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
export function jobDiagnostics({title, jobs, caches, now = new Date().toISOString()}) {
  const job = jobs.find(item => item.name === title || item.name.endsWith(` / ${title}`));
  const lines = [`\n### ${text(title)} performance`, '',
    `Elapsed before finalization: ${job?.started_at ? duration(job.started_at, job.completed_at || now).toFixed(1) + 's' : 'unavailable'}.`, '',
    '| Cache | Exact restore result |', '| --- | --- |'];
  for (const [name, value] of Object.entries(caches)) lines.push(`| ${text(name)} | ${value === 'true' ? 'hit' : value === 'false' ? 'miss / fallback' : 'not restored'} |`);
  lines.push('', 'Cache save results and transfer overhead remain in the post-job steps; an exact miss can still restore a compatible prefix.', '',
    '| Longest completed steps | Seconds |', '| --- | ---: |');
  const steps = (job?.steps ?? []).filter(step => step.started_at && step.completed_at && step.conclusion !== 'skipped')
    .map(step => ({name: step.name, seconds: duration(step.started_at, step.completed_at)}))
    .sort((a, b) => b.seconds - a.seconds).slice(0, 8);
  for (const step of steps) lines.push(`| ${text(step.name)} | ${step.seconds.toFixed(1)} |`);
  return lines.concat('').join('\n');
}

export async function writeJobDiagnostics({github, core, context, title, caches, operations}) {
  let jobs = [];
  try {
    jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
      ...context.repo, run_id: context.runId, attempt_number: Number(process.env.GITHUB_RUN_ATTEMPT), per_page: 100,
    });
  } catch (error) {core.warning(`Step timing API unavailable: ${error.message}`);}
  let markdown = jobDiagnostics({title, jobs, caches});
  if (operations && fs.existsSync(operations)) {
    const records = fs.readFileSync(operations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    markdown += `\nNative test Cargo requests: ${records.length}; compiler artifacts rebuilt: ${records.reduce((sum, row) => sum + row.rebuilt, 0)}; fresh artifacts reused: ${records.reduce((sum, row) => sum + row.fresh, 0)}.\n`;
  }
  await core.summary.addRaw(markdown).write();
}
