"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("static/app.js", "utf8");
const fragment = source.slice(source.indexOf("function maybeStartBBDownLogin("), source.indexOf("function syncToolIndicator("));

(async () => {
  let portrait = true, requests = 0, finish;
  const button = () => ({disabled:false, attrs:{}, setAttribute(k,v){this.attrs[k]=v;}, removeAttribute(k){delete this.attrs[k];}});
  const controls = [button(),button()];
  const state = {cacheSettingsOpen:true,bbdownLoginRequesting:false};
  const context = {state, elements:{bbdownLoginButton:controls[0],bbdownLoginRefresh:controls[1]},
    BilikaraAndroidHost:{isPortrait:()=>portrait},render(){},setAppMessage(){},
    apiPostStateSnapshot(){requests++;return new Promise(resolve=>{finish=resolve;});}};
  vm.createContext(context);
  vm.runInContext(fragment,context);
  context.maybeStartBBDownLogin({state:"idle"});
  assert.equal(requests,0,"Opening My should not automatically start login");
  const pending=context.startBBDownLogin({force:true});
  await context.startBBDownLogin({force:true});
  assert.equal(requests,1,"Repeated clicks cannot start duplicate login requests");
  assert.ok(controls.every(b=>b.disabled && b.attrs["aria-busy"]==="true"));
  finish(); await pending;
  assert.ok(controls.every(b=>!b.disabled && !("aria-busy" in b.attrs)));
  portrait=false;
  context.maybeStartBBDownLogin({state:"idle"});
  assert.equal(requests,2,"Desktop/landscape keeps its existing popover login behavior");
  finish();
  console.log("PASS explicit portrait login, duplicate guard and desktop behavior");
})().catch(error=>{console.error(error);process.exitCode=1;});
