import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),qr=require('../static/qrcode-generator.js'),jsQR=require('../static/qr-decoder.js');
const source=readFileSync(new URL('../static/ktv-scanner.js',import.meta.url),'utf8');
function pixels(text,scale=5){const code=qr(0,'M');code.addData(text);code.make();const n=code.getModuleCount(),width=(n+8)*scale,data=new Uint8ClampedArray(width*width*4).fill(255);for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(code.isDark(y,x))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const p=(((y+4)*scale+dy)*width+(x+4)*scale+dx)*4;data[p]=data[p+1]=data[p+2]=0;}return{width,height:width,data};}
function canvas(image){return{width:image.width,height:image.height,getContext:()=>({getImageData:()=>({...image,data:new Uint8ClampedArray(image.data)})})};}
function environment({dataset={},userAgent='',BarcodeDetector,image=null}={}){
 const timers=new Set(),urls=new Set();let cameraResolve,cameraReject;
 const video={hidden:true,srcObject:null,pause(){},async play(){}},context={jsQR,BarcodeDetector,isSecureContext:true,navigator:{userAgent,mediaDevices:{getUserMedia:()=>new Promise((resolve,reject)=>{cameraResolve=resolve;cameraReject=reject;})}},
  document:{documentElement:{dataset},createElement:()=>image?{...canvas(image),getContext:()=>({fillRect(){},drawImage(){},getImageData:()=>({...image,data:new Uint8ClampedArray(image.data)})})}:{}},performance,requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  URL:class extends URL{static createObjectURL(){urls.add('blob:owned');return'blob:owned';}static revokeObjectURL(url){urls.delete(url);}},
  Image:class{constructor(){this.naturalWidth=image?.width;this.naturalHeight=image?.height;}set src(value){this.value=value;if(value&&image)queueMicrotask(()=>this.onload?.());}},
  setTimeout(fn,ms){const id=setTimeout(fn,ms);timers.add(id);return id;},clearTimeout(id){timers.delete(id);clearTimeout(id);}};
 context.window=context;vm.runInNewContext(source,context);
 return{context,video,timers,urls,cameraResolve:value=>cameraResolve(value),cameraReject:error=>cameraReject(error),scanner:context.BilikaraKtvScanner};
}

test('Android Host permission hidden/visible preserves the pending request and starts its first preview',async()=>{
 const e=environment({dataset:{nativeHost:'true',hostPlatform:'android'}});
 let stopped=0;const stream={getTracks:()=>[{stop(){stopped++;}}]};
 const scanner=e.scanner.create({video:e.video,onDecode(){},onError:error=>assert.fail(error)});
 const opening=scanner.camera();e.context.document.hidden=true;
 assert.equal(scanner.waitingForAndroidPermission(),true);
 assert.equal(e.video.srcObject,null,'no camera is held while permission is pending');
 e.context.document.hidden=false;e.cameraResolve(stream);await opening;
 assert.equal(e.video.srcObject,stream);assert.equal(e.video.hidden,false);assert.equal(stopped,0);
 assert.equal(scanner.waitingForAndroidPermission(),false);assert.equal(e.timers.size,0);
 e.context.document.hidden=true;scanner.stop();
 assert.equal(stopped,1);assert.equal(e.video.srcObject,null);assert.equal(e.video.hidden,true);
});

test('Android Host permission rejection after hidden still reaches the original permission error owner',async()=>{
 const e=environment({dataset:{nativeHost:'true',hostPlatform:'android'}}),errors=[];
 const scanner=e.scanner.create({video:e.video,onDecode(){},onError:error=>assert.fail(error)});
 const opening=scanner.camera().catch(error=>errors.push(error.code));e.context.document.hidden=true;
 assert.equal(scanner.waitingForAndroidPermission(),true);
 e.cameraReject(new DOMException('Denied','NotAllowedError'));await opening;e.context.document.hidden=false;
 assert.deepEqual(errors,['camera_permission']);assert.equal(scanner.waitingForAndroidPermission(),false);
 assert.equal(e.video.srcObject,null);assert.equal(e.timers.size,0);
});

