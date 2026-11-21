/* Shared client scanner. Decoding stays local; only the decoded text can enter
   the separately authorized assistance protocol. No network or storage here. */
(() => {
  "use strict";
  const failure=code=>Object.assign(new Error(code),{code});
  async function decode(canvas,detector=null){
    if(detector){try{
      const values=await detector.detect(canvas);
      if(values.length>1)throw failure("qr_image");
      if(values.length===1&&values[0].rawValue)return values[0].rawValue;
    }catch(error){if(error.code==="qr_image")throw error;/* native API may be incomplete; use the bundled decoder */}}
    const context=canvas.getContext("2d",{willReadFrequently:true});
    const image=context.getImageData(0,0,canvas.width,canvas.height);
    const result=window.jsQR(image.data,image.width,image.height,{inversionAttempts:"attemptBoth"});
    if(!result)return null;
    // Reject an ambiguous second code instead of choosing an arbitrary room.
    const points=Object.values(result.location),xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const left=Math.max(0,Math.floor(Math.min(...xs))-4),top=Math.max(0,Math.floor(Math.min(...ys))-4);
    const right=Math.min(image.width,Math.ceil(Math.max(...xs))+4),bottom=Math.min(image.height,Math.ceil(Math.max(...ys))+4);
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)for(let c=0;c<4;c++)image.data[(y*image.width+x)*4+c]=255;
    if(window.jsQR(image.data,image.width,image.height,{inversionAttempts:"attemptBoth"}))throw failure("qr_image");
    return result.data;
  }
  function coverRegion(width, height, targetWidth, targetHeight) {
    if (![width,height,targetWidth,targetHeight].every(value => Number.isFinite(value) && value > 0)) throw failure("qr_image");
    const scale = Math.max(targetWidth/width, targetHeight/height);
    const visibleWidth = targetWidth/scale, visibleHeight = targetHeight/scale;
    return {x:(width-visibleWidth)/2, y:(height-visibleHeight)/2, width:visibleWidth, height:visibleHeight};
  }
  function create({video,onDecode,onError}){
    let generation=0,stream=null,frame=null,reader=null,objectUrl=null,lastFrame=0,cancelRead=null,cancelCamera=null;
    const canvas=document.createElement("canvas");
    let detector=null,detectorRead=false;
    function nativeDetector(){
      if(detectorRead)return detector;detectorRead=true;
      const data=document.documentElement?.dataset;
      const userAgent=String(navigator.userAgent||"");
      const embeddedAndroid=(data?.nativeHost==="true"&&data?.hostPlatform==="android")
        || (/Android/i.test(userAgent)&&/\bwv\b/i.test(userAgent));
      // Some Android WebViews expose BarcodeDetector but its JNI provider
      // crashes the process when the embedding app has no GMS metadata. A JS
      // catch cannot recover that failure. Use the existing local pixel decoder
      // there, and never bind any native detector during page initialization.
      if(!embeddedAndroid)try{if(window.BarcodeDetector)detector=new BarcodeDetector({formats:["qr_code"]});}catch{/* bundled fallback */}
      return detector;
    }
    const current=ticket=>ticket===generation;
    const waitingForAndroidPermission=()=>document.documentElement?.dataset?.nativeHost==="true"
      &&document.documentElement.dataset.hostPlatform==="android"&&cancelCamera!==null&&stream===null;
    function stop(){
      generation++;if(frame!==null)cancelAnimationFrame(frame);frame=null;
      const canceled=Object.assign(new Error("Scanner closed"),{name:"AbortError"});
      cancelRead?.(canceled);cancelRead=null;cancelCamera?.(canceled);cancelCamera=null;
      stream?.getTracks().forEach(track=>track.stop());stream=null;video.pause();video.srcObject=null;video.hidden=true;
      if(reader){reader.onload=null;reader.onerror=null;reader.src="";reader=null;}
      if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;
    }
    function paint(source,width,height,region={x:0,y:0,width,height}){
      if(!width||!height||width*height>24000000)throw failure("qr_image");
      const scale=Math.min(1,1024/Math.max(region.width,region.height));canvas.width=Math.max(1,Math.round(region.width*scale));canvas.height=Math.max(1,Math.round(region.height*scale));
      const context=canvas.getContext("2d",{willReadFrequently:true});context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(source,region.x,region.y,region.width,region.height,0,0,canvas.width,canvas.height);
    }
    async function deliver(ticket){
      const raw=await decode(canvas,nativeDetector());
      if(!current(ticket)||!raw)return false;
      if(raw.length>12000)throw failure("qr_image");
      stop();await onDecode(raw);return true;
    }
    async function camera(){
      stop();const ticket=generation;
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw failure("camera_secure");
      let timer;
      const pending=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"}}});
      pending.then(value=>{if(!current(ticket))value.getTracks().forEach(t=>t.stop());},()=>{});
      try{
        const value=await Promise.race([pending,new Promise((_,reject)=>{cancelCamera=reject;timer=setTimeout(()=>reject(failure("camera_permission")),30000);})]);
        if(!current(ticket)){value.getTracks().forEach(t=>t.stop());return;}
        // A permission Activity may hide Android's WebView. Preserve its pending
        // result, but never attach or retain a camera after a real background exit.
        if(document.hidden){value.getTracks().forEach(t=>t.stop());stop();return;}
        stream=value;video.srcObject=value;video.hidden=false;await video.play();
        if(!current(ticket))return;
        async function scan(time){
          frame=null;if(!current(ticket))return;
          try{if(time-lastFrame>=400&&video.readyState>=2){lastFrame=time;paint(video,video.videoWidth,video.videoHeight,coverRegion(video.videoWidth,video.videoHeight,video.clientWidth||video.videoWidth,video.clientHeight||video.videoHeight));if(await deliver(ticket))return;}}
          catch(error){if(current(ticket)){stop();onError(error);}return;}
          if(current(ticket))frame=requestAnimationFrame(scan);
        }
        frame=requestAnimationFrame(scan);
      }catch(error){if(current(ticket)){stop();throw failure(error.code||"camera_permission");}}
      finally{clearTimeout(timer);if(current(ticket))cancelCamera=null;}
    }
    async function file(file){
      stop();const ticket=generation;
      if(!file||file.size>12*1024*1024||(file.type&&!file.type.startsWith("image/")))throw failure("qr_image");
      const image=new Image();reader=image;objectUrl=URL.createObjectURL(file);
      try{
        await new Promise((resolve,reject)=>{cancelRead=reject;image.onload=()=>{cancelRead=null;resolve();};image.onerror=()=>{cancelRead=null;reject(failure("qr_image"));};image.src=objectUrl;});
        if(!current(ticket))return;paint(image,image.naturalWidth,image.naturalHeight);
        if(!await deliver(ticket)&&current(ticket))throw failure("qr_image");
      }finally{if(current(ticket))stop();}
    }
    return Object.freeze({camera,file,stop,waitingForAndroidPermission});
  }
  // The same acquisition surface is mounted by mobile Host and Remote.
  // A live camera is optional; HTTP uses the system picture/capture picker.
  function surface({root,prefix,translate,onDecode,onError,onCamera,onFile}){
    root.classList.add("ktv-scan-view");
    root.innerHTML=`<video id="${prefix}-camera-preview" playsinline muted hidden></video>
      <button type="button" id="${prefix}-capture" class="ktv-scan-capture" data-i18n-aria-label="ktv.camera"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 8h3v3H8zm5 0h3v3h-3zm-5 5h3v3H8zm5 0h3v3h-3z"/></svg></button>
      <button type="button" id="${prefix}-import" class="ktv-scan-gallery" data-i18n-aria-label="purek.import"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg></button>
      <input id="${prefix}-image-input" type="file" accept="image/*" hidden>
      <input id="${prefix}-capture-input" type="file" accept="image/*" capture="environment" hidden>`;
    const video=root.querySelector("video"),gallery=root.querySelector(".ktv-scan-gallery"),capture=root.querySelector(".ktv-scan-capture");
    const imageInput=root.querySelector(`#${prefix}-image-input`),captureInput=root.querySelector(`#${prefix}-capture-input`);
    const scanner=create({video,onDecode,onError});
    const live=()=>window.isSecureContext&&typeof navigator.mediaDevices?.getUserMedia==="function";
    const localize=()=>{gallery.setAttribute("aria-label",translate("purek.import"));capture.setAttribute("aria-label",translate("ktv.camera"));};
    localize();document.addEventListener("bilikara:i18n",localize);
    gallery.addEventListener("click",()=>{imageInput.value="";imageInput.click();});
    capture.addEventListener("click",onCamera);
    for(const input of[imageInput,captureInput])input.addEventListener("change",()=>{const file=input.files?.[0];if(file)onFile(file,input);});
    return Object.freeze({...scanner,gallery,video,imageInput,captureInput,
      setDisabled(value){gallery.disabled=value;capture.disabled=value;},
      stop(){scanner.stop();imageInput.value="";captureInput.value="";},
      open(){if(live())return scanner.camera();captureInput.value="";captureInput.click();return Promise.resolve();}
    });
  }
  function validOfficial(raw){try{const u=new URL(raw);return ["http:","https:"].includes(u.protocol)&&u.hostname==="wx.chunk.cn"&&u.pathname.replace(/\/$/,"")==="/projection/login"&&!u.username&&!u.password&&!u.port&&!u.hash;}catch{return false;}}
  function classify(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 12000) return {kind:'invalid'};
    const value = raw.trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    if (!scheme) return {kind:'text', value};
    if (!['http', 'https'].includes(scheme)) {
      return ['javascript', 'data', 'file', 'content', 'intent', 'blob'].includes(scheme)
        ? {kind:'invalid'} : {kind:'unsupported', value};
    }
    const unsafe = /[\u0000-\u0020\u007f\\<>"`]/;
    if (value.length > 4096 || !/^https?:\/\/[^/?#]/i.test(value) || unsafe.test(value)) return {kind:'invalid'};
    let url;
    try {
      url = new URL(value);
      if (/[\u0000-\u001f\u007f\\]/.test(decodeURIComponent(url.pathname + url.search + url.hash))) return {kind:'invalid'};
    } catch { return {kind:'invalid'}; }
    if (!url.hostname || url.port === '0' || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(value)) return {kind:'invalid'};
    const host = url.hostname.replace(/\.+$/, '');
    if (host === 'wx.chunk.cn' || host === 'conn.dolphinstar.cn') return {kind:'purek', value};
    return {kind:'web', value:url.href, preview:url.origin};
  }
  window.BilikaraKtvScanner=Object.freeze({create,surface,decode,validOfficial,coverRegion,classify});
})();
