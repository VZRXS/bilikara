// Preserve the public npm entries. CI selects their union once per configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const groups = {
  tooling: ['desktop-build', 'libav-wrapper', 'media-entry', 'native-host-entry', 'native-media-entry'],
  frontend: ['frontend', 'remote-sync', 'host-experience', 'ios-playback', 'media-output', 'app-updates', 'mobile-host', 'android-webview', 'bilibili-video'],
  shared: ['frontend', 'remote-sync', 'host-experience', 'ios-playback', 'media-output', 'app-updates', 'mobile-host', 'android-webview', 'bilibili-video',
    'native-users', 'native-ratings', 'portable-loudness', 'purek', 'native-transport', 'native-media'],
};

export function selectTests(suites, scripts, read = file => fs.readFileSync(path.join(root, file), 'utf8')) {
  const coverage = new Set(), entries = [];
  let requested = 0;
  const closure = file => {
    const source = read(file), pattern = /^import ['"]\.\/([\w_]+\.test\.mjs)['"];?$/gm;
    const imports = [...source.matchAll(pattern)].map(match => `tests/${match[1]}`);
    if (imports.length) assert.equal(source.replace(pattern, '').replace(/^\/\/.*$/gm, '').trim(), '',
      `test aggregates must contain only imports: ${file}`);
    return imports.length ? [...new Set(imports.flatMap(closure))] : [file];
  };
  for (const suite of suites) {
    const command = scripts[`test:${suite}`];
    assert.match(command ?? '', /^node --test(?: tests\/[\w_]+\.test\.mjs)+$/, `unsupported CI test entry: ${suite}`);
    for (const file of command.slice('node --test '.length).split(' ')) {
      const files = closure(file); requested += files.length;
      if (files.every(item => coverage.has(item))) continue;
      // An aggregate with partial overlap must not silently execute duplicates.
      assert.ok(files.every(item => !coverage.has(item)), `partially overlapping aggregate: ${file}`);
      files.forEach(item => coverage.add(item)); entries.push(file);
    }
  }
  return {entries, files: [...coverage], requested, duplicates: requested - coverage.size};
}

async function main() {
  const group = process.argv[2];
  assert.ok(Object.hasOwn(groups, group), 'Unknown CI test group');
  const {scripts} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const plan = selectTests(groups[group], scripts);
  console.log(`CI ${group}: ${plan.files.length} distinct test files; ${plan.duplicates} duplicate file selections removed.`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nNode ${group}: **${plan.files.length}** distinct test files; **${plan.duplicates}** duplicate selections removed.\n`, 'utf8');
  if (process.argv.includes('--list')) {console.log(plan.entries.join('\n')); return;}
  const started = Date.now();
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...plan.entries], {cwd: root, stdio: 'inherit'});
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));});
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Node ${group}: ${((Date.now() - started) / 1000).toFixed(1)}s; exit ${code}.\n`, 'utf8');
  process.exitCode = code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
