"use strict";
const assert=require("node:assert/strict");
const {resolveLayout,createClient}=require("../static/android-layout.js");

function fixture() {
  const requests=[],timers=new Map();let sequence=0;
  const bridge={postMessage:raw=>requests.push(JSON.parse(raw))};
  const client=createClient(bridge,{
    setTimeout(fn,ms){assert.equal(ms,10000);timers.set(++sequence,fn);return sequence;},
    clearTimeout:id=>timers.delete(id),
  });
  const reply=(index,data={layout:"auto",orientation:"system"},ok=true)=>bridge.onmessage({data:JSON.stringify({id:requests[index].id,ok,data})});
  return {client,requests,bridge,timers,reply};
}
(async()=>{
  for(const [width,expected] of [[320,"phone"],[600,"phone"],[699,"phone"],[700,"desktop"],[800,"desktop"],[1280,"desktop"],[undefined,"phone"]]) {
    assert.equal(resolveLayout("auto",width),expected);
    assert.equal(resolveLayout("phone",width),"phone");
    assert.equal(resolveLayout("desktop",width),"desktop");
  }
  const f=fixture();
  const read=f.client.load();
  assert.equal(f.requests[0].action,"get-preferences");
  for(const data of ["entered","exited","null","true","{}",'{"id":"unknown"}']) f.bridge.onmessage({data});
  assert.equal(f.timers.size,1,"Fullscreen/non-reply messages cannot consume pending preference requests");
  f.reply(0);assert.deepEqual(await read,{layout:"auto",orientation:"system"});
  assert.equal(f.timers.size,0);
  const write=f.client.saveLayout("desktop");
  assert.equal(f.requests[1].action,"set-layout");assert.equal(f.requests[1].mode,"desktop");
  f.reply(1,{layout:"desktop",orientation:"system"});await write;
  const rotate=f.client.saveOrientation("portrait");
  assert.equal(f.requests[2].action,"set-orientation");f.reply(2,{layout:"desktop",orientation:"portrait"});await rotate;
  await assert.rejects(f.client.saveLayout("tablet"),/invalid_layout/);
  await assert.rejects(f.client.saveOrientation("upside-down"),/invalid_orientation/);
  assert.equal(f.requests.length,3,"Invalid values never cross the native boundary");
  const invalid=f.client.load();f.reply(3,{layout:"arbitrary",orientation:"system"});await assert.rejects(invalid,/window_preferences_failed/);
  const denied=f.client.load();f.reply(4,{},false);await assert.rejects(denied,/window_preferences_failed/);
  const timeout=f.client.load();f.timers.values().next().value();await assert.rejects(timeout,/window_preferences_timeout/);
  f.reply(5); // Late response must be ignored.
  f.timers.clear();
  const requests=Array.from({length:4},()=>f.client.load());
  await assert.rejects(f.client.load(),/window_preferences_busy/);
  f.client.close();
  await Promise.all(requests.map(p=>assert.rejects(p,/window_closed/)));
  assert.equal(f.timers.size,0);
  await assert.rejects(f.client.load(),/window_closed/);
  const broken=fixture();broken.bridge.postMessage=()=>{throw Error("bridge gone");};
  await assert.rejects(broken.client.load(),/bridge gone/);assert.equal(broken.timers.size,0);
  console.log("PASS adaptive layout breakpoints and bounded native preference client");
})().catch(error=>{console.error(error);process.exitCode=1;});
