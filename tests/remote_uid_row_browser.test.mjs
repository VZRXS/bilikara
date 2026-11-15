// G14 (user decision A): Remote source UID rows keep the input, add/fetch and
// manual-refresh actions on one shared row. At 360px English the input keeps
// 128px and action labels may wrap to two lines at 16px inside the unchanged
// 44px control; wider English and Chinese/Japanese labels stay single-line.
// Rendered geometry only: physical devices and system font scaling are separate.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before} from 'node:test';
import {chromium,webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

let binary;
before(async()=>{if(process.platform==='linux')binary=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();},{timeout:300000});

const forms={
  uids:{form:'#sources-follow-uid-form',input:'#sources-follow-uid-input',
    buttons:['#sources-add-follow-uid-button','#refresh-gatcha-cache-button']},
  favorites:{form:'#sources-favlist-pull-form',input:'#sources-favlist-uid-input',
    buttons:['#sources-pull-favlist-button']},
};
// Every label the Remote assigns to these buttons, idle and busy.
const labels={
  '#sources-add-follow-uid-button':['gatcha.add','gatcha.adding','gatcha.pulling'],
  '#refresh-gatcha-cache-button':['gatcha.refresh','gatcha.refreshing','gatcha.pulling'],
  '#sources-pull-favlist-button':['gatcha.pullFavlist','gatcha.pulling'],
};

async function open(t,engine) {
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-remote-uid-row-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const host=await RunningHost.start(binary,home,[home,path.join(root,'static')],isolatedEnvironment(home),true);
  t.after(()=>host.close());await host.api('/api/session-users/add',{name:'Fixture singer'});
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:360,height:740},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(()=>{localStorage.setItem('bilikara.update.automatic','false');localStorage.setItem('bilikara.ui.language','en');});
  await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(host.base+'/remote');
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.data?.session_user_entries?.length);
  await page.locator('#remote-identity-input').fill('UID row tester');await page.locator('#remote-identity-submit').click();
  await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  // Keep server snapshots from re-rendering labels between assignment and measurement.
  await page.evaluate(()=>{state.eventSource?.close();});
  await page.locator('[data-remote-request-view="sources"]').click();
  return page;
}

async function settle(page) {
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
}

// Assign each candidate label and measure synchronously, then restore the
// rendered text. Busy labels come from the same translation keys the Remote uses.
function measure(page,spec) {
  return page.evaluate(({spec,labels})=>{
    const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const input=document.querySelector(spec.input),form=document.querySelector(spec.form);
    const lines=node=>{
      const range=document.createRange();range.selectNodeContents(node);
      const tops=[];
      for(const rect of range.getClientRects()){
        if(rect.width<1)continue;
        if(!tops.some(top=>Math.abs(top-rect.top)<2))tops.push(rect.top);
      }
      return {count:tops.length,text:box(range)};
    };
    const sample=(button,text)=>{
      const original=button.textContent;
      if(text!==undefined)button.textContent=text;
      const style=getComputedStyle(button),measured=lines(button);
      const result={label:button.textContent,box:box(button),height:button.getBoundingClientRect().height,
        fontSize:style.fontSize,lineHeight:style.lineHeight,lines:measured.count,text:measured.text,
        scroll:[button.scrollWidth,button.clientWidth,button.scrollHeight,button.clientHeight]};
      if(text!==undefined)button.textContent=original;
      return result;
    };
    const buttons=spec.buttons.map(selector=>{
      const button=document.querySelector(selector);
      return {selector,rendered:sample(button),labels:labels[selector].map(key=>sample(button,t(key)))};
    });
    return {lang:document.documentElement.lang,viewport:innerWidth,form:box(form),input:box(input),
      inputMin:getComputedStyle(input).minWidth,buttons};
  },{spec,labels});
}

