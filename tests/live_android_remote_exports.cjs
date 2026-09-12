// Owned-emulator acceptance: real APK Rust/JNI/Kotlin + the shared browser Remote.
// Only rating/cloud search requests are stubbed. No online account or D1 writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {chromium} = require('playwright');
const dir = path.resolve(process.argv[2] || '.tmp/android-remote-parity/emulator');
const adb = 'C:/Users/kevin/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const app = 'com.bilikara.app.alpha';
const run = (...args) => execFileSync(adb, ['-s','emulator-5580',...args], {encoding:'utf8',windowsHide:true,timeout:30000});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const owned = () => assert.match(run('emu','avd','name'), /^codex_bilikara_publish\b/);
async function attachNative() {
  let target;
  for(let i=0;i<80;i++) {
    try {target=(await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json())).find(t=>t.type==='page');if(target)break;}catch{}
    await sleep(250);
  }
  assert.ok(target,'APK WebView');
  const socket=new WebSocket(target.webSocketDebuggerUrl), pending=new Map();let sequence=0;
  socket.onmessage=e=>{const message=JSON.parse(e.data),p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(message.error):p.resolve(message.result);}};
  await once(socket,'open');
  const evaluate=async fn=>{
    const expression=typeof fn==='function'?`(${fn.toString()})()`:fn;
    const result=await new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>reject(Error('WebView evaluation timed out')),15000);
      pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
      socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,userGesture:true}}));
    });
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitForFunction=async fn=>{for(let i=0;i<80;i++){if(await evaluate(fn).catch(()=>false))return;await sleep(250);}throw Error('Native Host not ready');};
  return {evaluate,waitForFunction,close:()=>socket.close()};
}
const installState = value => {
  const file = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(file, JSON.stringify(value));
  run('push', file, '/data/local/tmp/bilikara-remote-export-checkpoint.json');
  run('shell','run-as',app,'cp','/data/local/tmp/bilikara-remote-export-checkpoint.json','host-state.json');
};
(async()=>{
  owned(); fs.mkdirSync(dir,{recursive:true});
  run('shell','am','force-stop',app);
  assert.ok(!JSON.parse(run('shell','run-as',app,'cat','bilibili-login.json')).cookie, 'Offline profile only');
  const original = JSON.parse(run('shell','run-as',app,'cat','host-state.json'));
  const seed = JSON.parse(JSON.stringify(original));
  const url = 'https://www.bilibili.com/video/BV1z84y1p7oS';
  const rows = Array.from({length:51},(_,n)=>({key:'export-'+n,item_id:'export-'+n,
    title:n===0?'=SUM(1,2)\n"日本語"':`导出样本 ${n}`,display_title:n===0?'=SUM(1,2)\n"日本語"':`导出样本 ${n}`,
    part_title:'P1',original_url:url,resolved_url:url,bvid:'BV1z84y1p7oS',aid:1,cid:2,page:1,
    played_at:1780000000+n,owner_mid:123,owner_name:'Fixture UP',requester_name:'@Fixture',threshold_reached:false}));
  seed.state = {...seed.state,current_item:null,current_item_started:false,playlist:[],backup:null,previous_session:null,
    session_users:['@Fixture'],session_played:rows.slice(0,2),session_history:[],
    history:rows.map(({key,title,display_title,part_title,original_url,resolved_url,requester_name,owner_name,owner_mid,played_at})=>
      ({key,title,display_title,part_title,original_url,resolved_url,requester_name,owner_name,owner_mid,requested_at:played_at,request_count:3}))};
  let nativeBrowser, browser, forwardPort;
  try {
    installState(seed);
    run('shell','svc','wifi','disable'); run('shell','svc','data','disable');
    run('shell','am','start','-n',app+'/com.bilikara.app.MainActivity');
    let pid;
    for(let i=0;i<60;i++){try{pid=run('shell','pidof',app).trim();if(pid)break;}catch{} await sleep(250);}
    assert.ok(pid);
    run('forward','tcp:9229','localabstract:webview_devtools_remote_'+pid);
    nativeBrowser=await attachNative();
    const host = nativeBrowser;
    await host.waitForFunction(()=>typeof state!=='undefined' && state.data?.capabilities?.playlist_export);
    await host.waitForFunction(()=>Boolean(window.BilikaraAndroidHost));
    if(await host.evaluate(()=>state.data.session_flags?.startup_choice_pending)) {
      await host.evaluate(()=>document.querySelector('[data-session-choice="continue"]').click());
      await host.waitForFunction(()=>!state.data.session_flags.startup_choice_pending);
    }
    assert.equal(await host.evaluate(()=>state.data.history.length),51);
    const access = await host.evaluate(()=>({origin:location.origin,invite:state.data.remote_access.local_url}));
    forwardPort = new URL(access.origin).port;
    run('forward','tcp:'+forwardPort,'tcp:'+forwardPort);
    browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const context = await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
    const ratingPayloads=[];
    await context.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.hostname!=='127.0.0.1')return route.abort();
      if(u.pathname==='/api/rating/submit'){
        ratingPayloads.push(route.request().postDataJSON());
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data:{success:true}})});
      }
      if(/^\/api\/(lark|d1)\//.test(u.pathname))return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"data":{"items":[]}}'});
      return route.continue();
    });
    const remote = await context.newPage();
    await remote.goto(access.invite);
    await remote.waitForURL('**/remote');
    await remote.locator('#remote-identity-input').fill('Export tester');
    await remote.locator('#remote-identity-submit').click();
    await remote.waitForFunction(()=>state.remoteIdentity.registered);
    for(const name of ['remote.html','remote.js','remote.css']) {
      const content = await remote.evaluate(name=>fetch('/'+name).then(r=>r.text()),name);
      const local=fs.readFileSync('static/'+name,'utf8');
      if(name!=='remote.html')assert.equal(content.replace(/\r\n/g,'\n'),local.replace(/\r\n/g,'\n'));
      else assert.ok(content.includes('data-native-host="true"'));
    }
    assert.ok(await remote.locator('[data-remote-request-view="search"]').isVisible());
    assert.equal(await remote.evaluate(()=>typeof BilikaraHostExport),'undefined', 'No native Host export bridge on Remote');
    await remote.locator('#history-view-button').click();
    assert.ok(await remote.locator('#history-export-row').isVisible());
    const results=[];
    for(const [format,source,pageSize,extension] of [['csv','history','50','csv'],['image','played','50','png'],['image','history','50','zip']]){
      await remote.locator('#history-export-source').selectOption(source);
      await remote.locator('#history-export-page-size').selectOption(pageSize);
      const downloadPromise=remote.waitForEvent('download',{timeout:60000});
      await remote.locator('#history-export-'+(format==='csv'?'csv':'image')+'-button').click();
      const download=await downloadPromise;
      assert.ok(download.suggestedFilename().endsWith('.'+extension));
      const destination=path.join(dir,'remote-'+source+'.'+extension);
      await download.saveAs(destination);
      const bytes=fs.readFileSync(destination);
      if(extension==='csv'){
        assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
        assert.ok(bytes.toString('utf8').includes('"\'=SUM(1,2)\n""日本語"""'));
        assert.ok(bytes.toString('utf8').includes('导出样本 50'));
        assert.ok(bytes.toString('utf8').includes('"\'@Fixture"'));
      }else if(extension==='png'){
        assert.equal(bytes.readUInt32BE(16),720); assert.ok(bytes.readUInt32BE(20)>180);
      }else{
        const info=JSON.parse(execFileSync('python',['-c',
          'import zipfile,json,sys,struct; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([[n,*struct.unpack(">II",z.read(n)[16:24])] for n in z.namelist()]))', destination],{encoding:'utf8',windowsHide:true}));
        assert.deepEqual(info.map(i=>i[0]),['bilikara-page-1.png','bilikara-page-2.png']);
        assert.deepEqual(info.map(i=>i[1]),[720,720]);
      }
      await remote.waitForFunction(()=>!document.getElementById('history-export-csv-button').disabled && !document.getElementById('history-export-image-button').disabled);
      results.push({format,source,extension,bytes:bytes.length});
    }
    assert.equal(run('shell','run-as',app,'ls','remote-exports').trim(),'');
    await remote.screenshot({path:path.join(dir,'remote-export-ui.png')});
    // Rate via the real shared modal, intercept only the final cloud-bound POST.
    await remote.evaluate(()=>{
      state.eventSource?.close(); state.eventSource=null;
      const item={...state.data.session_played[0],id:state.data.session_played[0].item_id};
      applyStateSnapshot({...state.data,current_item:item},{forceRender:true});
    });
    await remote.locator('#playback-dock').click();
    await remote.locator('#open-rating-button').click();
    await remote.locator('[data-rating-score="4"]').click();
    await remote.locator('.rating-actions [data-rating-close]').click();
    await remote.waitForFunction(()=>state.ratingSubmittedKeys.size===1);
    await sleep(100);
    assert.equal(ratingPayloads.length,1); assert.equal(ratingPayloads[0].score,4);
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({passed:true,results,ratingUi:true},null,2));
    console.log(JSON.stringify({passed:true,results,ratingUi:true}));
  } finally {
    if(browser)await browser.close(); if(nativeBrowser)await nativeBrowser.close();
    owned(); run('shell','am','force-stop',app); installState(original);
    run('shell','rm','/data/local/tmp/bilikara-remote-export-checkpoint.json');
    run('forward','--remove','tcp:9229'); if(forwardPort)run('forward','--remove','tcp:'+forwardPort);
    run('shell','svc','wifi','enable'); run('shell','svc','data','enable');
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
