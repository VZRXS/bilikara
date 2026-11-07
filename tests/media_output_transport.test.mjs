import assert from 'node:assert/strict';
import test from 'node:test';
import {outputTransportFixture} from './media_output_transport_support.mjs';
test('public Remote preserves shared output facts and sends only typed mode commands',async()=>{
  const adapter=outputTransportFixture();
  const {state,localState,fetchInternet,stub}=adapter;state.authorized=true;
  const output={schema_version:1,target:'purek',status:'streaming',can_manage:false,offset_mode:'splice',qualified:false,measured_adjust_latency_ms:null};
  const publicState={revision:1,player_settings:{},media_output:output};
  assert.equal(localState(publicState).media_output,output);
  const calls=[];stub(async(kind,body)=>{calls.push({kind,body});return {data:publicState};});
  const post=body=>fetchInternet('/api/player/output',{method:'POST',body:JSON.stringify(body)});
  for(const body of [{target:'purek',experimental:true},{target:'local'},{offset_mode:'gradual',target:'purek'},{offset_mode:'unsafe'}])assert.equal((await post(body)).status,403);
  assert.equal(calls.length,0);
  assert.equal((await post({offset_mode:'gradual'})).status,200);
  assert.equal(calls.length,1);assert.equal(calls[0].kind,'output.set_offset_mode');assert.equal(calls[0].body.offset_mode,'gradual');
});
