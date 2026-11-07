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
 const timers=new Set(),urls=new Set();let cameraResolve;
 const video={hidden:true,srcObject:null,pause(){},async play(){}},context={jsQR,BarcodeDetector,isSecureContext:true,navigator:{userAgent,mediaDevices:{getUserMedia:()=>new Promise(resolve=>{cameraResolve=resolve;})}},
  document:{documentElement:{dataset},createElement:()=>image?{...canvas(image),getContext:()=>({fillRect(){},drawImage(){},getImageData:()=>({...image,data:new Uint8ClampedArray(image.data)})})}:{}},performance,requestAnimationFrame:()=>1,cancelAnimationFrame(){},
  URL:class extends URL{static createObjectURL(){urls.add('blob:owned');return'blob:owned';}static revokeObjectURL(url){urls.delete(url);}},
  Image:class{constructor(){this.naturalWidth=image?.width;this.naturalHeight=image?.height;}set src(value){this.value=value;if(value&&image)queueMicrotask(()=>this.onload?.());}},
  setTimeout(fn,ms){const id=setTimeout(fn,ms);timers.add(id);return id;},clearTimeout(id){timers.delete(id);clearTimeout(id);}};
 context.window=context;vm.runInNewContext(source,context);
 return{context,video,timers,urls,cameraResolve:value=>cameraResolve(value),scanner:context.BilikaraKtvScanner};
}
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
