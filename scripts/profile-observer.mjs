// Test-only observers. Never imported by the shipped Host/Audience.
export function distribution(values) {
  const numbers=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return {count:numbers.length,mean:numbers.length?numbers.reduce((a,b)=>a+b,0)/numbers.length:null,
    p95:numbers.length?numbers[Math.ceil(numbers.length*.95)-1]:null,max:numbers.at(-1)??null};
}

export function installProfileObserver(options={}) {
  const records={},maxSamples=8192;
  const push=(name,value)=>{const r=records[name]||=( {count:0,sum:0,max:0,samples:[]} );r.count++;r.sum+=value;r.max=Math.max(r.max,value);if(r.samples.length<maxSamples)r.samples.push(value);};
  const wrap=(name,fn)=>function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{push(name,performance.now()-start);}};
  const counters={},lifetimeCounters={},inc=name=>{counters[name]=(counters[name]||0)+1;lifetimeCounters[name]=(lifetimeCounters[name]||0)+1;};
  let active=false,mutationObserver;
  const elements=new Map(),hlsInstances=[];
  window.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='worker-src')inc('workerCspBlocks');});
  // Keep the profiler's legacy field name; totalVideoFrames is a browser
  // quality counter, not independently sampled decoder-thread activity.
  const quality=node=>{const q=node.getVideoPlaybackQuality?.();return{decoded:q?.totalVideoFrames??null,dropped:q?.droppedVideoFrames??null};};
  const observe=node=>{
    if(elements.has(node))return;
    const record={node,frames:0,intervals:[],last:null,events:{},mediaErrors:0};elements.set(node,record);
    for(const type of ['play','pause','seeking','seeked','waiting','stalled','ended','error'])node.addEventListener(type,()=>{
      if(active){record.events[type]=(record.events[type]||0)+1;if(type==='error')record.mediaErrors++;}
    });
    if(options.frameCallbacks!==false&&node.tagName==='VIDEO'&&node.requestVideoFrameCallback){
      const frame=now=>{if(active){record.frames++;if(record.last!==null&&record.intervals.length<maxSamples)record.intervals.push(now-record.last);record.last=now;}node.requestVideoFrameCallback(frame);};
      node.requestVideoFrameCallback(frame);
    }
  };
  const scan=()=>document.querySelectorAll('video,audio').forEach(observe);
  new MutationObserver(scan).observe(document,{childList:true,subtree:true});
  try{new PerformanceObserver(list=>{if(active)for(const entry of list.getEntries()){inc('longTasks');push('longTaskMs',entry.duration);}}).observe({type:'longtask',buffered:false});}catch{}
  // Count actual setter attempts without recording source/credential values.
  for(const field of ['currentTime','playbackRate']){
    const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,field);
    if(d?.set&&d.configurable)Object.defineProperty(HTMLMediaElement.prototype,field,{...d,set(value){if(active)inc(field+'Writes');return d.set.call(this,value);}});
  }
  if(globalThis.SourceBuffer)for(const method of ['appendBuffer','remove']){
    const original=SourceBuffer.prototype[method];
    SourceBuffer.prototype[method]=function(...args){if(active)inc('sourceBuffer.'+method);return original.apply(this,args);};
  }
  let hls;
  Object.defineProperty(window,'Hls',{configurable:true,get:()=>hls,set(value){
    hls=new Proxy(value,{construct(target,args){
      const requestedWorker=args[0]?.enableWorker===true;
      const instance=Reflect.construct(target,args);inc('hlsInstances');if(hlsInstances.length<8&&typeof WeakRef==='function')hlsInstances.push({reference:new WeakRef(instance),requestedWorker});
      for(const event of [value.Events.FRAG_BUFFERED,value.Events.ERROR,value.Events.BUFFER_APPENDED])if(event)instance.on(event,(_name,data)=>{
        if(active){inc(event);if(data?.fatal)inc('hlsFatalErrors');}
        if(data?.event==='demuxerWorker')inc('hlsWorkerFallbacks');
      });
      return instance;
    }});
  }});
  window.__bilikaraProfile={wrap,push,inc,
    start(){
      scan();for(const key of Object.keys(records))delete records[key];for(const key of Object.keys(counters))delete counters[key];
      for(const r of elements.values()){r.frames=0;r.last=null;r.intervals=[];r.events={};r.mediaErrors=0;r.initial=quality(r.node);r.startTime=r.node.currentTime;}
      mutationObserver?.disconnect();mutationObserver=new MutationObserver(list=>{for(const m of list){inc('domMutations');if(m.type==='attributes')inc('attributeMutations');}});
      mutationObserver.observe(document,{attributes:true,characterData:true,childList:true,subtree:true});active=true;
    },
    snapshot(){
      const stats=values=>{const x=values.slice().sort((a,b)=>a-b);return{samples:x.length,p95:x.length?x[Math.ceil(x.length*.95)-1]:null,max:x.at(-1)??null};};
      const functions=Object.fromEntries(Object.entries(records).map(([k,r])=>[k,{unit:k.endsWith('Chars')?'characters':'ms',count:r.count,meanMs:r.sum/r.count,maxMs:r.max,...stats(r.samples)}]));
      return {frameCallbacksObserved:options.frameCallbacks!==false,hls:hlsInstances.map(({reference,requestedWorker})=>{const instance=reference.deref();return{requestedWorker,retired:!instance,configuredWorker:instance?.config?.enableWorker??null,activeWorker:Boolean(instance?.streamController?.transmuxer?.workerContext)};}),functions,counters:{...counters},lifetimeCounters:{...lifetimeCounters},sampleCap:maxSamples,media:[...elements.values()].filter(r=>r.node.isConnected).map(r=>({
        kind:r.node.tagName.toLowerCase(),activeHostSink:window.__bilikaraProfile.activeVideo?.()===r.node,sourcePresent:Boolean(r.node.currentSrc),native:r.node.dataset.playerRole==='native-output',
        time:r.node.currentTime,startTime:r.startTime??null,paused:r.node.paused,seeking:r.node.seeking,ready:r.node.readyState,ended:r.node.ended,
        width:r.node.videoWidth??null,height:r.node.videoHeight??null,rate:r.node.playbackRate,
        frames:r.frames,frameIntervalsMs:stats(r.intervals),quality:quality(r.node),initialQuality:r.initial??null,
        events:r.events,errorCode:r.node.error?.code??null})),
        audioUnderruns:null,physicalAudio:null,longTaskSupport:PerformanceObserver.supportedEntryTypes?.includes('longtask')??false};
    }};
}

export function instrumentController(source) {
  const marker='  revealCursor();\n  start().catch';
  if(!source.includes(marker))throw new Error('controller instrumentation anchor changed');
  return source.replace(marker,`  for(const [name,read,write] of [
    ['applyClock',()=>applyClock,v=>applyClock=v],['renderOverlay',()=>renderOverlay,v=>renderOverlay=v],
    ['handleMasterMessage',()=>handleMasterMessage,v=>handleMasterMessage=v]])write(window.__bilikaraProfile.wrap(name,read()));
${marker}`);
}
