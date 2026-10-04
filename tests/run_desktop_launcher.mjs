// Compile the existing Linux child reaper so only this test owns its processes.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
import { nativeTarget } from './desktop_construction_expectations.mjs';
assert.equal(process.argv.length, 3, 'usage: node tests/run_desktop_launcher.mjs EVIDENCE_DIRECTORY');
assert.equal(process.platform, 'linux', 'real launcher regression requires Linux X11/WebKit');
const directory = mkdtempSync(path.join(root, '.tmp/launcher supervisor 中文 '));
try {
  const fixture = path.join(directory, 'supervisor');
  const env = { ...process.env }; delete env.CARGO_BUILD_TARGET;
  const compile = await runNative('rustc', ['--edition=2024', '--target', nativeTarget(), '--crate-name', 'smoke_process', path.join(root, 'tests/fixtures/smoke_process.rs'), '-o', fixture], env);
  assert.equal(compile.status, 0, compile.stderr);
  const evidence = path.resolve(process.argv[2]); mkdirSync(evidence, {recursive: true});
  copyFileSync(fixture, path.join(evidence, 'process-supervisor'));
  writeFileSync(path.join(evidence, 'supervisor-source.json'), JSON.stringify({executable: fixture, sha256: createHash('sha256').update(readFileSync(path.join(root, 'tests/fixtures/smoke_process.rs'))).digest('hex')}));
  const result = await runNative(fixture, ['supervise', process.execPath, path.join(root, 'tests/desktop_launcher_smoke.mjs'), path.resolve(process.argv[2])], env, 600000);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;
} finally { rmSync(directory, { recursive: true, force: true }); }
