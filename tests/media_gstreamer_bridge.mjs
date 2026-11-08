// Test-only renderer broker. All Next/history decisions go through real AppState.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,openSync,rmSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
import {root} from './desktop_construction_support.mjs';

export async function validateGstNativeNext(binary,environment,video,audio,directory) {
  mkdirSync(directory,{recursive:true});const home=path.join(directory,'host');mkdirSync(home);
  const host=await RunningHost.start(await buildNativeAlpha(),home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
  const headers={'X-Bilikara-Client':'round-a-native-renderer'},records=[];let renderer;
  const post=(url,body)=>host.api(url,body,headers);
  async function load(snapshot,index) {
    const program={...snapshot.playback_program,playback_generation:snapshot.playback_generation};
    const ownership={playback_generation:program.playback_generation,item_incarnation_id:program.item_incarnation_id,artifact_set_id:program.artifact_set_id};
    assert.equal((await post('/api/player/claim-program',ownership)).claimed,true);
    const item=snapshot.current_item,variant=item.audio_variants.find(v=>v.id===program.selected_audio_variant_id);
    const local=locator=>{const pathname=new URL(locator,'http://fixture.invalid').pathname;assert.ok(pathname.startsWith('/media/artifacts/'));assert.ok(!pathname.includes('..'));return path.join(home,pathname.slice(1));};
    const file=path.join(directory,`program-${index}.json`);
    writeFileSync(file,JSON.stringify({program,video:local(item.video_media_url),audio:[local(variant.audio_url)],pulse_server:environment.PULSE_SERVER,pulse_device:'rounda'}));
    const child=spawn(binary,[file],{env:environment,stdio:['pipe','pipe',openSync(path.join(directory,`program-${index}.stderr`),'wx')]});
    const events=[];let pending='';const started=performance.now();
    child.stdout.on('data',bytes=>{pending+=bytes;while(pending.includes('\n')){const split=pending.indexOf('\n');events.push({...JSON.parse(pending.slice(0,split)),receivedMs:performance.now()-started});pending=pending.slice(split+1);}});
    const finished=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
    const wait=async(predicate,description)=>{for(let n=0;n<500;n++){if(predicate())return;assert.equal(child.exitCode,null,'renderer exited during '+description);await delay(20);}assert.fail(description);};
    let sequence=0;
    const report=phase=>post('/api/player/status',{playback_generation:program.playback_generation,item_id:program.item_id,status_sequence:++sequence,
      observed_phase:phase,is_paused:phase!=='playing',current_time:phase==='ended'?90:events.filter(e=>e.type==='sample').at(-1).position_ns/1e9,duration:90});
    const command=(action,parameters={})=>child.stdin.write(JSON.stringify({action,seq:++sequence,expected_program:program,...parameters})+'\n');
    const stop=async()=>{command('stop');const result=await finished;assert.equal(result.code,0);await post('/api/player/retire-program',ownership);};
    const instance={child,events,wait,report,command,stop,program};renderer=instance;
    await wait(()=>events.some(e=>e.type==='sample'&&e.position_ns>5e8),'native renderer actual output');
    await report('ready-paused');await report('playing');
    records.push({program,events});return instance;
  }
  try {
    const original=await host.api('/api/state'),first=await load(original,1);
    first.command('seek',{seconds:88});await first.wait(()=>first.events.some(e=>e.type==='eos'),'first program drained EOS');
    const eosAt=performance.now();await first.report('ended');
    await post('/api/player/next',{playback_generation:first.program.playback_generation,expected_queue_version:null});
    const next=await host.api('/api/state');assert.notEqual(next.current_item.id,original.current_item.id);assert.equal(next.history.length,1);
    await first.stop();renderer=null;
    const second=await load(next,2);const eosToNextObservedMs=performance.now()-eosAt;
    const duplicate=await host.request('/api/player/next',{playback_generation:first.program.playback_generation,expected_queue_version:null},headers);
    assert.ok([200,409].includes(duplicate.status));
    const after=await host.api('/api/state');assert.equal(after.current_item.id,next.current_item.id);assert.equal(after.playback_generation,next.playback_generation);assert.equal(after.history.length,1);
    await second.stop();renderer=null;
    const result={status:'PASS',evidenceClass:'NATIVE-HOST-TEST-BRIDGE',records,eosToNextObservedMs,
      continuity:'NOT QUALIFIED: pipeline recreation has a gap; not uninterrupted automatic playback',duplicateEosStatus:duplicate.status};
    writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));return result;
  }finally{renderer?.child.kill('SIGTERM');await host.close();rmSync(home,{recursive:true,force:true});}
}
