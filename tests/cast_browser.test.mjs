// R1 T6 scenarios remounted in next's Manage dialog (decision 1).
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {openManage,idle,dictionary,appSection,read} from './cast_browser_support.mjs';

test('native presentation snapshots keep one renderer owner and reject mismatched or stale counters',()=>{
  const normalize=vm.runInNewContext(appSection('const presentationModes =','function presentationPhaseRank(')+'normalizePresentationSession');
  const candidate={mode:'singleScreen',phase:'inactive',generation:1,playbackAuthority:'host',mediaRendererOwner:'host'};
  for(const [mode,owner]of [['singleScreen','host'],['localDualScreen','host'],['networkRenderer','networkRenderer']]){
    assert.equal(normalize({...candidate,mode,mediaRendererOwner:owner}).mediaRendererOwner,owner);
    assert.equal(normalize({...candidate,mode,mediaRendererOwner:owner==='host'?'networkRenderer':'host'}),null);
  }
  for(const patch of [{playbackAuthority:'controller'},{generation:-1},{generation:2**53},{lastAcceptedCommandSequence:1,lastAppliedCommandSequence:2}])assert.equal(normalize({...candidate,...patch}),null);
});

test('Manage rows retain identity, preference conflicts retry once, and pending actions reject duplicates',async t=>{
  const page=await openManage(t),mode=page.locator('[data-cast-device="one"] [data-cast-mode="live"]');
  await mode.click();assert.equal(await mode.isDisabled(),true);assert.equal(await mode.getAttribute('aria-busy'),'true');
  await mode.dispatchEvent('click');assert.equal(await page.evaluate(()=>fixture.calls.length),1);
  assert.deepEqual(await page.evaluate(()=>fixture.calls[0].payload),{command:'cast.set_device_mode',device_key:'one',mode:'live',revision:5});
  await page.evaluate(()=>{window.row=document.querySelector('[data-cast-device="one"]');fixture.reject('cast_revision_conflict');});
  await page.waitForFunction(()=>fixture.calls.length===2);
  assert.equal(await page.evaluate(()=>fixture.calls[1].payload.revision),6);
  await page.evaluate(()=>fixture.reject('cast_revision_conflict'));await idle(page,'[data-cast-mode="live"]');
  assert.equal(await page.evaluate(()=>fixture.refreshes()),2);
  assert.equal(await page.locator('#purek-error').innerText(),dictionary.zh['cast.error.cast_revision_conflict']);
  await page.evaluate(()=>fixture.update({cast:{position:12,renderers:[{device_key:'one',label:'Renamed'},{device_key:'three',label:'New'}]}}));
  assert.equal(await page.evaluate(()=>window.row===document.querySelector('[data-cast-device="one"]')),true);
  assert.equal(await page.locator('[data-cast-device="two"]').count(),0);
  assert.equal(await page.locator('[data-cast-compatibility-test]:visible').count(),0,'P10 backend capability is required');
  await page.locator('#purek-close').click();await page.locator('#purek-open').click();
  assert.equal(await page.locator('#purek-error').isVisible(),false);
});

test('Manage mode retry rechecks receiver existence and preserves a successful preference',async t=>{
  const page=await openManage(t),mode=page.locator('[data-cast-device="one"] [data-cast-mode="live"]');
  await mode.click();await page.evaluate(()=>fixture.reject('cast_revision_conflict'));await page.waitForFunction(()=>fixture.calls.length===2);
  await page.evaluate(()=>fixture.resolve({...state.data,cast:{...state.data.cast,devices:{one:{mode:'live'}}}}));await idle(page,'[data-cast-mode="live"]');
  assert.equal(await mode.getAttribute('aria-pressed'),'true');assert.equal(await mode.getAttribute('aria-selected'),null);
  await page.locator('[data-cast-device="one"] [data-cast-mode="file"]').click();
  await page.evaluate(()=>{state.data.cast.renderers=[];fixture.reject('cast_revision_conflict');});
  await page.waitForFunction(()=>!document.getElementById('purek-error').hidden);
  assert.equal(await page.evaluate(()=>fixture.calls.length),3);
  assert.equal(await page.locator('#purek-error').innerText(),dictionary.zh['cast.error.cast_device_preferences_unavailable']);
});

