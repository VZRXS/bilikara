import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture,transfer} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';
const cases=[
  {name:'ordinary',sink:'http-get:*:video/MP2T:*'},
  // T2 accepts the deployed namespace-free envelope, with an explicit empty Sink.
  {name:'legacy-namespace',vendor:true,query:'legacy',state:'empty'},
  {name:'missing-action',vendor:true,query:'fault',state:'unavailable'},
  {name:'http-error',query:'http',state:'unavailable'},
  {name:'empty',vendor:true,sink:'',state:'empty'},
  {name:'wildcard',sink:'http-get:*:video/*:*'},
  {name:'av-only',avOnly:true,state:'unavailable'},
  {name:'iso-mpeg',sink:'http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5_ISO'},
  {name:'audio-only',sink:'http-get:*:audio/aac:*',advisory:[{mime:'audio/aac',profile:null}]},
  {name:'rtsp-only',sink:'rtsp-rtp-udp:*:video/MP2T:*',advisory:[]},
  {name:'mp4-only',sink:'http-get:*:video/mp4:*',advisory:[{mime:'video/mp4',profile:null}]},
  {name:'ac3-only',sink:'http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3',advisory:[{mime:'video/mp2t',profile:'AVC_TS_HD_50_AC3'}]},
  {name:'ps-only',sink:'http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL',advisory:[{mime:'video/mpeg',profile:'MPEG_PS_PAL'}]},
  {name:'tts-192',sink:'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5',advisory:[{mime:'video/vnd.dlna.mpeg-tts',profile:'AVC_TS_MP_HD_AAC_MULT5'}]},
  {name:'reject-uri',vendor:true,query:'fault',rejectUri:true,state:'unavailable'},
];
const report={qualified:false,played:[],advisory:[],query_failure_preserved:true,no_premature_streaming:true,rejected_uri_recovered:false};
for(const c of cases){
  const f=await fixture({...c,pull:false});
  try{
    await f.client.api('/api/player/restart-program',{});await f.connect();
    if(c.rejectUri){
      const s=await waitFor(async()=>{const s=await f.state();return s.cast.phase==='idle'&&s.cast.error_code&&s;},'SetURI rejection cleanup');
      assert.equal(s.media_output.target,'local');assert.equal(s.media_output.qualified,false);assert.ok(!f.actions.includes('Play'));
      assert.ok(f.releases>0);report.rejected_uri_recovered=true;
    }else{
      await waitFor(()=>f.actions.includes('Play'),'advisory query reaches real Play');
      let s=await f.state();assert.equal(s.media_output.status,'starting','SOAP success alone is not delivery');
      const caps=s.purek.output.capabilities;
      assert.equal(caps.protocol_info_state,c.state??'reported',c.name);
      if(c.state==='unavailable')assert.ok(caps.protocol_info_error);
      else assert.equal(caps.protocol_info_error,null);
      if(c.state)assert.deepEqual(caps.sink_formats,[]);
      if(c.advisory){assert.deepEqual(caps.sink_formats,c.advisory);report.advisory.push(c.name);}
      for(const [key,value] of Object.entries(caps))if(key.startsWith('supports_'))assert.equal(value,false);
      const body=await transfer(f.uri);assert.equal(body.status,200);inspectTs(body.bytes,{profile:'cast-file'});
      s=await f.status('streaming');assert.equal(s.media_output.qualified,false);assert.equal(s.current_item.id,'purek-fixture-0');report.played.push(c.name);
      await f.client.api('/api/player/output',{target:'local'});s=await f.status('authorized');assert.equal(s.cast.connected,true);assert.equal(f.releases,0);
    }
    await f.disconnect();assert.equal(f.releases>0,Boolean(c.vendor));
  }finally{await f.close();}
}
writeFileSync(process.env.BILIKARA_TEST_PUREK_REPORT,JSON.stringify(report)+'\n');
process.stdout.write('purek-node-receiver-ok\n');
