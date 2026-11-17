// P6: delivery proves bytes, GetTransportInfo/position determine completion.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';
const eof=process.env.BILIKARA_TEST_PUREK_EOF==='1';
const f=await fixture({vendor:process.env.BILIKARA_TEST_PUREK_DLNA!=='1'});
try{
  await f.connect();await f.status('streaming');await waitFor(()=>f.media.length===1,'complete real body');
  const first=(await f.state()).current_item.id;
  if(eof){
    await delay(2500);assert.equal((await f.state()).current_item.id,first,'sender EOF with PLAYING cannot advance');
    f.position=119;await waitFor(async()=>(await f.state()).cast.position===119,'near-end observation');f.transport='STOPPED';
    let s=await waitFor(async()=>{const s=await f.state();return s.current_item?.id==='purek-fixture-1'&&s.cast.phase==='active'&&!s.cast.busy&&s;},'receiver-confirmed finish');
    const second=s.playback_generation;await delay(2500);s=await f.state();assert.equal(s.current_item.id,'purek-fixture-1');assert.equal(s.playback_generation,second);
    await f.remote.api('/api/player/next',{playback_generation:second});
    await waitFor(async()=>(await f.state()).cast.phase==='idle','uncached next explicit failure');await delay(1500);
    s=await f.state();assert.equal(s.current_item.id,'purek-fixture-2');assert.equal(s.cast.error_code,'cast_media_unavailable');
  }else{
    f.position=10;await waitFor(async()=>(await f.state()).cast.position===10,'mid-song position');
    f.transport='STOPPED';await delay(2400);assert.equal((await f.state()).current_item.id,first,'mid-song Stop is not EOF');
    f.transport='PLAYING';await f.status('streaming');
    f.unsupported=true;await delay(4500);assert.equal((await f.state()).cast.connected,true,'UPnP 401 disables monitoring without a network failure');
    await f.disconnect();f.unsupported=false;await f.connect();await f.status('streaming');
    const began=Date.now();f.refuse=true;
    await delay(4000);assert.equal((await f.state()).cast.connected,true,'fast failures do not shorten the silence window');
    const s=await waitFor(async()=>{const s=await f.state();return !s.cast.connected&&s.cast.phase==='idle'&&s;},'8 second silence plus bounded recovery',14000);
    assert.ok(Date.now()-began>=7500);assert.ok(Date.now()-began<16500);
    assert.equal(s.current_item.id,first);assert.equal(s.media_output.target,'local');assert.equal(s.cast.error_code,'cast_receiver_unreachable');
  }
  assert.ok(f.actions.includes('GetTransportInfo'));assert.ok(f.media[0].bytes.length>0);
  process.stdout.write('purek-node-receiver-ok\n');
}finally{f.refuse=false;await f.close();}