test('discovery waits beyond 45 seconds for the authoritative terminal phase and cancellation cleanup',async t=>{
  const page=await openManage(t);await page.clock.install();await page.locator('#cast-discover').click();
  await page.evaluate(()=>{fixture.update({cast:{phase:'discovering',busy:true,operation_id:1}});fixture.resolve({accepted:true,operation_id:1});});
  await page.clock.fastForward(90000);
  assert.equal(await page.locator('#cast-discover').getAttribute('aria-busy'),'true');
  await page.locator('#cast-cancel-operation').click();
  await page.evaluate(()=>{fixture.update({cast:{phase:'recovering',busy:true,operation_id:2}});fixture.resolve({accepted:true,operation_id:2});});
  assert.equal(await page.locator('#cast-cancel-operation').getAttribute('aria-busy'),'true');
  await page.evaluate(()=>fixture.update({cast:{phase:'idle',busy:false}}));
  await idle(page,'#cast-discover');await idle(page,'#cast-cancel-operation');
  assert.equal(await page.locator('#cast-discover').isEnabled(),true);
});

test('manual acquisition uses next prepare and preserves QR variants and the draft through snapshots',async t=>{
  const page=await openManage(t);await page.locator('#purek-dlna-entry summary').click();
  for(const raw of ['https://WX.CHUNK.CN:8443/Projection/Login/?projection_url=fixture#room','http://wx.chunk.cn/projection/login?projection_url=a+b','http://192.168.1.2:8080/description.xml']){
    await page.locator('#purek-dlna-url').fill(raw);await page.locator('#purek-address-confirmed').check();
    await page.locator('#purek-dlna-connect').click();
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),{path:'/api/purek/prepare',payload:{url:raw}});
    await page.evaluate(()=>fixture.update({cast:{position:99}}));assert.equal(await page.locator('#purek-dlna-url').inputValue(),raw);
    await page.evaluate(()=>fixture.reject('purek_qr_invalid'));await idle(page,'#purek-dlna-connect');
    assert.match(await page.locator('#purek-error').innerText(),/purek_qr_invalid/);
  }
  assert.equal(await page.locator('#purek-address-confirmed').isChecked(),true);
});

test('manual acquisition retains native URL validation and Rust rejects invalid/oversized QR input',async t=>{
  const page=await openManage(t);await page.locator('#purek-dlna-entry summary').click();
  await page.locator('#purek-dlna-url').fill('not a URL');await page.locator('#purek-dlna-connect').click();
  assert.equal(await page.evaluate(()=>fixture.calls.length),0);
  for(const raw of ['https://wx.chunk.cn.example.com/projection/login','https://wx.chunk.cn/projection/login?data='+'房'.repeat(11000)]){
    await page.locator('#purek-dlna-url').fill(raw);await page.locator('#purek-dlna-connect').click();
    assert.equal(await page.evaluate(()=>fixture.calls.at(-1).path),'/api/purek/prepare');
    await page.evaluate(()=>fixture.reject('purek_qr_invalid'));await idle(page,'#purek-dlna-connect');
    assert.match(await page.locator('#purek-error').innerText(),/purek_qr_invalid/);
  }
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.path==='/api/cast/connect')),false);
});

