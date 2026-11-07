// Actual browser DOM writes, not an emulated DOM. No physical output gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';

for(const engine of [chromium,webkit])test(`${engine.name()} presentation countdown changes only its actual DOM state [P0-PERF-03]`,{timeout:30000},async t=>{
  const browser=await engine.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<title>Presentation renderer contract</title><main><video></video><audio></audio></main>');
  await page.addScriptTag({path:path.join(root,'static/presentation-renderer.js')});
  const result=await page.evaluate(async()=>{
    const root=document.querySelector('main'),renderer=BilikaraPresentationRenderer;
    const media=[...root.children];
    const scene={generation:3,revision:8,currentItemIdentity:'fixture',title:'Fixture',
      displayMetadata:{cacheStatus:'ready'},overlay:{visible:true,heading:'Next',deadline:30000,durationMs:30000,
        title:'Synthetic song',requester:'Fixture',duration:'0:30',cacheStatus:'ready',countdownLabel:'Countdown',
        queueHeading:'Queue',rows:[{title:'Second',requester:'Other',duration:'0:30',cacheStatus:'ready'}]}};
    renderer.renderScene(root,scene,{now:10000,showDownloadProgress:true});
    const row=root.querySelector('[data-delay-list]').firstElementChild;
    let mutations=[];const observer=new MutationObserver(list=>mutations.push(...list));
    observer.observe(root,{attributes:true,childList:true,characterData:true,subtree:true});
    for(let i=0;i<20;i++)renderer.renderScene(root,scene,{now:10000,showDownloadProgress:true});
    await new Promise(resolve=>setTimeout(resolve,0));
    const identicalWrites=mutations.length;mutations=[];
    renderer.renderScene(root,scene,{now:10500,showDownloadProgress:true});
    await new Promise(resolve=>setTimeout(resolve,0));
    const countdownWrites=mutations.map(m=>({attribute:m.attributeName,type:m.type}));mutations=[];
    scene.title='Updated';scene.overlay.heading='Changed';scene.overlay.rows[0].cacheStatus='failed';
    renderer.renderScene(root,scene,{now:11000,primaryIndex:1,showDownloadProgress:true});
    const changed={title:root.dataset.presentationTitle,heading:root.querySelector('[data-delay-heading]').textContent,
      cache:row.dataset.cacheState,number:row.querySelector('.queue-badge-label').textContent};
    renderer.renderScene(root,scene,{now:11000,showDownloadProgress:true});
    const audienceGlyph=!root.querySelector('.queue-badge-play').hasAttribute('hidden');
    const sameNodes=media.every((node,index)=>root.children[index]===node)&&row===root.querySelector('[data-delay-list]').firstElementChild;
    observer.disconnect();return{identicalWrites,countdownWrites,changed,sameNodes,audienceGlyph};
  });
  if(process.env.BILIKARA_PERFORMANCE_EVIDENCE){mkdirSync(process.env.BILIKARA_PERFORMANCE_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.BILIKARA_PERFORMANCE_EVIDENCE,`renderer-${engine.name()}.png`)});}
  assert.equal(await page.title(),'Presentation renderer contract');assert.deepEqual(errors,[]);
  assert.equal(result.identicalWrites,0,'identical 100ms clock paints must not mutate scene/ARIA/glyph DOM');
  assert.ok(result.countdownWrites.length>0,'countdown progress must still animate');
  assert.ok(result.countdownWrites.every(m=>m.type==='attributes'&&m.attribute==='style'),'within one second only the countdown ring changes');
  assert.deepEqual(result.changed,{title:'Updated',heading:'Changed',cache:'failed',number:'2'});
  assert.equal(result.sameNodes,true);assert.equal(result.audienceGlyph,true);
});
