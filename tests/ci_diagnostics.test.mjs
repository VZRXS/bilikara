import assert from 'node:assert/strict';
import test from 'node:test';
import {jobDiagnostics, writeJobDiagnostics} from '../scripts/ci_diagnostics.mjs';

test('diagnostics report real timings and distinguish misses, hits and unscheduled caches', () => {
  const output = jobDiagnostics({title: 'Bundle (Windows x64)', caches: {Rust: 'true', C: 'false', npm: ''},
    now: '2026-10-29T00:02:00Z', jobs: [{name: 'Validation / desktop / Bundle (Windows x64)',
      started_at: '2026-10-29T00:00:00Z', completed_at: null, steps: [
        {name: 'Compile', started_at: '2026-10-29T00:00:01Z', completed_at: '2026-10-29T00:01:01Z', conclusion: 'success'},
        {name: 'Skipped', started_at: '2026-10-29T00:00:00Z', completed_at: '2026-10-29T00:01:59Z', conclusion: 'skipped'},
      ]}]});
  assert.match(output, /120.0s/); assert.match(output, /Compile \| 60.0/);
  assert.match(output, /Rust \| hit/); assert.match(output, /C \| miss \/ fallback/); assert.match(output, /npm \| not restored/);
  assert.doesNotMatch(output, /Skipped \|/); assert.match(output, /post-job steps/);
});

test('timing API failure is visible and cannot change the build result', async () => {
  let warning = '', output = '';
  await writeJobDiagnostics({title: 'Test (iOS)', caches: {}, context: {repo: {owner: 'VZRXS', repo: 'bilikara'}, runId: 12},
    github: {rest: {actions: {listJobsForWorkflowRunAttempt: {}}}, paginate: async () => {throw Error('denied');}},
    core: {warning(value) {warning = value;}, summary: {addRaw(value) {output = value; return this;}, async write() {}}}});
  assert.match(warning, /denied/); assert.match(output, /Elapsed before finalization: unavailable/);
});
