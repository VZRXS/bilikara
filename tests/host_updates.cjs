"use strict";
const assert=require("node:assert/strict");
const {create}=require("../static/host-updates.js");
(async()=>{
 const requests=[],calls=[];
 let fail=false;
 const request=async(path,body)=>{
  requests.push({path,body});
  if(path.endsWith("/install"))return {operation:7,android_package:{sha256:"fixture"}};
  return {state:body.result==="failed"?"failed":"idle",message:body.result};
 };
 const android=create({platform:"android",request,android:{
  environment:async()=>({platform:"android",signature_status:"debug"}),
  installUpdate:async candidate=>{calls.push(candidate);if(fail)throw Error("native denial");return {result:"awaiting_user"};},
 }});
 assert.equal(android.manualRelease,false);assert.equal(android.applyPrepared,undefined);
 assert.equal((await android.environment()).platform,"android");
 assert.equal((await android.install(false)).message,"awaiting_user");
 assert.deepEqual(requests.map(r=>r.path),["/api/app/update/install","/api/app/update/finish"]);
 assert.deepEqual(requests[1].body,{operation:7,result:"awaiting_user"});
 fail=true;await assert.rejects(android.install(true),/native denial/);
 assert.deepEqual(requests.at(-1).body,{operation:7,result:"failed"});
 const desktopCalls=[];
 const desktop=create({platform:"desktop",request:()=>{throw Error("Desktop cannot use the APK route");},desktop:{
  startUpdate:async flag=>desktopCalls.push(["start",flag]),cancelUpdate:async()=>desktopCalls.push(["cancel"]),applyUpdate:async status=>desktopCalls.push(["apply",status.operation]),
 }});
 assert.equal(desktop.manualRelease,true);assert.equal(await desktop.environment(),undefined);
 await desktop.install(true);await desktop.cancel();await desktop.applyPrepared({state:"prepared",operation:9});
 assert.deepEqual(desktopCalls,[["start",true],["cancel"],["apply",9]]);
 const unavailable=create({platform:"android",request,android:null});
 await assert.rejects(unavailable.install(false),/adapter unavailable/);
 assert.equal(create({platform:"untrusted"}),null);
 console.log("PASS shared update actions retain separate desktop activation and Android consent/settlement");
})().catch(error=>{console.error(error);process.exitCode=1;});
