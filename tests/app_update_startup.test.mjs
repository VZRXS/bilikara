import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('async function hydrateNativeUpdatePreferences'),source.indexOf('function normalizeRequestSubview'))
  +source.slice(source.indexOf('async function requestAppUpdateCheck'),source.indexOf('async function installAppUpdate'));
function open(preferences, response=async()=>({})) {
  const posts=[],messages=[],stored=new Map();
  const scope={state:{updateAutomaticEnabled:true,updatePreviewEnabled:false,updateAutomaticAttemptedChannels:new Set(),startupUpdateCheckScheduled:false,
    updateCheckRequestInFlight:false,updatePreferenceSaveInFlight:false,hasValidStateResponse:true,data:{app_update:{state:'idle'}}},
    storageKeys:{updateAutomatic:'automatic',updatePreview:'preview'},
    BilikaraHostUpdates:preferences?{preferences,environment:async()=>undefined}:undefined,
    writeLocalPreference:(key,value)=>stored.set(key,value),
    renderUpdatePreviewControl:()=>{},appUpdateStatus:()=>scope.state.data.app_update,
    isAppUpdateBusy:()=>['checking','downloading','installing','prepared','restarting'].includes(scope.state.data.app_update.state),
    apiPost:async(path,body)=>{posts.push({path,body});return response();},
    setAppMessage:(...args)=>messages.push(args),t:key=>key,appUpdateCheckTimeoutMs:10000};
  runInNewContext(functions,scope);
  return {...scope,posts,messages,stored};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('native update bridge loads before startup and grants preferences only to the main Host',()=>{
  const html=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('src="/desktop-platform.js"')<html.indexOf('src="/host-updates.js"'));
  assert.ok(html.indexOf('src="/host-updates.js"')<html.indexOf('src="/app.js"'));
  const main=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/main.json',import.meta.url),'utf8'));
  const audience=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/controller.json',import.meta.url),'utf8'));
  for(const command of ['get','set']){
    const permission=`allow-${command}-host-update-preferences`;
    assert.ok(main.permissions.includes(permission));assert.ok(!audience.permissions.includes(permission));
  }
});

test('fresh native launch migrates defaults once; each launch checks only after preferences load',async()=>{
  let saved=null,loads=0,saves=0;
  const disk={load:async()=>{loads++;return saved;},save:async prefs=>{saves++;saved=structuredClone(prefs);}};
  for(let launch=0;launch<3;launch++){
    const app=open(disk);await app.hydrateNativeUpdatePreferences();
    app.scheduleStartupAppUpdateCheck();await settle();app.scheduleStartupAppUpdateCheck();await settle();
    assert.equal(app.posts.length,1);assert.equal(app.posts[0].body.include_preview,false);
  }
  assert.equal(loads,3);assert.equal(saves,1);assert.deepEqual(saved,{automatic:true,preview:false});
});
test('disabled automatic choice and enabled preview survive new launch contexts',async()=>{
  const disk={load:async()=>({automatic:false,preview:true})};
  for(let launch=0;launch<3;launch++){
    const app=open(disk);await app.hydrateNativeUpdatePreferences();app.scheduleStartupAppUpdateCheck();await settle();
    assert.equal(app.posts.length,0);assert.equal(app.state.updatePreviewEnabled,true);
  }
  const app=open({load:async()=>({automatic:true,preview:true})});await app.hydrateNativeUpdatePreferences();app.scheduleStartupAppUpdateCheck();await settle();
  assert.equal(app.posts.length,1);assert.equal(app.posts[0].body.include_preview,true);
});
for(const busy of ['checking','downloading','installing','prepared','restarting']){
  test(`startup during ${busy} waits, then checks selected channel exactly once`,async()=>{
    const app=open();app.state.updatePreviewEnabled=true;app.state.data.app_update.state=busy;
    assert.equal(app.scheduleStartupAppUpdateCheck(),false);await app.requestAppUpdateCheck({automatic:true});
    assert.equal(app.state.startupUpdateCheckScheduled,false);assert.equal(app.state.updateAutomaticAttemptedChannels.size,0);assert.equal(app.posts.length,0);
    app.state.data.app_update.state='idle';app.scheduleStartupAppUpdateCheck();await settle();app.scheduleStartupAppUpdateCheck();await settle();
    assert.equal(app.posts.length,1);assert.equal(app.posts[0].body.include_preview,true);
  });
}
test('server update_busy race leaves one pending check, other failures do not retry',async()=>{
  for(const code of ['update_busy','network_failure']){
    let fail=true;
    const app=open(undefined,async()=>{if(fail)throw Object.assign(new Error('fixture'),{code});});
    app.scheduleStartupAppUpdateCheck();await settle();fail=false;app.scheduleStartupAppUpdateCheck();await settle();app.scheduleStartupAppUpdateCheck();await settle();
    assert.equal(app.posts.length,code==='update_busy'?2:1);assert.equal(app.messages.length,0);
  }
});
test('no accepted startup state or unsupported updater does not consume the check',async()=>{
  const app=open();app.state.hasValidStateResponse=false;app.scheduleStartupAppUpdateCheck();await settle();assert.equal(app.posts.length,0);
  app.state.hasValidStateResponse=true;app.state.data.capabilities={app_update:false};app.scheduleStartupAppUpdateCheck();await settle();assert.equal(app.posts.length,0);
  app.state.data.capabilities.app_update=true;app.scheduleStartupAppUpdateCheck();await settle();assert.equal(app.posts.length,1);
});
test('saving waits for hydration, guards duplicates and commits both choices before restarting',async()=>{
  let release,saved={automatic:false,preview:true};
  const app=open({load:async()=>saved,save:async prefs=>{saved=structuredClone(prefs);}});
  app.state.updatePreferencesHydration=new Promise(resolve=>{release=resolve;});
  const attributes=new Map();const control={checked:true,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  const pending=app.saveUpdatePreference(control,'automatic');assert.equal(attributes.get('aria-busy'),'true');assert.equal(app.state.updatePreferenceSaveInFlight,true);
  assert.equal(await app.saveUpdatePreference(control,'preview'),false);
  await app.hydrateNativeUpdatePreferences();release();assert.equal(await pending,true);
  assert.deepEqual(saved,{automatic:true,preview:true});assert.equal(attributes.size,0);
  const restarted=open({load:async()=>saved});await restarted.hydrateNativeUpdatePreferences();restarted.scheduleStartupAppUpdateCheck();await settle();assert.equal(restarted.posts[0].body.include_preview,true);
});
test('malformed native preferences are rejected without overwriting storage; failed saves pause checks',async()=>{
  for(const invalid of [undefined,{},'false',{automatic:'false',preview:true},{automatic:true,preview:false,url:'untrusted'}]){
    let saves=0;const app=open({load:async()=>invalid,save:async()=>{saves++;}});
    await assert.rejects(app.hydrateNativeUpdatePreferences());assert.equal(saves,0);
  }
  const app=open({save:async()=>{throw Error('disk unavailable');}});
  const control={checked:true,setAttribute:()=>{},removeAttribute:()=>{}};
  assert.equal(await app.saveUpdatePreference(control,'preview'),false);assert.equal(app.state.updateAutomaticEnabled,false);assert.equal(app.messages.length,1);
});
