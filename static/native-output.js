/* Local/Audience sink for the Rust L1 MPEG-TS pipeline. HLS is only the
   browser presentation adapter; encoding, controls and lifecycle remain Rust. */
(() => {
  'use strict';
  let library;
  function loadLibrary() {
    if (!library) library=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/vendor/hls/hls.light.min.js';
      script.onload=()=>resolve(window.Hls);script.onerror=()=>{script.remove();library=null;reject(new Error('native_output_decoder'));};
      document.head.append(script);
    });
    return library;
  }
  function decoderKind(video=document.createElement('video')) {
    const native=Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
    // Safari/WKWebView use their system HLS decoder. WebKit ports without a
    // native HLS implementation cannot advertise this sink: their MSE path
    // can retain an updating final AVC buffer indefinitely, even on static TS.
    if(navigator.vendor==='Apple Computer, Inc.')return native?'native':'unavailable';
    const source=globalThis.MediaSource||globalThis.ManagedMediaSource;
    return source?.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
      &&source.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')?'mse':native?'native':'unavailable';
  }
  async function attach(video,url,callbacks={}) {
    const kind=decoderKind(video);
    let closed=false,disposed=false,failed=false,hls=null,handlers=callbacks,sourceReady=false,source=url,primed=kind==='native';
    const fail=()=>{if(!closed&&!disposed){failed=true;video.dataset.nativeOutputFailure ||= String(video.error?.code||'pipeline');handlers.error?.();}};
    const mediaError=()=>{if(!hls||sourceReady)fail();};
    const complete=()=>{if(primed&&video.ended&&!closed&&!disposed)handlers.ended?.();};
    const play=()=>{if(primed&&!closed&&!disposed&&video.paused)video.play().catch(()=>{});};
    video.addEventListener('error',mediaError);video.addEventListener('ended',complete);video.addEventListener('canplay',play);
    const release=()=>{
      disposed=true;closed=true;
      video.removeEventListener('error',mediaError);video.removeEventListener('ended',complete);video.removeEventListener('canplay',play);
      // Hls owns its MediaSource detach/reset. A second remove-src/load here
      // races WebKit's SourceBuffer teardown and can terminate its WebProcess.
      if(hls)hls.destroy();else {video.pause();video.removeAttribute('src');video.load();}
    };
    release.pause=()=>{if(closed||disposed)return;closed=true;hls?.stopLoad();video.pause();};
    release.resume=()=>{if(disposed)return;if(closed){closed=false;hls?.startLoad(-1);}play();};
    release.canReuse=()=>!failed&&Boolean(hls||kind==='native');
    release.observation=()=>({decoder:kind,clock:"output_timeline",period:handlers.period??null,primed,closed,paused:video.paused,ended:video.ended,
      ready_state:video.readyState,current_time:video.currentTime,
      duration:Number.isFinite(video.duration)?video.duration:null,
      ranges:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])});
    release.source=(next,options={})=>{
      if(disposed)return;
      const unchanged=next===source&&options.period===handlers.period;handlers=options;
      if(unchanged&&!closed)return;
      video.pause();closed=false;primed=kind==='native';delete video.dataset.nativeOutputFailure;
      // One MediaSource owns all discontinuous run periods in this mode. A
      // pause, seek or track change must not tear down WebKit SourceBuffers.
      if(next!==source){source=next;sourceReady=false;if(hls)hls.loadSource(next);}
      if(hls){
        // Explicitly resuming a new Rust generation invalidates the completed
        // playlist cache, while its MediaSource and SourceBuffers stay owned.
        for(const level of hls.levels)if(level.details&&!level.details.live)level.details=undefined;
        hls.startLoad(-1);
      }else video.src=next;play();
    };
    try {
      if(kind==='unavailable')throw new Error('native_output_decoder');
      if(kind==='native')video.src=url;
      else {
        const Hls=await loadLibrary();if(disposed)return release;
        if(!Hls.isSupported())throw new Error('native_output_decoder');
        hls=new Hls({enableWorker:false,lowLatencyMode:false,maxBufferLength:4,maxMaxBufferLength:8,
          maxBufferSize:16*1024*1024,backBufferLength:4,liveSyncDurationCount:1,liveMaxLatencyDurationCount:3});
        hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal&&!closed&&!disposed){video.dataset.nativeOutputFailure=/^[a-zA-Z]+$/.test(data.details)?data.details:'hls';fail();}});
        hls.on(Hls.Events.FRAG_BUFFERED,(_event,data)=>{
          if(primed||closed||disposed||data.frag.cc!==handlers.period)return;
          const ranges=video.buffered;
          for(let i=0;i<ranges.length;i++){
            const start=Math.max(ranges.start(i),data.frag.start);
            if(start<ranges.end(i)&&start<data.frag.end){
              video.currentTime=start;primed=true;video.dataset.nativeOutputPeriod=String(data.frag.cc);play();break;
            }
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED,()=>{sourceReady=true;play();});hls.attachMedia(video);hls.loadSource(url);
      }
      play();
    } catch {fail();}
    return release;
  }
  function create(frame,options) {
    let video=null,release=null,key='',url='',generation=0,period=null,pending=0,reported='';
    function park() {
      pending++;release?.pause();key='';url='';
      if(video)video.hidden=true;
      frame.classList.remove('has-native-output');
    }
    function dispose() {park();release?.();release=null;video?.remove();video=null;}
    async function sync(data,audience=false) {
      const output=data?.media_output;
      if(output?.target!=='native'){if(key||!video?.hidden)park();return;}
      if(!video){
        video=document.createElement('video');video.className='native-output-video';video.dataset.playerRole='native-output';
        video.playsInline=true;video.preload='auto';video.tabIndex=0;video.disablePictureInPicture=true;
        video.setAttribute('controlsList','nofullscreen');video.setAttribute('disablepictureinpicture','');
        window.BilikaraPresentationRenderer?.keepVideoLocal(video,document.documentElement.dataset.hostPlatform);
        video.addEventListener('click',()=>{if(document.documentElement.dataset.hostPlatform==='ios'&&!video.controls){video.controls=true;video.play().catch(()=>{});}});
        frame.append(video);frame.classList.add('has-native-output');
      }
      video.hidden=false;frame.classList.add('has-native-output');video.muted=audience;
      if(!output.desired_playing||!output.pipeline_level){if(key){pending++;key='';release?.pause();}video.pause();return;}
      const next=JSON.stringify([data.state_epoch,output.stream_generation]);
      if(next===key)return;
      key=next;reported='';generation=output.stream_generation;const ticket=++pending;
      release?.pause();
      try {
        const source=await options.read();if(ticket!==pending||key!==next)return;
        if(source.generation!==generation)throw new Error('native_output_retired');
        period=source.period;url=decoderKind(video)==='native'?source.native_url:source.url;options.changed();
        const target=video;
        const feedback=phase=>{
          if(ticket!==pending||reported||!video||key!==next)return;
          reported=phase;void options.feedback({generation:source.generation,phase}).catch(options.error);
        };
        const callbacks={period,error:()=>feedback('error'),ended:()=>feedback('ended')};
        if(release&&!release.canReuse()){release();release=null;}
        if(release)release.source(url,callbacks);
        else {const stop=await attach(target,url,callbacks);if(ticket!==pending)stop();else release=stop;}
      } catch(error) {if(ticket===pending)options.error(error);}
    }
    return {sync,dispose,video:()=>video&&!video.hidden?video:null,diagnostics:()=>release?.observation(),url:()=>url,period:()=>period};
  }
  window.BilikaraNativeOutput=Object.freeze({attach,create,decoderKind});
})();
