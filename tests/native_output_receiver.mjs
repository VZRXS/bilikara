// The retained standalone L1 path: real Host edits and real HLS/TS bytes,
// independent of a receiver, room authorization, or the deferred P8 adapter.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {HttpClient,waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';
const bootstrap=process.env.BILIKARA_TEST_PUREK_BOOTSTRAP;
const client=new HttpClient(new URL(bootstrap).origin);await client.request(bootstrap);
const initial=await client.api('/api/state');
const offset=value=>client.api('/api/player/av-delay-action',{type:'set_effective',effective_delay_ms:value});
await offset(150);await client.api('/api/player/key-shift',{key_shift:-2});await client.api('/api/player/volume',{volume_percent:80});
await client.api('/api/player/output',{target:'native',experimental:true});
const preview=await waitFor(async()=>{const r=await client.request('/api/player/output-preview');return r.status===200&&JSON.parse(r.body).data;},'preview publication');
const segments=new Map();let captureError;
const capture=(async()=>{
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    const manifest=await client.request(preview.url);assert.equal(manifest.status,200);
    const text=manifest.body.toString();
    for(const url of text.split('\n').filter(s=>s&&!s.startsWith('#'))){
      const sequence=Number(url.replace('.ts',''));assert.ok(Number.isSafeInteger(sequence));
      if(segments.has(sequence))continue;
      const response=await client.request(new URL(url,new URL(preview.url,client.base)).href);
      assert.equal(response.status,200);segments.set(sequence,response.body);
    }
    if(text.includes('#EXT-X-ENDLIST'))return;
    await delay(40);
  }
  assert.fail('complete standalone HLS capture');
})().catch(error=>{captureError=error;});
const first=await waitFor(async()=>{const s=await client.api('/api/state');return s.media_output.status==='streaming'&&s;},'standalone L1 output');
assert.equal(first.media_output.pipeline_level,'L1');assert.equal(first.media_output.authorized,false);
const change=async action=>{await action();await delay(120);};
await change(()=>offset(0));await change(()=>offset(-150));
await change(()=>client.api('/api/player/output',{offset_mode:'gradual'}));await change(()=>offset(150));await change(()=>offset(0));
await change(()=>client.api('/api/player/audio-variant',{item_id:initial.current_item.id,expected_item_incarnation_id:initial.current_item.item_incarnation_id,variant_id:'instrumental'}));
await change(()=>client.api('/api/player/key-shift',{key_shift:2}));await change(()=>client.api('/api/player/volume',{volume_percent:35,is_muted:true}));
await change(()=>client.api('/api/player/volume',{is_muted:false}));await change(()=>client.api('/api/player/output',{offset_mode:'splice'}));
const current=await client.api('/api/state');assert.equal(current.media_output.stream_generation,first.media_output.stream_generation);
assert.equal(current.media_output.offset_mode,'splice');assert.equal(current.current_item.selected_audio_variant_id,'instrumental');
assert.equal(current.playback_generation,initial.playback_generation+1);

await waitFor(async()=>(await client.api('/api/state')).media_output.producer_eof,'real producer EOF',12000);
await capture;if(captureError)throw captureError;
const sequence=[...segments.keys()].sort((a,b)=>a-b);assert.ok(sequence.length>0);
assert.deepEqual(sequence,Array.from({length:sequence.length},(_,i)=>i),'capture every segment from zero, without holes');
inspectTs(Buffer.concat(sequence.map(i=>segments.get(i))),{videoFrames:144,channels:2,sampleRate:48000});
await client.api('/api/player/output',{target:'local'});
await waitFor(async()=>(await client.api('/api/state')).media_output.target==='local','standalone return');
assert.equal((await client.request(preview.url)).status,410,'retired preview capability is unavailable');
process.stdout.write('purek-node-receiver-ok\n');