test('permission result while still backgrounded releases tracks without starting preview or auto-reopening',async()=>{
 const e=environment({dataset:{nativeHost:'true',hostPlatform:'android'}});let stopped=0,played=0;
 e.video.play=async()=>{played++;};
 const scanner=e.scanner.create({video:e.video,onDecode(){},onError:error=>assert.fail(error)});
 const opening=scanner.camera();e.context.document.hidden=true;
 assert.equal(scanner.waitingForAndroidPermission(),true);
 e.cameraResolve({getTracks:()=>[{stop(){stopped++;}}]});await opening;
 assert.equal(stopped,1);assert.equal(played,0);assert.equal(e.video.srcObject,null);assert.equal(e.video.hidden,true);
 e.context.document.hidden=false;assert.equal(e.video.srcObject,null);assert.equal(e.timers.size,0);
});

test('permission visibility exemption is restricted to Android Host; page retirement still cancels it',async()=>{
 for(const dataset of [{},{nativeHost:'true',hostPlatform:'ios'},{nativeHost:'true',hostPlatform:'desktop'}]){
   const e=environment({dataset}),scanner=e.scanner.create({video:e.video,onDecode(){},onError(){}});
   const opening=scanner.camera();assert.equal(scanner.waitingForAndroidPermission(),false);scanner.stop();await opening;
   let stopped=0;e.cameraResolve({getTracks:()=>[{stop(){stopped++;}}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,1);
 }
 const host=readFileSync(new URL('../static/purek-room.js',import.meta.url),'utf8');
 const remote=readFileSync(new URL('../static/ktv-remote.js',import.meta.url),'utf8');
 assert.match(host,/if\(document.hidden&&!scanner.waitingForAndroidPermission\(\)\)stopScan\(\{preservePicker:true\}\)/);
 assert.match(host,/window.addEventListener\("pagehide",\(\)=>\{localLife\+\+;scanner.stop\(\)/);
 assert.match(remote,/if\(document.hidden\)scanner.stop\(\)/,'Remote retains its existing lifecycle');
});
test('the real bundled fallback reads QR pixels, rejects blank/multiple codes and tolerates unavailable native detection',async()=>{
 const e=environment(),text='https://wx.chunk.cn/projection/login?place_code=synthetic';
 assert.equal(await e.scanner.decode(canvas(pixels(text))),text);
 assert.equal(await e.scanner.decode(canvas(pixels(text)),{detect:async()=>{throw Error('unsupported native QR');}}),text);
 const image=pixels('one'),other=pixels('https://example.invalid/second-room',3),w=image.width+other.width+30,h=Math.max(image.height,other.height),data=new Uint8ClampedArray(w*h*4).fill(255);
 for(const [item,offset]of[[image,0],[other,image.width+30]])for(let y=0;y<item.height;y++)data.set(item.data.subarray(y*item.width*4,(y+1)*item.width*4),(y*w+offset)*4);
 assert.ok(jsQR(new Uint8ClampedArray(data),w,h),'the multi-code fixture must contain a readable first code');
 await assert.rejects(e.scanner.decode(canvas({width:w,height:h,data})),error=>error.code==='qr_image');
 assert.equal(await e.scanner.decode(canvas({width:64,height:64,data:new Uint8ClampedArray(64*64*4).fill(255)})),null);
});

test('Android Host and embedded Remote read real QR pixels without binding an unsafe native detector',async()=>{
 const text='http://192.168.1.8/description.xml';
 for(const options of [{dataset:{nativeHost:'true',hostPlatform:'android'}},{userAgent:'Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/133.0.0.0 Mobile Safari/537.36'}]){
  let constructed=0,decoded='';
  const e=environment({...options,image:pixels(text),BarcodeDetector:class{constructor(){constructed++;throw Error('unsafe JNI provider');}}});
  const scanner=e.scanner.create({video:e.video,onDecode:raw=>{decoded=raw;},onError:error=>assert.fail(error)});
  assert.equal(constructed,0,'Opening a resident scanner surface never probes native code');
  await scanner.file({size:100,type:'image/png'});
  assert.equal(decoded,text);assert.equal(constructed,0,'Embedded Android uses the bundled decoder even when the native property exists');
  assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
 }
});

test('other browsers construct the optional detector only on decoding and reuse it across acquisitions',async()=>{
 let constructed=0,detected=0;const decoded=[];
 const e=environment({image:pixels('fallback'),BarcodeDetector:class{constructor(){constructed++;}async detect(){detected++;return[{rawValue:'native fixture result'}];}}});
 const scanner=e.scanner.create({video:e.video,onDecode:raw=>decoded.push(raw),onError:error=>assert.fail(error)});
 assert.equal(constructed,0);
 for(let i=0;i<2;i++)await scanner.file({size:100,type:'image/png'});
 assert.equal(constructed,1);assert.equal(detected,2);assert.deepEqual(decoded,['native fixture result','native fixture result']);
});
test('Host and Remote share the same narrow official authorization URL output validation',()=>{
  const {scanner}=environment();
  assert.equal(scanner.validOfficial('https://wx.chunk.cn/projection/login?place_code=synthetic'),true);
  for(const raw of ['https://wx.chunk.cn.evil.invalid/projection/login','https://wx.chunk.cn/other',
    'javascript:alert(1)','https://user@wx.chunk.cn/projection/login','https://wx.chunk.cn:8443/projection/login',
    'https://wx.chunk.cn/projection/login#fragment'])assert.equal(scanner.validOfficial(raw),false);
});
test('canceling pending camera permission clears its deadline and stops a stream arriving after retirement',async()=>{
 const e=environment(),scanner=e.scanner.create({video:e.video,onDecode(){assert.fail('no automatic decode');},onError(){assert.fail('no retired errors');}});
 const opening=scanner.camera();assert.equal(e.timers.size,1);scanner.stop();await opening;assert.equal(e.timers.size,0);
 let stopped=0;e.cameraResolve({getTracks:()=>[{stop(){stopped++;}}]});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stopped,1);assert.equal(e.video.srcObject,null);assert.equal(e.video.hidden,true);
});
test('insecure camera has an explicit photo fallback and canceling image input releases URL/read ownership',async()=>{
 const e=environment(),scanner=e.scanner.create({video:e.video,onDecode(){assert.fail('no retired decode');},onError(){}});
 e.context.isSecureContext=false;await assert.rejects(scanner.camera(),error=>error.code==='camera_secure');assert.equal(e.timers.size,0);
 const loading=scanner.file({size:100,type:'image/png'});assert.equal(e.urls.size,1);scanner.stop();await assert.rejects(loading,error=>error.name==='AbortError');assert.equal(e.urls.size,0);
});

test('Android camera denial retains the permission hint and the same surface can import a QR image',async()=>{
 const text='http://192.168.1.8/description.xml',e=environment({dataset:{nativeHost:'true',hostPlatform:'android'},image:pixels(text)});
 const elements=new Map(),decoded=[];let loading,markup='',constraints;
 const node=()=>({value:'',files:[],disabled:false,clicks:0,listeners:{},attributes:{},
   setAttribute(key,value){this.attributes[key]=value;},addEventListener(key,fn){this.listeners[key]=fn;},
   click(){this.clicks++;if(!this.disabled)this.listeners.click?.();}});
 for(const key of ['.ktv-scan-gallery','.ktv-scan-capture','#denied-image-input','#denied-capture-input'])elements.set(key,node());
 elements.set('video',e.video);
 const root={classList:{add(){}},set innerHTML(value){markup=value;},querySelector:key=>elements.get(key)};
 e.context.document.addEventListener=()=>{};
 e.context.navigator.mediaDevices.getUserMedia=async value=>{constraints=value;throw new DOMException('Permission denied','NotAllowedError');};
 const surface=e.scanner.surface({root,prefix:'denied',translate:key=>key,onDecode:raw=>decoded.push(raw),
   onError:error=>assert.fail(error),onCamera(){},onFile:file=>{loading=surface.file(file);}});
 await assert.rejects(surface.open(),error=>error.code==='camera_permission');
 assert.equal(constraints.audio,false);assert.equal(constraints.video.facingMode.ideal,'environment');
 assert.equal(e.timers.size,0);assert.equal(e.video.srcObject,null);assert.equal(e.video.hidden,true);
 const {languages}=JSON.parse(readFileSync(new URL('../static/i18n.json',import.meta.url),'utf8'));
 for(const [lang,hint]of [['zh','无法打开相机，请检查权限或改用图片。'],['en','Camera could not open; check permission or import an image.'],['ja','カメラを開けません。権限を確認するか画像を選択してください。']]){
   assert.equal(languages[lang]['ktv.error.camera_permission'],hint,'existing permission guidance still offers image import');
 }
 assert.match(markup,/type="file" accept="image\/png,image\/jpeg,image\/webp,image\/svg\+xml" capture="environment"/,'system capture/photo picker remains available with the supported formats');
 assert.equal(surface.gallery.disabled,false);surface.gallery.click();
 assert.equal(surface.imageInput.clicks,1,'denial does not disable the gallery picker');
 surface.imageInput.files=[{size:100,type:'image/png'}];surface.imageInput.listeners.change();await loading;
 assert.deepEqual(decoded,[text]);assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
});

test('the full visible frame is decoded, including a QR at each edge without a reticle crop',async()=>{
  const e=environment(),text='http://192.168.1.8/description.xml',image=pixels(text,3),width=640,height=480;
  for(const [left,top] of [[0,0],[width-image.width,0],[0,height-image.height],[width-image.width,height-image.height]]){
    const data=new Uint8ClampedArray(width*height*4).fill(255);
    for(let y=0;y<image.height;y++)data.set(image.data.subarray(y*image.width*4,(y+1)*image.width*4),((y+top)*width+left)*4);
    assert.equal(await e.scanner.decode(canvas({width,height,data})),text);
  }
});


test('V7 cover preview decodes exactly the visible centered region in both orientations', () => {
  const {scanner} = environment();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(scanner.coverRegion(640, 480, 300, 300)), {x:80,y:0,width:480,height:480});
  assert.deepEqual(plain(scanner.coverRegion(480, 640, 300, 300)), {x:0,y:80,width:480,height:480});
  assert.deepEqual(plain(scanner.coverRegion(640, 480, 320, 240)), {x:0,y:0,width:640,height:480});
  assert.throws(() => scanner.coverRegion(0,480,300,300), error => error.code === 'qr_image');
});

test('only Android Host system picker rejects GIF by MIME, extension and signature without decoding',async()=>{
 for(const file of [
   {size:100,type:'image/gif',name:'qr'},
   {size:100,type:'',name:'qr.GIF'},
   ...['GIF87a','GIF89a'].map(header=>({size:100,type:'image/png',name:'qr.png',slice:(start,end)=>{
     assert.equal(start,0);assert.equal(end,6);return{arrayBuffer:async()=>new TextEncoder().encode(header).buffer};
   }}))
 ]){
   const e=environment({dataset:{nativeHost:'true',hostPlatform:'android'},image:pixels('must-not-be-submitted')}),scanner=e.scanner.create({video:e.video,onDecode(){assert.fail('GIF from the Android picker must not select a room');},onError:error=>assert.fail(error)});
   await assert.rejects(scanner.file(file,{androidPicker:true}),error=>error.code==='qr_format');
   assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
 }
 const {languages}=JSON.parse(readFileSync(new URL('../static/i18n.json',import.meta.url),'utf8'));
 for(const lang of ['zh','en','ja'])assert.match(languages[lang]['ktv.error.qr_format'],/GIF.*PNG.*JPEG.*WebP.*SVG/);
 for(const client of ['purek-room.js','ktv-remote.js']){
   const source=readFileSync(new URL('../static/'+client,import.meta.url),'utf8');
   assert.match(source,/"camera_permission","qr_image","qr_format"/,'both clients retain the specific format error owner');
 }
});

test('supported static image formats retain local Image/canvas QR decoding and release resources',async()=>{
 for(const type of ['image/png','image/jpeg','image/webp','image/svg+xml']){
   const text='http://192.168.1.8/description.xml',e=environment({image:pixels(text)}),decoded=[];
   const scanner=e.scanner.create({video:e.video,onDecode:raw=>decoded.push(raw),onError:error=>assert.fail(error)});
   await scanner.file({size:100,type,slice:()=>({arrayBuffer:async()=>new Uint8Array([137,80,78,71,13,10]).buffer})});
   assert.deepEqual(decoded,[text]);assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
 }
});

test('closing during an Android picker image header read does not revive image decoding',async()=>{
 const e=environment({dataset:{nativeHost:'true',hostPlatform:'android'},image:pixels('must-not-be-submitted')}),scanner=e.scanner.create({video:e.video,onDecode(){assert.fail('retired image');},onError:error=>assert.fail(error)});
 let release;const loading=scanner.file({size:100,type:'image/png',slice:()=>({arrayBuffer:()=>new Promise(resolve=>{release=resolve;})})},{androidPicker:true});
 scanner.stop();release(new Uint8Array([137,80,78,71,13,10]).buffer);await loading;
 assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
});

test('direct Android import and all other platforms retain the original GIF/BMP image decoder',async()=>{
 for(const dataset of [{},{nativeHost:'true',hostPlatform:'ios'},{nativeHost:'true',hostPlatform:'desktop'},{nativeHost:'true',hostPlatform:'android'}]){
   for(const type of ['image/gif','image/bmp']){
     const text='http://192.168.1.8/description.xml',e=environment({dataset,image:pixels(text)}),decoded=[];
     const scanner=e.scanner.create({video:e.video,onDecode:raw=>decoded.push(raw),onError:error=>assert.fail(error)});
     const file={size:100,type,name:type==='image/gif'?'qr.gif':'qr.bmp',slice(){assert.fail('original decode path must not read headers');}};
     await scanner.file(file);assert.deepEqual(decoded,[text]);assert.equal(e.urls.size,0);
     if(dataset.hostPlatform!=='android'){
       await scanner.file(file,{androidPicker:true});assert.deepEqual(decoded,[text,text],'a picker flag cannot restrict another platform');
     }else if(type==='image/bmp'){
       await scanner.file({...file,slice:()=>({arrayBuffer:async()=>new Uint8Array([66,77,0,0,0,0]).buffer})},{androidPicker:true});
       assert.deepEqual(decoded,[text,text],'even the Android picker policy rejects only GIF, not other decodable image types');
     }
   }
 }
});

test('surface restricts accept and marks only actual Android Host picker activations, clearing cancelled selections',async()=>{
 for(const dataset of [{},{nativeHost:'true',hostPlatform:'ios'},{nativeHost:'true',hostPlatform:'desktop'},{nativeHost:'true',hostPlatform:'android'}]){
   const android=dataset.hostPlatform==='android',text='http://192.168.1.8/description.xml',e=environment({dataset,image:pixels(text)});
   const elements=new Map(),sources=[];let markup='',loading;
   const node=()=>({value:'',files:[],listeners:{},setAttribute(){},addEventListener(key,fn){this.listeners[key]=fn;},click(){this.listeners.click?.();}});
   for(const key of ['.ktv-scan-gallery','.ktv-scan-capture','#picker-image-input','#picker-capture-input'])elements.set(key,node());
   elements.set('video',e.video);e.context.document.addEventListener=()=>{};
   const root={classList:{add(){}},set innerHTML(value){markup=value;},querySelector:key=>elements.get(key)};
   const surface=e.scanner.surface({root,prefix:'picker',translate:key=>key,onCamera(){},onDecode:raw=>assert.equal(raw,text),onError:error=>assert.fail(error),
     onFile:(file,input,source)=>{sources.push(source.androidPicker);loading=surface.file(file,source);}});
   const accept=android?'image/png,image/jpeg,image/webp,image/svg+xml':'image/*';
   assert.ok(markup.includes(`type="file" accept="${accept}" hidden`));
   assert.ok(markup.includes(`type="file" accept="${accept}" capture="environment"`));
   const gif={size:100,type:'image/gif',name:'qr.gif'};
   surface.imageInput.files=[gif];surface.imageInput.listeners.change();await loading;
   assert.equal(sources.at(-1),false,'direct injection without opening a picker preserves GIF import');
   surface.gallery.click();surface.stop({preservePicker:true});surface.imageInput.listeners.change();
   if(android)await assert.rejects(loading,error=>error.code==='qr_format');else await loading;
   assert.equal(sources.at(-1),android,'system picker provenance survives visibility-only scanner cleanup');
   // Cancelled/closed pickers cannot tag a subsequent direct import.
   surface.gallery.click();surface.imageInput.listeners.cancel();surface.imageInput.listeners.change();await loading;
   assert.equal(sources.at(-1),false);
   surface.gallery.click();surface.stop();surface.imageInput.listeners.change();await loading;
   assert.equal(sources.at(-1),false);
   e.context.isSecureContext=false;await surface.open();surface.captureInput.files=[gif];surface.captureInput.listeners.change();
   if(android)await assert.rejects(loading,error=>error.code==='qr_format');else await loading;
   assert.equal(sources.at(-1),android,'HTTP capture picker follows the same scoped policy');
   assert.equal(e.urls.size,0);assert.equal(e.timers.size,0);
 }
 const host=readFileSync(new URL('../static/purek-room.js',import.meta.url),'utf8');
 assert.match(host,/scanner.file\(file,source\)/,'Host forwards picker provenance instead of restricting every import');
});