function check(value,{twoLine,englishMinimum}) {
  const context=JSON.stringify(value);
  const centre=box=>(box.top+box.bottom)/2;
  if(englishMinimum)assert.ok(value.input.width>=128,'English UID input keeps 128px: '+context);
  else assert.ok(value.input.width>0,context);
  for(const button of value.buttons){
    // One row: input and every action share a centre line and do not stack.
    assert.ok(Math.abs(centre(button.rendered.box)-centre(value.input))<=1,'UID row stays on one line: '+context);
    assert.ok(button.rendered.box.left>=value.input.right-0.5,'actions follow the input on its row: '+context);
    assert.ok(button.rendered.box.right<=value.form.right+0.5,'actions stay inside the form: '+context);
    for(const sample of [button.rendered,...button.labels]){
      const detail=button.selector+' '+JSON.stringify(sample);
      assert.equal(sample.height,44,'44px control height: '+detail);
      assert.equal(sample.fontSize,'16px','ordinary 16px action text: '+detail);
      assert.ok(sample.lines>=1&&sample.lines<=(twoLine?2:1),(twoLine?'at most two lines: ':'single line: ')+detail);
      const [scrollWidth,clientWidth,scrollHeight,clientHeight]=sample.scroll;
      assert.ok(scrollWidth<=clientWidth&&scrollHeight<=clientHeight,'label does not overflow its control: '+detail);
      assert.ok(sample.text.left>=sample.box.left-0.5&&sample.text.right<=sample.box.right+0.5
        &&sample.text.top>=sample.box.top-0.5&&sample.text.bottom<=sample.box.bottom+0.5,'text box stays inside the control: '+detail);
    }
  }
}

for(const engine of [chromium,webkit])test(`${engine.name()} Remote UID rows keep one row with readable English inputs [G14]`,
  {skip:process.platform!=='linux',timeout:120000},async t=>{
    const page=await open(t,engine);
    const scenarios=[
      {width:360,language:'en',twoLine:true,englishMinimum:true},
      {width:393,language:'en',twoLine:false,englishMinimum:true},
      {width:520,language:'en',twoLine:false,englishMinimum:true},
      {width:1024,language:'en',twoLine:false,englishMinimum:true},
      {width:360,language:'zh',twoLine:false,englishMinimum:false},
      {width:360,language:'ja',twoLine:false,englishMinimum:false},
    ];
    const recorded=[];
    for(const scenario of scenarios){
      await page.setViewportSize({width:scenario.width,height:740});
      await page.evaluate(language=>setLanguage(language),scenario.language);
      for(const [mode,spec] of Object.entries(forms)){
        await page.locator(`[data-remote-sources-mode="${mode}"]`).click();
        await page.locator(spec.form).waitFor({state:'visible'});
        await page.locator(spec.form).scrollIntoViewIfNeeded();
        await settle(page);
        const value=await measure(page,spec);
        assert.equal(value.lang,scenario.language==='zh'?'zh-CN':scenario.language);
        assert.equal(value.viewport,scenario.width);
        check(value,scenario);
        recorded.push({...scenario,mode,input:Math.round(value.input.width),
          buttons:value.buttons.map(button=>({id:button.selector,lines:button.rendered.lines,width:Math.round(button.rendered.box.width)}))});
      }
    }
    // Real busy states rendered by the Remote itself at the narrowest English row.
    await page.setViewportSize({width:360,height:740});
    await page.evaluate(()=>setLanguage('en'));
    for(const [mode,spec] of Object.entries(forms)){
      await page.locator(`[data-remote-sources-mode="${mode}"]`).click();
      await page.locator(spec.form).waitFor({state:'visible'});
      await page.evaluate(mode=>{
        if(mode==='uids'){state.gatchaUidSaving=true;state.gatchaRefreshSaving=true;renderSourcesFollowBrowse();}
        else state.gatchaFavlistSaving=true;
        renderSourceManagementControls();
      },mode);
      await settle(page);
      const value=await measure(page,spec);
      for(const button of value.buttons)assert.equal(button.rendered.box.height,44);
      assert.deepEqual(value.buttons.map(button=>button.rendered.label),
        mode==='uids'?['Processing','Updating']:['Pulling'],'the Remote rendered its busy labels');
      check(value,{twoLine:true,englishMinimum:true});
      await page.evaluate(mode=>{
        if(mode==='uids'){state.gatchaUidSaving=false;state.gatchaRefreshSaving=false;renderSourcesFollowBrowse();}
        else state.gatchaFavlistSaving=false;
        renderSourceManagementControls();
      },mode);
    }
    t.diagnostic(JSON.stringify(recorded));
  });