test('connection preserves physical output; the output switch reserves native ownership until suspension',async t=>{
  const page=await openManage(t);
  await page.evaluate(()=>{fixture.native();state.presentationSession={mode:'localDualScreen',phase:'active',generation:1};});
  await page.locator('[data-cast-connect="one"]').click();
  assert.deepEqual(await page.evaluate(()=>fixture.calls),[{path:'/api/cast/connect',payload:{device_key:'one'}}]);
  await page.evaluate(()=>{fixture.update({cast:{phase:'active',operation_id:1,connected:true,selected:'one'},purek:{connected:true,room_name:'Living room'},media_output:{authorized:true}});fixture.resolve({operation_id:1});});
  await idle(page,'[data-cast-connect="one"]');
  assert.equal(await page.evaluate(()=>state.presentationSession.mode),'localDualScreen');
  await page.locator('#purek-close').click();
  await page.locator('[data-media-output="settings"] .media-output-targets').click();
  await page.waitForFunction(()=>!BilikaraMediaOutput.busy());
  assert.equal(await page.evaluate(()=>fixture.calls.length),1,'physical display must be closed explicitly before changing output');
  assert.equal(await page.evaluate(()=>fixture.messages.at(-1)),dictionary.zh['mediaOutput.closeDisplay']);
  await page.evaluate(()=>fixture.finishPhysical());
  await page.locator('[data-media-output="settings"] .media-output-targets').click();
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/player/output'));
  assert.equal(await page.locator('#purek-open').isDisabled(),true,'connection actions cannot race pending output admission');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.slice(-2)),[{native:'set_network_presentation',args:{active:true,generation:2}},{path:'/api/player/output',payload:{target:'purek',experimental:true}}]);
  await page.evaluate(()=>{fixture.update({cast:{position:5}});});
  assert.equal(await page.evaluate(()=>state.presentationSession.mode),'networkRenderer','unrelated snapshots cannot release an in-flight output reservation');
  await page.evaluate(()=>fixture.resolve({...state.data,media_output:{...state.data.media_output,target:'purek'}}));
  await page.waitForFunction(()=>!BilikaraMediaOutput.busy());
  await page.evaluate(()=>fixture.update({media_output:{target:'local'}}));
  await page.waitForFunction(()=>state.presentationSession.mode==='singleScreen');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1).args),{active:false,generation:3});
  assert.equal(await page.evaluate(()=>state.data.cast.connected),true,'suspension retains the connection');
});

test('network admission waits for physical recovery and releases its lease when output fails',async t=>{
  const page=await openManage(t);
  await page.evaluate(()=>{
    fixture.native();state.presentationSession={mode:'localDualScreen',phase:'active',generation:1};
    window.outputFailure=null;
    void BilikaraPureK.requestOutput('/api/player/output',{target:'purek',experimental:true}).catch(error=>{window.outputFailure=error;});
  });
  assert.deepEqual(await page.evaluate(()=>fixture.calls),[{native:'closePhysical'}]);
  await page.evaluate(()=>fixture.finishPhysical());
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/player/output'));
  assert.deepEqual(await page.evaluate(()=>fixture.calls.slice(-2)),[{native:'set_network_presentation',args:{active:true,generation:2}},{path:'/api/player/output',payload:{target:'purek',experimental:true}}]);
  await page.evaluate(()=>fixture.reject('purek_output_backend_unavailable'));
  await page.waitForFunction(()=>state.presentationSession.mode==='singleScreen');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1).args),{active:false,generation:3});
  assert.equal(await page.evaluate(()=>window.outputFailure.code),'purek_output_backend_unavailable');
});

test('Manage self-test opens for its receiver, stays above Manage, and restores the device-row focus',async t=>{
  const page=await openManage(t,{selfTest:true});
  const trigger=page.locator('[data-cast-device="one"] [data-cast-compatibility-test]');
  await trigger.click();assert.equal(await page.locator('[data-test-device]').inputValue(),'one');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#cast-self-test').isVisible(),false);
  assert.equal(await page.locator('#purek-modal').isVisible(),true);
  assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);
});

for(const [platform,width]of [['desktop',700],['desktop',360],['android',360],['ios',360]])test(`nested self-test layering follows ${platform} Host rules at ${width}px`,async t=>{
  const page=await openManage(t,{platform,width,selfTest:true});
  await page.evaluate(()=>{
    const reference=document.createElement('dialog');reference.className='history-export-dialog';reference.id='reference-large-dialog';document.body.append(reference);
  });
  const trigger=page.locator('[data-cast-device="one"] [data-cast-compatibility-test]');
  await trigger.click();
  for(const theme of ['light','dark','blue']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const layer=await page.locator('#cast-self-test').evaluate(async dialog=>{
      await Promise.all(dialog.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
      const backdrop=getComputedStyle(dialog,'::backdrop');
      return {background:backdrop.backgroundColor,blur:backdrop.backdropFilter,opacity:backdrop.opacity,
        reference:getComputedStyle(document.getElementById('reference-large-dialog'),'::backdrop').backgroundColor,
        manageBlur:getComputedStyle(document.getElementById('purek-modal')).backdropFilter};
    });
    assert.equal(layer.background,layer.reference,`${platform}/${theme}: use the shared large-dialog surface`);
    assert.equal(layer.blur,'none');assert.equal(layer.manageBlur,'none');
    assert.equal(layer.opacity,'1');
    assert.equal(layer.background==='rgba(0, 0, 0, 0)',platform==='desktop');
  }
  await page.locator('#cast-discover').click({force:true});
  assert.equal(await page.evaluate(()=>fixture.calls.length),0,'the top-layer dialog must block underlying Manage actions');
  await page.emulateMedia({reducedMotion:'reduce'});
  if(platform!=='desktop')assert.equal(await page.locator('#cast-self-test').evaluate(n=>getComputedStyle(n,'::backdrop').animationDuration),'0.001s');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#purek-modal').isVisible(),true);
  assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);
});

