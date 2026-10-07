import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';

test('explicit required media input rejects absent, malformed and foreign libraries before Cargo/browser execution', {
  skip: process.platform !== 'linux' && 'Linux ELF/TLS boundary',
}, async t => {
  const directory=ownedDirectory('native media negative');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const input=path.join(directory,'libbilikara_media_libav.so');
  const environment={...process.env,PATH:directory};delete environment.BILIKARA_TEST_LIBAV_COMPANION;delete environment.NODE_TEST_CONTEXT;
  for(const bytes of [undefined,Buffer.from('invalid library'),Buffer.alloc(64)]) {
    if(bytes){if(bytes.length===64){bytes.write('7f454c46',0,'hex');bytes[4]=2;bytes[5]=1;bytes.writeUInt16LE(3,16);bytes.writeUInt16LE(process.arch==='arm64'?62:183,18);}writeFileSync(input,bytes);}
    const result=await runNative(process.execPath,['tests/run_desktop_rust_host.mjs',directory],{...environment,...(bytes?{BILIKARA_TEST_LIBAV_COMPANION:input}:{})},15000);
    assert.notEqual(result.status,0);assert.match(result.stderr,/BILIKARA_TEST_LIBAV_COMPANION/);
    assert.doesNotMatch(result.stderr,/spawn cargo|Executable doesn't exist/);
  }
});

test('native browser media caller runs once after required prefix, test oracle and installed browser; old producer is retired',()=>{
  const scripts=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  assert.equal(scripts['test:native-media'],'node --test tests/native_desktop_media.test.mjs');
  assert.equal(scripts['test:native-shared'],'node tests/run_desktop_rust_host.mjs');
  assert.equal(existsSync(path.join(root,'tests/run_desktop_rust_host.py')),false);
  const workflow=readFileSync(path.join(root,'.github/workflows/ci-bundle.yml'),'utf8');
  const job=workflow.slice(workflow.indexOf('\n  test:'),workflow.indexOf('\n  bundle:'));
  const call='npm run test:native-media',invocation=`\n          ${call}\n`;assert.equal(job.split('\n').filter(line=>line.trim()===call).length,1);
  assert.ok(job.indexOf('BILIKARA_TEST_LIBAV_COMPANION=')<job.indexOf(invocation));
  assert.ok(job.indexOf('ffmpeg')<job.indexOf(invocation),'FFmpeg is an explicit test oracle, never a product executable');
  const step=job.split(/^      - name:/m).find(block=>block.includes(invocation));
  assert.match(step,/if: runner.os == 'Linux'/);assert.match(step,/set -euo pipefail/);
  assert.ok(step.indexOf('playwright install --with-deps chromium webkit')<step.indexOf(call));
  assert.doesNotMatch(step,/python|continue-on-error|\|\| true/);
});
