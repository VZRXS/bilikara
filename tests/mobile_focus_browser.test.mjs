// P0-UI-2: rendered tests of the shipped viewport adapter. Keyboard geometry
// is a bridge fixture; this does not run UIKit or qualify a physical IME.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {chromium, webkit} from 'playwright';

for (const engine of [chromium, webkit]) test(`${engine.name()} focused fields remain reachable when focus changes with the keyboard open [P0-UI-2]`,
  {timeout:60000}, async t => {
    const browser = await engine.launch(); t.after(() => browser.close());
    const page = await browser.newPage(), errors = [], samples = [];
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    for (const [width, height] of [[320,568],[375,667],[393,852],[430,932]]) {
      await page.goto("about:blank");
      await page.setViewportSize({width,height});
      await page.setContent(`<html data-native-host="true" data-host-platform="ios" data-host-layout="portrait"><head><title>Viewport adapter fixture</title>
        <style>html,body{margin:0;overflow:hidden}header{height:70px}#owner{position:absolute;top:90px;bottom:0;left:14px;right:14px;overflow-y:auto}input{height:44px;box-sizing:border-box;width:100%}.spacer{height:${height-240}px}.tail{height:1000px}</style></head>
        <body><header>Keyboard visibility</header><main id="owner"><input id="top" aria-label="Top field"><div class="spacer"></div><input id="lower" aria-label="Lower field"><div class="tail"></div></main></body></html>`);
      await page.evaluate(() => {
        const viewport = Object.assign(new EventTarget(),{height:innerHeight,offsetTop:0,scale:1});
        Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
      });
      await page.addScriptTag({path:path.resolve('static/ios-host.js')});
      const heading = await page.locator('header').boundingBox();
      await page.locator('#top').evaluate(input => input.focus({preventScroll:true}));
      await page.evaluate(() => {visualViewport.height=innerHeight-280;visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(() => BilikaraIOSHost.diagnostics().keyboard_inset===280);
      assert.equal(await page.locator('#owner').evaluate(node=>node.scrollTop),0,'visible top field does not move');
      assert.deepEqual(await page.locator('header').boundingBox(),heading);
      await page.locator('#lower').evaluate(input => input.focus({preventScroll:true}));
      await page.waitForFunction(() => document.getElementById('lower').getBoundingClientRect().bottom+4<=visualViewport.height);
      const scrolled = await page.locator('#owner').evaluate(node=>node.scrollTop);
      assert.ok(scrolled>0,'focus change reveals the lower field without changing the keyboard inset');
      assert.deepEqual(await page.locator('header').boundingBox(),heading);
      // A viewport pan with the same inset must also recheck visibility.
      await page.evaluate(() => {visualViewport.offsetTop=20;visualViewport.height-=20;visualViewport.dispatchEvent(new Event('scroll'));});
      assert.equal(await page.evaluate(()=>BilikaraIOSHost.diagnostics().keyboard_inset),280);
      await page.locator('#top').evaluate(input=>input.focus({preventScroll:true}));
      await page.waitForFunction(()=>document.getElementById('top').getBoundingClientRect().top-4>=visualViewport.offsetTop);
      await page.evaluate(()=>{visualViewport.height=innerHeight;visualViewport.offsetTop=0;visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(()=>BilikaraIOSHost.diagnostics().keyboard_inset===0);
      // A deliberately constrained owner cannot reveal beyond its scroll range.
      // Clamp locally and stay stable; never compensate by moving the root.
      await page.evaluate(()=>{
        const owner=document.getElementById('owner');owner.style.height='150px';owner.style.bottom='auto';
        document.querySelector('.spacer').style.height='120px';document.querySelector('.tail').style.height='0px';
        owner.scrollTop=0;document.getElementById('lower').focus({preventScroll:true});
        visualViewport.height=200;visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(()=>{const n=document.getElementById('owner');return n.scrollTop===n.scrollHeight-n.clientHeight;});
      const limited=await page.locator('#owner').evaluate(n=>({maximum:n.scrollHeight-n.clientHeight,actual:n.scrollTop}));
      assert.ok(limited.maximum>0);assert.equal(await page.evaluate(()=>scrollY),0);
      assert.deepEqual(await page.locator('header').boundingBox(),heading);
      samples.push({width,height,localScroll:scrolled,limitedRange:limited,header:heading});
    }
    assert.deepEqual(errors,[]);
    const evidence=process.env.BILIKARA_MOBILE_UI_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`focus-${engine.name()}.png`)});
      writeFileSync(path.join(evidence,`focus-${engine.name()}.json`),JSON.stringify({engine:engine.name(),version:browser.version(),samples,errors,fixture:'Linux rendered viewport adapter; synthetic IME geometry'},null,2),'utf8');}
  });

// Component paint proof uses the actual shipped styles. The separate real-Host
// suite checks the mounted app; this fixture isolates clipping from page layout.
const focusControls = client => [
  {name:'text',html:`<input type="text" class="${client==='remote'?'':'host-text-input'}" aria-label="Text">`,owner:'input'},
  {name:'password',html:`<input type="password" class="${client==='remote'?'':'host-text-input'}" aria-label="Password">`,owner:'input'},
  {name:'number',html:`<div class="${client==='remote'?'remote-input-wrap':'av-sync-input-wrap'}"><input type="number" aria-label="Number"></div>`,owner:'div'},
  {name:'select',html:'<select aria-label="Choice"><option></option></select>',owner:'select'},
  {name:'textarea',html:`<textarea class="${client==='remote'?'':'host-text-input'}" aria-label="Notes"></textarea>`,owner:'textarea'},
  {name:'search',html:'<div class="browse-search-bar is-open has-search"><span class="browse-search-context"></span><form class="browse-search-form"><input type="search" aria-label="Search"><button type="submit" aria-label="Search"></button></form></div>',owner:'form'},
  {name:'page',html:'<div class="result-pager"><form class="result-pager-editor"><span class="result-pager-input"><input type="text" inputmode="numeric" aria-label="Page"></span></form></div>',owner:'input'},
  {name:'source',html:'<div class="source-action-row"><input type="text" aria-label="Source"></div>',owner:'input'},
  {name:'runtime',html:'<label class="runtime-settings-select-shell"><select class="runtime-settings-select" aria-label="Runtime choice"><option></option></select></label>',owner:'label'},
];

for(const engine of [chromium,webkit])for(const client of ['desktop','android','ios','remote'])test(
  `${engine.name()} ${client} field focus stays visible inside clipping ancestors [IOS-09-09]`,{timeout:120000},async t=>{
    const browser=await engine.launch();t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:393,height:852}}),errors=[],samples=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
    await page.route('http://focus-components.test/**',route=>new URL(route.request().url()).pathname==='/accent-palette.css'
      ?route.fulfill({path:path.resolve('static/accent-palette.css'),contentType:'text/css'}):route.abort());
    const remote=client==='remote',mobile=client!=='desktop';
    const attributes=remote?'data-ui-client="remote"':`data-host-platform="${client}" data-host-layout="${mobile?'portrait':'landscape'}"`;
    await page.setContent(`<html ${attributes}><head><base href="http://focus-components.test/"><title>Shipped field focus components</title></head><body><aside id="focus-probe"></aside></body></html>`);
    // Keep the production relative palette import working in both engines.
    for(const file of [remote?'remote.css':'styles.css','browse-search.css','result-pagination.css','ui-surfaces.css'])await page.addStyleTag({path:path.resolve('static',file)});
    await page.addStyleTag({content:'#focus-probe{position:fixed;left:14px;top:120px;width:calc(100vw - 28px);background:var(--settings-group-bg)}#focus-probe input,#focus-probe textarea{caret-color:transparent}html[data-focus-large="true"] #focus-probe :is(input,select,textarea){font-size:var(--focus-probe-font-size)}'});
    assert.equal(await page.title(),'Shipped field focus components');
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(),0);
    await page.keyboard.press('Tab');
    const settle=()=>page.evaluate(async()=>{
      await document.fonts.ready;
      await Promise.allSettled([...document.querySelectorAll('#focus-probe,#focus-probe *')].flatMap(n=>n.getAnimations().map(a=>a.finished)));
      await new Promise(requestAnimationFrame);
    });
    const evidence=process.env.BILIKARA_FOCUS_EVIDENCE;
    t.after(()=>{
      assert.deepEqual(errors,[]);
      if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`fields-${engine.name()}-${client}.json`),JSON.stringify({engine:engine.name(),client,samples,errors,fixture:'Production CSS component paint; not UIKit or physical keyboard acceptance'},null,2),'utf8');}
    });
    const sizes=mobile?[[393,852,'zh',1],[320,568,'en',1],[375,667,'ja',1],[430,932,'zh',1],[393,852,'ja',1.3],[393,852,'en',2]]:[[700,600,'en',1]];
    for(const [width,height,language,scale] of sizes)for(const theme of ['light','dark','blue']){
      await page.setViewportSize({width,height});
      await page.evaluate(({theme,language,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.lang=language;document.documentElement.dataset.focusLarge=String(scale>1);document.documentElement.style.setProperty('--focus-probe-font-size',`${16*scale}px`);},{theme,language,scale});
      for(const control of focusControls(client)){
        await page.locator('#focus-probe').evaluate((node,html)=>{node.style.clipPath='';node.innerHTML=html;},control.html);await settle();
        const field=page.locator('#focus-probe :is(input,select,textarea)'),owner=page.locator('#focus-probe '+control.owner).first();
        const before=await owner.boundingBox();
        await field.evaluate(n=>n.focus({preventScroll:true}));await settle();
        const focused=await owner.evaluate(n=>{const s=getComputedStyle(n);return{outline:s.outlineStyle,width:parseFloat(s.outlineWidth),offset:parseFloat(s.outlineOffset),color:s.outlineColor,shadow:s.boxShadow};});
        const fontSize=await field.evaluate(n=>parseFloat(getComputedStyle(n).fontSize));
        if(scale>1)assert.ok(Math.abs(fontSize-16*scale)<.1,'the enlarged-font case really changes field text size');
        assert.deepEqual(await owner.boundingBox(),before,'focus never shifts field geometry');
        const sample={control:control.name,width,height,language,scale,fontSize,theme,bounds:before,focused};samples.push(sample);
        if(width===393&&scale===1 || !mobile&&control.name==='text'){
          const crop={x:Math.floor(before.x)-6,y:Math.floor(before.y)-6,width:Math.ceil(before.x+before.width)+6-(Math.floor(before.x)-6),height:Math.ceil(before.y+before.height)+6-(Math.floor(before.y)-6)};
          const unclipFocused=await page.screenshot({clip:crop});
          await field.evaluate(n=>n.blur());await settle();const unclipIdle=await page.screenshot({clip:crop});
          await page.locator('#focus-probe').evaluate((n,b)=>{const r=n.getBoundingClientRect();n.style.clipPath=`inset(${b.y-r.y}px ${r.right-b.x-b.width}px ${r.bottom-b.y-b.height}px ${b.x-r.x}px)`;},before);
          const clipIdle=await page.screenshot({clip:crop});
          await field.evaluate(n=>n.focus({preventScroll:true}));await settle();const clipFocused=await page.screenshot({clip:crop});
          sample.paint=await page.evaluate(async({images,bounds,crop})=>{
            const pixels=[];
            for(const data of images){const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);pixels.push(ctx.getImageData(0,0,canvas.width,canvas.height).data);}
            const [active,idle,clippedActive,clippedIdle]=pixels;
            let inside=0,outside=0,clippedOutside=0;
            for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
              const index=(y*crop.width+x)*4,px=x+crop.x+.5,py=y+crop.y+.5;
              const changed=(a,b)=>[0,1,2].some(c=>Math.abs(a[index+c]-b[index+c])>2);
              if(px>bounds.x+1&&px<bounds.x+bounds.width-1&&py>bounds.y+1&&py<bounds.y+bounds.height-1){if(changed(active,idle))inside++;}
              else if(px<bounds.x-1||px>bounds.x+bounds.width+1||py<bounds.y-1||py>bounds.y+bounds.height+1){if(changed(active,idle))outside++;if(changed(clippedActive,clippedIdle))clippedOutside++;}
            }
            return {inside,outside,clippedOutside};
          },{images:[unclipFocused,unclipIdle,clipFocused,clipIdle].map(b=>b.toString('base64')),bounds:before,crop});
          if(evidence&&control.name==='text'&&theme==='light'){
            mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`clipped-${engine.name()}-${client}.png`),clipFocused);writeFileSync(path.join(evidence,`unclipped-${engine.name()}-${client}.png`),unclipFocused);
          }
          if(mobile)assert.ok(sample.paint.inside>10,'focus has visible paint inside the component: '+JSON.stringify(sample));
          if(mobile){assert.equal(sample.paint.outside,0,'no field focus paint is lost outside the clipping boundary: '+JSON.stringify(sample));assert.equal(sample.paint.clippedOutside,0);}
          else assert.ok(sample.paint.outside>0,'desktop Host retains its external focus halo');
        }
        if(mobile){assert.ok(focused.width>=2&&focused.offset+focused.width<=0,'mobile field owner paints a complete inset focus indicator: '+JSON.stringify(sample));}
      }
    }
  });