test('Manage active-session text follows actual output in every language',async t=>{
  const page=await openManage(t);
  for(const language of ['zh','en','ja']){
    await page.evaluate(language=>fixture.language(language),language);
    for(const [target,output_enabled,key]of [['local',false,'purek.connected'],['local',true,'purek.connected'],['native',true,'purek.connected'],['purek',true,'cast.phase.active'],['purek',false,'purek.connected'],['purek',undefined,'cast.phase.active']]){
      await page.evaluate(({target,output_enabled})=>fixture.update({cast:{phase:'active',connected:true,owns_playback:true,output_enabled},media_output:{target}}),{target,output_enabled});
      assert.equal(await page.locator('#cast-status').innerText(),dictionary[language][key],`${language}/${target}/${output_enabled}`);
    }
  }
});

test('temporary preferences and Manage geometry remain stable at 700/360/320px in three languages',async t=>{
  const page=await openManage(t,{selfTest:true});
  await page.evaluate(()=>window.originalRow=document.querySelector('[data-cast-device="one"]'));
  for(const width of [700,360,320])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:800});await page.evaluate(language=>fixture.language(language),language);
    const row=page.locator('[data-cast-device="one"]');
    assert.equal(await row.locator('.cast-mode-label').innerText(),dictionary[language]['cast.deliveryThisRun']);
    assert.equal(await page.evaluate(()=>window.originalRow===document.querySelector('[data-cast-device="one"]')),true);
    assert.equal(await page.locator('.purek-card').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    for(const selector of ['#cast-discover','[data-cast-connect="one"]','[data-cast-device="one"] [data-cast-compatibility-test]'])assert.equal(await page.locator(selector).evaluate(n=>n.getBoundingClientRect().height),44);
    assert.equal(await row.locator('.cast-modes').evaluate(n=>n.getBoundingClientRect().height),48);
    const geometry=await page.locator('.purek-card').evaluate(n=>{
      const card=n.getBoundingClientRect(),close=n.querySelector('#purek-close').getBoundingClientRect(),title=getComputedStyle(n.querySelector('h2'));
      return {close:[close.width,close.height],right:card.right-close.right,top:close.top-card.top,title:[title.fontSize,title.lineHeight],inset:parseFloat(getComputedStyle(n).paddingLeft)};
    });
    assert.deepEqual(geometry.close,[32,32]);assert.deepEqual(geometry.title,['18px','24px']);assert.equal(geometry.inset,20);
    assert.ok(Math.abs(geometry.top-16)<=1&&Math.abs(geometry.right-16)<=1,JSON.stringify(geometry));
  }
});

