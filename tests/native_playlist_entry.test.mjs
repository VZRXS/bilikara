import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';

test('playlist stress entry runs the current host-native test artifact; CI keeps one normal Rust gate', () => {
  const scripts = JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  assert.equal(scripts['test:playlist-stress'],'node tests/run_playlist_stress.mjs');
  assert.equal(scripts['test:playlist-entry'],'node --test tests/native_playlist_entry.test.mjs');
  const workflow = readFileSync(path.join(root,'.github/workflows/ci-bundle.yml'),'utf8');
  const block = workflow.split('      - name: Rust Checks and Build')[1].split('      - name: Verify frontend')[0];
  assert.match(block,/cd \.\.\/rust-runtime[\s\S]*cargo test --locked/);
  assert.equal(workflow.includes('npm run test:playlist-stress\n'),false,'normal integration already runs in cargo test');
  assert.equal(workflow.split('\n').filter(line=>line.trim()==='npm run test:playlist-entry').length,1);
  assert.equal(readFileSync(path.join(root,'tests/native_runtime_artifacts.mjs'),'utf8').includes("artifact(['test', '--test', 'native_playlist_stress', '--no-run'], 'native_playlist_stress', true)"),true);
});

test('stress CLI rejects invalid counts and shell-like text before compiler invocation', async () => {
  for (const args of [['--stress','--seeds','0'],['--stress','--seeds','1001'],['--steps=-1'],['--steps','1; touch ignored'],['--concurrent-sessions','0']]) {
    const result = await runNative(process.execPath,['tests/run_playlist_stress.mjs',...args],{...process.env,PATH:''});
    assert.equal(result.status,1);assert.match(result.stderr,/invalid --/);assert.equal(result.stderr.includes('cargo'),false);
  }
});

test('short explicit native stress really executes both lifecycle and concurrency gates', {timeout:600000},async()=>{
  const result=await runNative(process.execPath,['tests/run_playlist_stress.mjs','--stress','--seeds','2','--steps','180','--concurrent-sessions','2'],process.env,590000);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/2 passed; 0 failed; 0 ignored/);
  assert.match(result.stderr,/playlist lifecycle: 2 seeds × 180 steps/);
});
