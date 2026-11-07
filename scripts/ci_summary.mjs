// CI metadata only. List run-wide artifacts so a partial rerun cannot hide
// downloads produced by successful jobs in an earlier attempt.
import assert from 'node:assert/strict';

function escapeText(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'invalid summary text');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_[\]()|]/g, '\\$&');
}

export function renderCiSummary({context, results, artifacts}) {
  const {owner, repo} = context.repo;
  assert.match(owner, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  assert.match(repo, /^[A-Za-z0-9_.-]+$/);
  assert.ok(Number.isSafeInteger(context.runId) && context.runId > 0);
  assert.match(context.sha, /^[a-f0-9]{40}$/i);
  const server = new URL(context.serverUrl);
  assert.equal(server.protocol, 'https:');
  assert.equal(server.origin, context.serverUrl);
  const base = `${server.origin}/${owner}/${repo}`;
  const lines = [
    '# Build results and downloads', '',
    `Commit: [${context.sha.slice(0, 8)}](${base}/commit/${context.sha})`, '',
    '| Build | Result |', '| --- | --- |',
  ];
  for (const group of ['desktop', 'mobile']) {
    const result = results[group]?.result;
    assert.ok(['success', 'failure', 'cancelled', 'skipped'].includes(result), 'invalid build result');
    lines.push(`| ${group === 'desktop' ? 'Desktop' : 'Mobile'} | ${result} |`);
  }
  assert.ok(Array.isArray(artifacts));
  lines.push('', `## Artifacts (${artifacts.length})`, '',
    'Includes artifacts from every attempt of this run. Cache details remain in job logs.', '');
  if (artifacts.length === 0) return lines.concat('No artifacts were uploaded.', '').join('\n');
  lines.push('| Download | Size | Status |', '| --- | ---: | --- |');
  const seen = new Set();
  for (const artifact of [...artifacts].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id - b.id)) {
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && !seen.has(artifact.id), 'invalid artifact id');
    seen.add(artifact.id);
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes >= 0, 'invalid artifact size');
    assert.equal(typeof artifact.expired, 'boolean');
    const name = escapeText(artifact.name);
    const download = artifact.expired ? name : `[${name}](${base}/actions/runs/${context.runId}/artifacts/${artifact.id})`;
    lines.push(`| ${download} | ${(artifact.size_in_bytes / 1024 / 1024).toFixed(1)} MiB | ${artifact.expired ? 'Expired' : 'Available'} |`);
  }
  return lines.concat('').join('\n');
}

export async function writeCiSummary({github, core, context, results}) {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: context.runId,
    per_page: 100,
  });
  await core.summary.addRaw(renderCiSummary({context, results, artifacts})).write();
}