test('Host DSP controls follow L0/L1 availability without losing pending guards or help access',async t=>{
  const page=await openManage(t);
  await page.locator('#purek-close').click();
  await page.evaluate(html=>{
    const host=new DOMParser().parseFromString(html,'text/html');
    for(const id of ['key-shift-panel','av-sync-panel'])document.body.append(host.getElementById(id));
    document.body.insertAdjacentHTML('beforeend','<span id="dsp-existing-description" hidden>Existing description</span>');
    document.getElementById('key-shift-input').setAttribute('aria-describedby','dsp-existing-description');
    window.elements={keyShiftPanel:document.getElementById('key-shift-panel'),keyShiftInput:document.getElementById('key-shift-input'),keyShiftResetButton:document.getElementById('key-shift-reset-button'),avSyncPanel:document.getElementById('av-sync-panel'),avOffsetInput:document.getElementById('av-offset-input'),avOffsetResetButton:document.getElementById('av-offset-reset-button'),avDelayLockButton:document.getElementById('av-delay-lock-button')};
    window.setClassToggle=(n,k,v)=>n.classList.toggle(k,v);window.setTextContent=(n,v)=>n.textContent=v;window.currentAvOffsetMs=()=>0;window.activeLocalPlayerElements=()=>({});
  },read('index.html'));
  await page.addScriptTag({content:appSection('function networkDspUnavailable()', 'async function setLocalPlayerKeyShift(')+appSection('function renderAvSyncControls(', 'function createSplitPlayerStartupSynchronizer(')});
  const client=await page.context().newCDPSession(page);
  const {root}=await client.send('DOM.getDocument');
  for(const language of ['zh','en','ja'])for(const [target,level,blocked]of [['purek','L0',true],['purek',null,true],['purek','L1',false],['local','L0',false],['native','L1',false]]){
    await page.evaluate(({language,target,level})=>{fixture.language(language);state.data.media_output={target,pipeline_level:level};state.data.player_settings.key_shift=2;renderKeyShiftControls('local');renderAvSyncControls('local',{av_delay:{has_local_adjustment:true,lock_button_enabled:true}});},{language,target,level});
    for(const [panel,kind,key]of [['key-shift-panel','key-shift','player.keyShiftHint'],['av-sync-panel','av-sync','player.avSyncHint']]){
      const helpId=`host-${kind}-network-dsp`,infoId=`host-${kind}-info`;
      const trigger=page.locator(`button[aria-describedby="${infoId}"]`);
      assert.equal(await trigger.count(),1,'Only the info trigger describes the positioned bubble');
      assert.equal(await trigger.isEnabled(),true);
      assert.equal(await page.locator(`#${infoId} > span:not([hidden])`).textContent(),dictionary[language][blocked?'mediaOutput.dspUnavailable':key]);
      for(const control of await page.locator(`#${panel} input,#${panel} button:not(.cache-advanced-info-button)`).all()){
        assert.equal(await control.isDisabled(),blocked);
        const ids=(await control.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);
        assert.equal(ids.includes(infoId),false);
        assert.equal(ids.includes(helpId),blocked);
        assert.equal(ids.length,new Set(ids).size);
      }
      const {nodeId}=await client.send('DOM.querySelector',{nodeId:root.nodeId,selector:`#${panel} button.av-sync-step-button`});
      const {nodes}=await client.send('Accessibility.getPartialAXTree',{nodeId,fetchRelatives:false});
      assert.equal(nodes[0].ignored,false);
      assert.equal(nodes[0].description?.value||'',blocked?dictionary[language]['mediaOutput.dspUnavailable']:'','Disabled controls retain a localized accessible description even when the bubble is closed');
    }
    assert.equal(await page.locator('#key-shift-input').getAttribute('aria-describedby'),blocked?'dsp-existing-description host-key-shift-network-dsp':'dsp-existing-description');
  }
  await page.evaluate(()=>{elements.keyShiftResetButton.setAttribute('aria-busy','true');state.avOffsetSaving=true;renderKeyShiftControls('local');renderAvSyncControls('local',{});});
  assert.equal(await page.locator('#key-shift-reset-button').isDisabled(),true);assert.equal(await page.locator('#av-offset-input').isDisabled(),true);
});

// P10 review B1: real Host order with production purek-room.js wiring. The
// disconnect revokes the ordinary session but asks Rust to keep the prepared
// Pure K room; start is sent only after that disconnect has settled.
test('Manage self-test disconnects with the prepared room retained before start',async t=>{
  const page=await openManage(t,{selfTest:true});
  await page.evaluate(()=>fixture.update({purek:{room_name:'Room',connection_type:'purek'}}));
  await page.locator('[data-cast-device="one"] [data-cast-compatibility-test]').click();
  await page.locator('[data-test-start]').click();
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/cast/disconnect'));
  const paths=()=>page.evaluate(()=>fixture.calls.filter(c=>c.path).map(c=>c.path));
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='/api/cast/disconnect')),[{path:'/api/cast/disconnect',payload:{retain_room:true}}]);
  assert.equal((await paths()).includes('/api/cast/self-test/start'),false);
  await page.evaluate(()=>{fixture.update({cast:{phase:'recovering',busy:true,operation_id:1}});fixture.resolve({accepted:true,operation_id:1},'/api/cast/disconnect');});
  await page.waitForTimeout(50);
  assert.equal((await paths()).includes('/api/cast/self-test/start'),false,'start waits for the disconnect to settle');
  await page.evaluate(()=>fixture.update({cast:{phase:'idle',busy:false,operation_id:1}}));
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/cast/self-test/start'));
  const order=await paths();
  assert.ok(order.indexOf('/api/cast/disconnect')<order.indexOf('/api/cast/self-test/start'),order.join());
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(c=>c.path==='/api/cast/self-test/start').payload),{generation:undefined,device_key:'one'});
  await page.evaluate(()=>fixture.resolve({accepted:true,generation:1},'/api/cast/self-test/start'));
  await idle(page,'[data-test-start]');
  assert.deepEqual(await page.evaluate(()=>fixture.messages),[]);
});

