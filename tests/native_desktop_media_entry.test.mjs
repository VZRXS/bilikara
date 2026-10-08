import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { root, runNative } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { nativeTarget } from './desktop_construction_expectations.mjs';

test('compiled BBDown failure fixture waits for the matching track and attempt only in the paired gate', async t => {
  const directory=realpathSync.native(ownedDirectory('bbdown paired failure 中文')),processes=[];
  t.after(async()=>{await Promise.allSettled(processes);rmSync(directory,{recursive:true,force:true});});
  const binary=path.join(directory,process.platform==='win32'?'BBDown.exe':'BBDown');
  const built=await runNative('rustc',['--edition=2024','--target',nativeTarget(),'--crate-name','bbdown_fixture',path.join(root,'tests/bbdown_fixture.rs'),'-o',binary]);
  assert.equal(built.status,0,built.stderr);
  const config=path.join(directory,'empty config');writeFileSync(config,'');writeFileSync(path.join(directory,'mode'),'exit');
  const environment={...process.env,PATH:'',BILIKARA_BBDOWN_FIXTURE_ROOT:directory,BILIKARA_BBDOWN_MEDIA:directory,BILIKARA_BBDOWN_PAIR_FAILURES:'1'};
  delete environment.BILIKARA_BBDOWN_EXPECT_COOKIE;
  const child=(kind,attempt,extra={})=>{
    const cwd=path.join(directory,attempt,kind);mkdirSync(cwd,{recursive:true});
    const result=runNative(binary,['--skip-mux',`--${kind}-only`,'--work-dir',cwd,'--config-file',config,'-p','1','-q','64'],{...environment,...extra},8000,cwd);
    processes.push(result);return result;
  };
  const unpaired=await child('video','ordinary',{BILIKARA_BBDOWN_PAIR_FAILURES:''});
  assert.equal(unpaired.status,7,'ordinary single-track consumers retain immediate exit');
  writeFileSync(path.join(directory,'pair-wrong-attempt-audio-1'),'started');
  const video=child('video','selected');
  const deadline=performance.now()+3000;
  while(!existsSync(path.join(directory,'pair-selected-video-1'))){
    assert.ok(performance.now()<deadline,'fixture publishes its actual child receipt');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const waiting=await Promise.race([video.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),100))]);
  assert.equal(waiting,true,'another attempt cannot release this failure');
  const [first,second]=await Promise.all([video,child('audio','selected')]);
  assert.equal(first.status,7);assert.equal(second.status,7);
  assert.equal(readdirSync(directory).filter(file=>/^\d+\.started$/.test(file)).length,3);
});

test('BBDown failure receipts preserve attempt identities with bounded, credential-free diagnostics', async t => {
  const directory=ownedDirectory('bbdown failure evidence 中文');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const {retryEvidence}=createRequire(import.meta.url)('./bbdown_fixture_evidence.cjs');
  const state={id:'current',item_incarnation_id:'incarnation-1',artifact_set_id:'artifact-2',cache_status:'failed',cookie:'secret-cookie',cache_message:'secret-output',title:'private-title'};
  for(let pid=1;pid<=12;pid++)writeFileSync(path.join(directory,pid+'.started'),`audio\n2\nexit\n${path.join(directory,'cache','.staging','incarnation-1','artifact-2','audio-2')}\nsecret-tail`);
  const result=await retryEvidence({root:directory,directory,failure:'exit',before:state,after:state,files:Array.from({length:12},(_,n)=>(n+1)+'.started')});
  assert.equal(result.child_count,12);assert.equal(result.children.length,8);
  assert.deepEqual(result.children[0],{pid:1,kind:'audio',page:2,mode:'exit',item_incarnation_id:'incarnation-1',artifact_set_id:'artifact-2',track:'audio-2'});
  assert.deepEqual(result.after,{id:'current',item_incarnation_id:'incarnation-1',artifact_set_id:'artifact-2',cache_status:'failed'});
  assert.doesNotMatch(JSON.stringify(result),/secret|private-title/);
  writeFileSync(path.join(directory,'1.started'),`secret-output\nNaN\nsecret-mode\n${path.join(directory,'..','outside')}\n`+'secret-tail'.repeat(10000));
  const invalid=await retryEvidence({root:directory,directory,failure:'exit',files:['../unsafe','1.started']});
  assert.deepEqual(invalid.children,[{pid:1,kind:'invalid',page:undefined,mode:'invalid',invalid_work_directory:true}]);
  assert.doesNotMatch(JSON.stringify(invalid),/secret|outside|unsafe/);
});

test('BBDown case surfaces safe receipts before failure cleanup and preserves the original assertion', async t => {
  const directory=ownedDirectory('bbdown failure output 中文');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const require=createRequire(import.meta.url), lines=[];
  t.mock.method(console,'error',line=>lines.push(line));
  const prior=process.env.BILIKARA_BBDOWN_FIXTURE_ROOT;process.env.BILIKARA_BBDOWN_FIXTURE_ROOT=directory;
  t.after(()=>{if(prior===undefined)delete process.env.BILIKARA_BBDOWN_FIXTURE_ROOT;else process.env.BILIKARA_BBDOWN_FIXTURE_ROOT=prior;});
  writeFileSync(path.join(directory,'123.started'),`video\n1\nexit\n${path.join(directory,'cache','.staging','incarnation-1','artifact-2','video')}\nsecret-output`);
  for(const unavailable of [false,true]){
    await assert.rejects(require('./desktop_bbdown_case.js')({directory,evidence:directory,getPage:()=>({on(){}}),
      api:async()=>({status:0}),okay:async()=>{if(unavailable)throw new Error('secret-connect-error');return {current_item:{id:'current',cookie:'secret-cookie'}};}}),error=>error.code==='ERR_ASSERTION');
    const receipt=JSON.parse(readFileSync(path.join(directory,'bbdown-failure-children.json'),'utf8'));
    assert.equal(receipt.total_children,1);assert.equal(receipt.children[0].artifact_set_id,'artifact-2');
  }
  rmSync(directory,{recursive:true,force:true});
  assert.match(lines.join('\n'),/BBDown failure diagnostics:.*artifact-2/);
  assert.doesNotMatch(lines.join('\n'),/secret/);
});

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