// P10 review N3 / plan decision 2: R1's receiver-free link check is part of
// next's pipeline test result in the settings output group.
for(const language of ['zh','en','ja'])test(`pipeline test result reports the R1 link check ${language}`,async t=>{
  const page=await openManage(t,{language});
  // A usable decoder makes next's pipeline test action available in settings.
  await page.evaluate(()=>{window.BilikaraNativeOutput={decoderKind:()=>'mse'};render();});
  const button=page.locator('[data-media-output="settings"] .media-output-pipeline-test');
  const line=page.locator('[data-media-output="settings"] .media-output-pipeline-check');
  assert.equal(await button.isVisible(),true);
  assert.equal(await line.isVisible(),false);
  const text=dictionary[language];
  await page.evaluate(()=>fixture.update({cast:{pipeline_running:true,pipeline_result:null}}));
  assert.equal(await line.textContent(),text['mediaOutput.pipelineCheck.running']);
  assert.equal(await line.isVisible(),true);
  await page.evaluate(()=>fixture.update({cast:{pipeline_running:false,pipeline_result:{ok:true,first_byte:true,sample_b:'verified'}}}));
  assert.equal(await line.textContent(),text['mediaOutput.pipelineCheck.passed']);
  assert.equal(await line.isVisible(),true);
  assert.equal(await line.getAttribute('role'),'status');
  await page.evaluate(()=>fixture.update({cast:{pipeline_result:{ok:true,first_byte:true,sample_b:'unavailable'}}}));
  assert.equal(await line.textContent(),text['mediaOutput.pipelineCheck.passedNoSample']);
  await page.evaluate(()=>fixture.update({cast:{pipeline_result:{ok:false,code:'cast_pipeline_failed',sample_b:'verified'}}}));
  assert.equal(await line.textContent(),text['mediaOutput.pipelineCheck.failed'].replace('{reason}',text['cast.error.cast_pipeline_failed']));
  await page.evaluate(()=>fixture.update({cast:{pipeline_result:{ok:false,code:'not_a_known_code'}}}));
  assert.equal(await line.textContent(),text['mediaOutput.pipelineCheck.failed'].replace('{reason}',text['cast.error.unknown']));
  const style=await line.evaluate(n=>({size:getComputedStyle(n).fontSize,margin:getComputedStyle(n).marginTop}));
  assert.deepEqual(style,{size:'13px',margin:'0px'});
  // P10 review R1: the result follows its action. While the pipeline test is
  // playing (or otherwise unavailable) the button and its result are hidden.
  await page.evaluate(()=>fixture.update({cast:{pipeline_result:{ok:true,first_byte:true,sample_b:'verified'}}}));
  assert.equal(await line.isVisible(),true);
  for(const media_output of [{target:'native'},{target:'local',authorized:true}]){
    await page.evaluate(value=>fixture.update({media_output:value}),media_output);
    assert.equal(await button.isVisible(),false,JSON.stringify(media_output));
    assert.equal(await line.isVisible(),false,JSON.stringify(media_output));
    await page.evaluate(()=>fixture.update({media_output:{target:'local',authorized:false}}));
    assert.equal(await line.isVisible(),true);
  }
  // Stopping the pipeline test early cancels the check; it is not shown as a failure.
  await page.evaluate(()=>fixture.update({cast:{pipeline_result:{ok:false,code:'cast_cancelled',sample_b:'verified'}}}));
  assert.equal(await button.isVisible(),true);
  assert.equal(await line.isVisible(),false);
  assert.equal(await line.textContent(),'');
  assert.equal((await page.locator('[data-media-output="settings"]').innerText()).includes(text['cast.error.cast_cancelled']),false);
});
