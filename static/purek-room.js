// Host presentation and local acquisition. Room validation, official
// authorization, permissions, registration and output remain in Rust.
(() => {
  "use strict";
  const byId=id=>document.getElementById(id), section=byId("purek-settings"),modal=byId("purek-modal");
  if(!section||!modal)return;
  const anchor=document.createComment("desktop room settings position");section.before(anchor);
  let snapshot=null, assistance={devices:[],session:null},pending=false,opened=false,previousFocus=null,inert=[];
  const retiredEpochs=new Set();
  // R1 T6 (695e9917, retained through b49e1ae): keyed receiver rows,
  // authoritative operation completion and one bounded preference retry.
  const rows=new Map(),waiters=new Set(),actions=new Set();
  const cast=()=>state.data?.cast||{};
  const castWorking=()=>Boolean(cast().busy||["connecting","recovering","discovering"].includes(cast().phase));
  const castError=code=>{const key=`cast.error.${code||"unknown"}`,value=t(key);return value===key?t("cast.error.unknown"):value;};
  const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  let selfTest=null,nativeTransition=null,networkRequestPending=false;
  function wake(){for(const check of waiters)check();}
  function waitUntil(predicate){
    if(predicate())return Promise.resolve();
    return new Promise(resolve=>{const check=()=>{if(predicate()){waiters.delete(check);resolve();}};waiters.add(check);});
  }
  async function refresh(){
    const value=await readState();
    if(acceptHostStateSnapshot(value))render();
  }
  async function closePhysical(){
    if(state.presentationSession?.mode!=="localDualScreen"||state.presentationSession.phase==="inactive")return;
    if(state.presentationSession.phase!=="recovering")await deactivateLocalPresentation();
    await waitUntil(()=>state.presentationSession.phase==="inactive");
  }
  async function networkPresentation(active){
    if(nativeTransition)await nativeTransition;
    const invoke=tauriInvoke("presentation");
    if(!invoke||window.BilikaraNativePresentation||window.BilikaraAndroidPresentation)return;
    if((state.presentationSession?.mode==="networkRenderer")===active)return;
    nativeTransition=(async()=>{
      if(active)await closePhysical();
      await handlePresentationSession(await invoke("set_network_presentation",{active,generation:state.presentationSession.generation}));
    })();
    try{await nativeTransition;}finally{nativeTransition=null;}
  }
  function syncPresentation(){
    wake();
    if(nativeTransition)return;
    const desired=networkRequestPending||state.data?.media_output?.target==="purek";
    if((state.presentationSession?.mode==="networkRenderer")===desired)return;
    void networkPresentation(desired).catch(()=>setAppMessage(t("mediaOutput.error"),true)).finally(()=>{
      if(desired!==(networkRequestPending||state.data?.media_output?.target==="purek"))syncPresentation();
    });
  }
  // Connection/authorization alone keeps the local output. Reserve the native
  // renderer only when next's output group actually requests network playback.
  async function requestOutput(route,body,options){
    if(body.target==="purek"){networkRequestPending=true;pending=true;paint();}
    try{
      if(networkRequestPending)await networkPresentation(true);
      return await apiPost(route,body,options);
    }catch(error){settleOutput();throw error;}
  }
  function settleOutput(){networkRequestPending=false;pending=actions.size>0;paint();syncPresentation();}
  const request=(route,body={})=>apiPost(route,body,{timeoutMs:25000});
  async function readState(){
    const response=await fetch("/api/state",{cache:"no-store"}),payload=await response.json();
    if(!response.ok||payload.ok!==true)throw Error();
    return payload.data;
  }
  // Cast commands acknowledge admission; completion and errors arrive through
  // the authoritative snapshot. Preserve the existing snapshot ordering guard.
  async function castAction(operation,payload={}){
    const epoch=snapshot?.state_epoch;
    const accepted=await request(`/api/cast/${operation}`,payload);
    await refresh();
    await waitUntil(()=>snapshot?.state_epoch!==epoch||!castWorking()&&Number(cast().operation_id)>=accepted.operation_id);
    if(operation==="disconnect")await networkPresentation(false);
  }
  async function setDeviceMode(device_key,mode,command="cast.set_device_mode",field="mode"){
    const post=()=>request("/api/cast/command",{command,device_key,[field]:mode,revision:state.data.revision});
    let value;
    try{value=await post();}catch(error){
      if(error?.code!=="cast_revision_conflict")throw error;
      await refresh();
      if(!cast().renderers?.some(device=>device.device_key===device_key))throw {code:"cast_device_preferences_unavailable"};
      if(castWorking())throw {code:"cast_busy"};
      value=await post();
    }
    if(acceptHostStateSnapshot(value))render();
  }
  function paintReceivers(){
    const value=cast(),devices=Array.isArray(value.renderers)?value.renderers:[];
    const blocked=pending||castWorking()||selfTest?.busy()||value.self_test?.running||active();
    const discover=byId("cast-discover");
    discover.disabled=Boolean(blocked||snapshot?.connected);
    text(discover,t(discover.hasAttribute("aria-busy")?"purek.working":"cast.discover"));
    const cancel=byId("cast-cancel-operation");
    cancel.hidden=!["discovering","connecting","recovering"].includes(value.phase);
    cancel.disabled=actions.has(cancel)||value.phase==="recovering";
    text(cancel,t(actions.has(cancel)?"purek.working":"common.cancel"));
    const hint=["cellular_default","wifi_unvalidated","vpn_active","multicast_unavailable","battery_restricted"].includes(value.network_hint)?t(`cast.network.${value.network_hint}`):"";
    const status=byId("cast-status");
    // An active connection can stay authorized while next plays locally.
    const casting=state.data?.media_output?.target==="purek"&&value.output_enabled!==false;
    const phaseKey=value.phase==="active"&&!casting?"purek.connected":`cast.phase.${value.phase}`;
    text(status,[value.error_code?castError(value.error_code):value.phase&&value.phase!=="idle"?t(phaseKey):"",hint].filter(Boolean).join(" · "));
    status.hidden=!status.textContent;
    const keys=new Set(devices.map(device=>device.device_key));
    for(const [key,row]of rows)if(!keys.has(key)){row.remove();rows.delete(key);}
    for(const device of devices){
      let row=rows.get(device.device_key);
      if(!row){
        row=document.createElement("section");row.className="purek-device";row.dataset.castDevice=device.device_key;
        row.innerHTML='<div class="purek-room-line"><h4></h4><button type="button" class="toolbar-button purek-action" data-cast-connect></button></div><p class="cast-mode-label"></p><div class="request-subview-tabs cast-modes" role="group"></div><p class="cast-mode-label cast-picture-label"></p><div class="request-subview-tabs cast-pictures" role="group"></div><p class="cast-mode-label cast-picture-hint" hidden></p><button type="button" class="toolbar-button purek-action" data-cast-compatibility-test hidden></button>';
        row.querySelector("[data-cast-connect]").dataset.castConnect=device.device_key;
        for(const mode of ["auto","file","live"]){const button=document.createElement("button");button.type="button";button.dataset.castMode=mode;row.querySelector(".cast-modes").append(button);}
        for(const picture of ["pure","composited"]){const button=document.createElement("button");button.type="button";button.dataset.castPicture=picture;row.querySelector(".cast-pictures").append(button);}
        rows.set(device.device_key,row);byId("cast-devices").append(row);
      }
      text(row.querySelector("h4"),device.label);
      const selected=value.connected&&value.selected===device.device_key,connect=row.querySelector("[data-cast-connect]");
      connect.disabled=Boolean(blocked||selected);
      text(connect,t(actions.has(connect)?"purek.working":selected?"purek.connected":"purek.connectShort"));
      const label=t(device.preferences_persisted===false?"cast.deliveryThisRun":"cast.delivery");
      text(row.querySelector("p"),label);row.querySelector("[role=group]").setAttribute("aria-label",label);
      // A composited picture is always delivered live; the delivery choice
      // stays stored for when the picture returns to pure media.
      const picture=value.devices?.[device.device_key]?.picture||"pure";
      for(const button of row.querySelectorAll("[data-cast-mode]")){
        button.disabled=Boolean(blocked||picture==="composited");button.setAttribute("aria-pressed",String((value.devices?.[device.device_key]?.mode||"auto")===button.dataset.castMode));
        text(button,t(actions.has(button)?"purek.working":`cast.mode.${button.dataset.castMode}`));
      }
      const pictureLabel=t("cast.picture");
      text(row.querySelector(".cast-picture-label"),pictureLabel);row.querySelector(".cast-pictures").setAttribute("aria-label",pictureLabel);
      for(const button of row.querySelectorAll("[data-cast-picture]")){
        button.disabled=Boolean(blocked);button.setAttribute("aria-pressed",String(picture===button.dataset.castPicture));
        text(button,t(actions.has(button)?"purek.working":`cast.picture.${button.dataset.castPicture}`));
      }
      // The connected receiver: why a composited picture fell back, or what
      // it did not declare that a composited picture needs.
      const output=state.data?.media_output,hint=row.querySelector(".cast-picture-hint");
      const lacking=selected?output?.receiver_capabilities?.missing?.composited||[]:[];
      const refused=selected&&output?.composite_reason?t(`cast.compositeRefused.${output.composite_reason}`):"";
      const hintText=refused||(lacking.length?t("cast.capability.missingComposited").replace("{list}",lacking.map(key=>t(`cast.capability.${key}`)).join(" / ")):"");
      text(hint,hintText);hint.hidden=!hintText;
    }
    byId("cast-empty").hidden=devices.length>0;text(byId("cast-empty"),t("cast.empty"));
    selfTest?.render();wake();
  }
  const mobile = ["android","ios"].includes(document.documentElement.dataset.hostPlatform);
  let officialUrl="", officialOwner="", localLife=0, localAcquisition=false;
  const scanner=window.BilikaraKtvScanner.surface({root:byId("ktv-host-scan-view"),prefix:"ktv-host",translate:t,
    onCamera:()=>void openScanner(),
    onFile:(file,input)=>void action(scanner.gallery,async()=>{localAcquisition=true;try{await scanner.file(file);}finally{localAcquisition=false;input.value="";}}),
    onDecode:raw=>pending?(localAcquisition?prepareLocal(raw):stopScan()):action(scanner.gallery,()=>prepareLocal(raw)),
    onError:showError});
  function stopScan(){localLife++;scanner.stop();paint();}
  async function prepareLocal(raw,{manual=false}={}){
    if(!opened||(!mobile&&!manual)||active()||snapshot?.connected)return;
    const ticket=localLife;
    const prepared=await request("/api/purek/prepare",{url:raw});
    if(ticket!==localLife||!opened)return;
    officialOwner="";officialUrl=window.BilikaraKtvScanner.validOfficial(prepared.authorization_url)?prepared.authorization_url:"";
    const value=await readState();
    if(ticket!==localLife||!opened){officialUrl="";return;}
    apply(value.purek);applyAssistance(value.ktv_assistance);
    return prepared;
  }
  function position(){
    const phone=["android","ios"].includes(document.documentElement.dataset.hostPlatform)&&document.documentElement.dataset.hostLayout==="portrait";
    const destination=phone?byId("android-my-scroll"):anchor.parentElement;
    if(phone&&section.parentElement!==destination)destination.append(section);
    else if(!phone&&anchor.nextSibling!==section)anchor.after(section);
    section.classList.toggle("android-my-card",phone);
  }
  function stale(value){return retiredEpochs.has(value?.state_epoch)||(value?.state_epoch===snapshot?.state_epoch&&Number.isSafeInteger(value?.revision)&&value.revision<snapshot?.revision);}
  function apply(value){
    if(stale(value))return;
    if(snapshot?.connected!==value?.connected||snapshot?.room_name!==value?.room_name||snapshot?.state_epoch!==value?.state_epoch){actionError="";storedShown=false;byId("purek-error").hidden=true;}
    if(snapshot?.state_epoch&&value?.state_epoch&&snapshot.state_epoch!==value.state_epoch){officialUrl="";officialOwner="";retiredEpochs.add(snapshot.state_epoch);while(retiredEpochs.size>16)retiredEpochs.delete(retiredEpochs.values().next().value);}
    snapshot=value;if(state.data)state.data.purek=value;
  }
  function applyAssistance(value){
    if(!value||value.host_epoch!==snapshot?.state_epoch||!Number.isSafeInteger(value.revision)||!Array.isArray(value.devices))return;
    if(value.revision<snapshot.revision||(value.host_epoch===assistance.host_epoch&&value.revision<assistance.revision))return;
    assistance=value;
  }
  const active=()=>["pending","approval_pending","accepted","authorization_pending","connecting","error"].includes(assistance.session?.status);
  const candidateKey=()=>assistance.authorization_link_available===true&&assistance.session?`${assistance.host_epoch}:${assistance.session.request_id}`:"";
  // Decision 2: next's pipeline test result also reports R1's receiver-free
  // mux -> loopback -> sample B check (cast.pipeline_result, Rust-owned).
  function paintPipelineCheck(){
    const button=document.querySelector('[data-media-output="settings"] .media-output-pipeline-test');
    if(!button)return;
    let line=button.parentElement.querySelector(".media-output-pipeline-check");
    if(!line){line=document.createElement("p");line.className="media-output-pipeline-check";line.setAttribute("role","status");button.after(line);}
    const running=cast().pipeline_running===true,result=cast().pipeline_result;
    let value="";
    if(running)value=t("mediaOutput.pipelineCheck.running");
    else if(result?.ok===true)value=t(result.sample_b==="verified"?"mediaOutput.pipelineCheck.passed":"mediaOutput.pipelineCheck.passedNoSample");
    // Stopping the pipeline test early cancels the check; that is not a failure.
    else if(result&&result.ok===false&&result.code!=="cast_cancelled")value=t("mediaOutput.pipelineCheck.failed",{reason:castError(result.code)});
    line.hidden=!value;text(line,value);
  }
  function paint(){
    paintPipelineCheck();
    const connected=snapshot?.connected===true,output=snapshot?.output;
    if(connected||officialOwner&&officialOwner!==candidateKey()){officialUrl="";officialOwner="";}
    byId("purek-output").hidden=!connected;
    byId("purek-output-name").textContent=connected?`${t("purek.title")} · ${snapshot.room_name||""}`:"";
    const recovery=assistance.recovery?.available===true;
    byId("ktv-host-room-status").textContent=t(connected?"purek.connected":recovery?"ktv.recoveryAvailable":snapshot?.room_name?"ktv.room.authorization_pending":"ktv.room.disconnected");
    const entryKey=connected?(mobile?"purek.manage":"purek.disconnect"):mobile?(snapshot?.room_name?"purek.manage":"ktv.scan"):"ktv.requestScan";
    byId("purek-open").setAttribute("aria-haspopup",connected&&!mobile?"false":"dialog");
    byId("purek-open").dataset.i18n=entryKey;byId("purek-open").textContent=t(entryKey);byId("purek-open").disabled=pending||snapshot?.busy===true;
    const dialogKey=snapshot?.connected?"purek.manage":mobile?(snapshot?.room_name?"purek.title":"ktv.scan"):"ktv.selectDevice";
    byId("purek-dialog-title").dataset.i18n=dialogKey;byId("purek-dialog-title").textContent=t(dialogKey);
    const help=byId("purek-dialog-acquisition-help");help.dataset.i18n=mobile?"ktv.hostLocalHelp":"ktv.hostHelp";help.textContent=t(help.dataset.i18n);
    byId("purek-authorization-step").hidden=!snapshot?.room_name;
    byId("purek-room-name").textContent=snapshot?.room_name||"";
    const reason={purek_output_no_av_transport:"noAvTransport",purek_output_no_video_format:"noVideoFormat",purek_output_validation_required:"validationRequired",purek_output_context_changed:"contextChanged",purek_output_interrupted:"interrupted",purek_output_not_requested:"notRequested",purek_output_request_rejected:"requestRejected",purek_output_no_delivery:"noDelivery"}[output?.last_error];
    const label=reason||(["starting","streaming","paused","stopped","probing","unverified"].includes(output?.status)?output.status:output?.status==="error"?(output.last_error?.startsWith("purek_output_")?"pipelineFailed":"probeFailed"):"authorized");
    const brief={noAvTransport:"purek.outputBrief.noAvTransport",noVideoFormat:"purek.outputBrief.noVideoFormat",contextChanged:"mediaOutput.status.stopped",interrupted:"mediaOutput.status.error",notRequested:"mediaOutput.status.error",requestRejected:"mediaOutput.status.error",noDelivery:"mediaOutput.status.error",pipelineFailed:"mediaOutput.status.error",probeFailed:"mediaOutput.status.unverified",validationRequired:"mediaOutput.status.authorized"}[label]||`mediaOutput.status.${label}`;
    byId("purek-output-status").hidden=!connected;
    byId("purek-output-status").textContent=t(snapshot?.connection_type==="dlna"&&["authorized","validationRequired"].includes(label)?"purek.connected":brief);
    byId("purek-output-details").hidden=!connected;byId("purek-output-details").textContent=t(
      connected&&state.data?.media_output?.available===false&&output?.status!=="error"
        ?"mediaOutput.backendUnavailable":`purek.output.${label}`);
    byId("purek-output-hint").hidden=!connected;byId("purek-media-controls").hidden=!connected;
    const probe=byId("purek-probe");probe.hidden=!connected;probe.disabled=pending||snapshot?.busy===true||output?.pipeline_level!=null;
    probe.textContent=t(probe.hasAttribute("aria-busy")?"purek.working":"purek.output.probe");
    const submit=byId("purek-submit");submit.hidden=!snapshot?.room_name||(!connected&&recovery);submit.disabled=pending||snapshot?.busy===true||assistance.session?.status==="connecting"||!connected&&active()&&assistance.candidate_owned!==true;
    submit.textContent=t(pending?"purek.working":connected?"purek.disconnect":officialUrl?"ktv.check":"purek.check");submit.classList.toggle("purek-primary",!connected);
    byId("purek-cancel").hidden=submit.hidden;
    byId("purek-cancel").parentElement.hidden=submit.hidden;
    modal.classList.toggle("is-actions-empty",submit.hidden);
    // Closing is an immediate UI action (AGENTS §5.2): running discovery, scan
    // or checks continue or abort through their own tickets; only the store
    // self-test owns the dialog until it settles.
    byId("purek-close").disabled=selfTest?.busy()||cast().self_test?.running===true;
    // A Remote-assisted check fails on the Host worker; show its stage here too.
    const stored=!connected&&!pending&&String(snapshot?.error_code||"").startsWith("purek_")&&snapshot?.error_stage?snapshot.error_code:"";
    if(actionError||stored){const value=errorText(actionError||stored);if(byId("purek-error").textContent!==value)byId("purek-error").textContent=value;byId("purek-error").hidden=false;storedShown=!actionError;}
    else if(storedShown){byId("purek-error").hidden=true;storedShown=false;}
    byId("ktv-host-local-scan").hidden=!mobile||connected;
    scanner.setDisabled(pending||active()||connected);
    byId("ktv-host-authorization").hidden=connected||!officialUrl&&!candidateKey();
    byId("ktv-host-load-authorization").hidden=!!officialUrl||!candidateKey();
    byId("ktv-host-load-authorization").disabled=pending||snapshot?.busy===true;
    byId("ktv-host-copy-authorization").hidden=!officialUrl;
    byId("ktv-host-copy-authorization").disabled=pending;
    byId("ktv-host-authorization-url").hidden=!officialUrl;
    byId("ktv-host-authorization-url").value=officialUrl;
    byId("purek-dlna-entry").hidden=connected;
    byId("purek-dlna-url").disabled=pending||active();
    byId("purek-dlna-connect").disabled=pending||active();
    byId("purek-address-confirmed").disabled=pending||active();
    const s=assistance.session;
    byId("ktv-host-session").textContent=s?t(s.kind==="resume"&&s.status==="approval_pending"?"ktv.resumeApprovalPending":`ktv.session.${s.status}`):recovery?t("ktv.recoveryAvailable"):"";
    for(const [id,visible]of[["ktv-host-approve",s?.status==="approval_pending"],["ktv-host-reject",s?.status==="approval_pending"],["ktv-host-cancel",active()&&s?.status!=="approval_pending"]]){byId(id).hidden=!visible;byId(id).disabled=pending;}
    byId("ktv-host-approve").textContent=t(s?.kind==="resume"?"ktv.approveResume":connected||state.data?.media_output?.target==="purek"?"ktv.approveReplace":"ktv.approve");
    byId("ktv-host-empty").hidden=mobile||assistance.devices.some(device=>device.scan_eligible===true)||active();
    const list=byId("ktv-host-devices"),existing=new Map([...list.children].map(n=>[n.dataset.connectionId,n]));list.hidden=mobile;
    for(const device of mobile?[]:assistance.devices){
      let button=existing.get(device.connection_id);
      if(!button){button=document.createElement("button");button.type="button";button.className="toolbar-button purek-action";button.dataset.connectionId=device.connection_id;list.append(button);
        button.addEventListener("click",()=>void action(button,async()=>{applyAssistance(await request("/api/ktv/host",{operation:"invite",connection_id:device.connection_id}));}));}
      existing.delete(device.connection_id);
      const text=`${device.name} · ${t(device.transport==="internet"?"ktv.internetConnection":"ktv.localConnection")}`;
      if(button.textContent!==text)button.textContent=text;
      button.disabled=pending||active()||device.scan_eligible!==true;
    }
    for(const node of existing.values())node.remove();
    paintReceivers();
  }
  const errorKey=code=>["camera_secure","camera_permission","qr_image","clipboard"].includes(code)?`ktv.error.${code}`
      :code.startsWith("purek_")&&["qr_invalid","qr_required","authorization","network","http","identity_changed","busy","protocol","renderer"].includes(code.slice(6))?`purek.error.${code.slice(6)}`:`ktv.error.${code.startsWith("ktv_")&&["busy","offline","stale","confirmation_required","secure_transport_required","scan_required","resume_unavailable","receiver_connected"].includes(code.slice(4))?code.slice(4):"failed"}`;
  // Host-only stage and stable code for support reports; never addresses or URLs.
  const errorText=code=>{
    const stage=snapshot?.error_code===code&&["route","description","connection_manager","authorization","revalidation","health_check"].includes(snapshot?.error_stage)?snapshot.error_stage:"";
    return code.startsWith("cast_")?castError(code):code.startsWith("purek_")?`${t(errorKey(code))} (${stage?`${t(`purek.stage.${stage}`)} · `:""}${code})`:t(errorKey(code));
  };
  let actionError="",storedShown=false;
  function showError(error){
    if(error?.name==="AbortError")return;
    const code=String(error?.code||"");
    if(["camera_secure","camera_permission","qr_image"].includes(code)){scanner.stop();}
    actionError=code;
    byId("purek-error").textContent=errorText(code);byId("purek-error").hidden=false;
  }
  async function action(button,work,{cancel=false}={}){
    if(button.disabled||actions.has(button)||pending&&!cancel)return;
    actions.add(button);pending=true;actionError="";byId("purek-error").hidden=true;
    const wasOpen=opened;
    const disabled=button.disabled;button.disabled=true;button.setAttribute("aria-busy","true");paint();
    try{await work();}catch(error){
      if(error?.code==="cast_revision_conflict")try{await refresh();}catch{/* Retain the original actionable error. */}
      if(!wasOpen||opened)showError(error);
    }
    finally{actions.delete(button);pending=actions.size>0||networkRequestPending;button.disabled=disabled;button.removeAttribute("aria-busy");paint();syncPresentation();}
  }
  function show(){
    if(opened||!snapshot)return;opened=true;previousFocus=document.activeElement;
    // The critical banner region (e.g. the startup session choice) paints above
    // dialogs and must stay operable. An inert ancestor cannot be undone below
    // it, so inert the app shell's other children instead of the whole shell.
    const banner=document.getElementById("critical-banner-region"),shell=banner?.parentElement;
    inert=[...document.body.children].filter(n=>n!==modal&&!["SCRIPT","STYLE","LINK"].includes(n.tagName))
      .flatMap(n=>n===shell?[...n.children].filter(child=>child!==banner):[n]).map(n=>[n,n.inert]);inert.forEach(([n])=>{n.inert=true;});
    modal.classList.remove("hidden");paint();byId("purek-close").focus({preventScroll:true});window.BilikaraHostWindow?.postMessage("purek-open");
  }
  function close({force=false}={}){if(!opened||(selfTest?.busy()||cast().self_test?.running)&&!force)return;stopScan();officialUrl="";officialOwner="";byId("ktv-host-authorization-url").value="";actionError="";storedShown=false;byId("purek-error").hidden=true;closeCacheAdvancedInfo();opened=false;modal.classList.add("hidden");inert.forEach(([n,v])=>{n.inert=v;});inert=[];previousFocus?.focus({preventScroll:true});window.BilikaraHostWindow?.postMessage("purek-close");}
  async function openScanner(){
    if(!opened||!mobile||active()||snapshot?.connected||pending)return;
    await action(byId("purek-open"),()=>scanner.open());
  }
  byId("purek-open").addEventListener("click",()=>{if(snapshot?.connected&&!mobile){void action(byId("purek-open"),()=>castAction("disconnect"));return;}show();if(mobile&&!snapshot?.room_name)void openScanner();if(!mobile)void action(byId("purek-open"),async()=>{const r=await fetch("/api/ktv/host",{cache:"no-store"});const p=await r.json();if(!r.ok||!p.ok)throw Error();applyAssistance(p.data);});});
  byId("purek-output-manage").addEventListener("click",()=>{state.presentationSettingsOpen=false;syncPresentationPanelVisibility();show();});
  byId("purek-close").addEventListener("click",close);byId("purek-cancel").addEventListener("click",close);
  let backdrop=false;
  modal.addEventListener("pointerdown",event=>{backdrop=event.target===modal;});
  modal.addEventListener("pointercancel",()=>{backdrop=false;});
  modal.addEventListener("click",event=>{if(backdrop&&event.target===modal&&!pending&&assistance.session?.status!=="approval_pending"&&!(officialUrl&&!snapshot?.connected))close();backdrop=false;});
  byId("ktv-host-load-authorization").addEventListener("click",()=>void action(byId("ktv-host-load-authorization"),async()=>{
    const owner=candidateKey(),ticket=localLife,s=assistance.session;
    if(!opened||!owner||!s)return;
    const result=await request("/api/ktv/host",{operation:"authorization_link",request_id:s.request_id,host_epoch:assistance.host_epoch});
    if(ticket!==localLife||!opened||candidateKey()!==owner)return;
    if(!window.BilikaraKtvScanner.validOfficial(result.authorization_url))throw Object.assign(new Error(),{code:"ktv_scan_required"});
    officialUrl=result.authorization_url;officialOwner=owner;
  }));
  byId("ktv-host-copy-authorization").addEventListener("click",()=>void action(byId("ktv-host-copy-authorization"),async()=>{
    if(!officialUrl)return;
    try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(officialUrl);
      else{const input=byId("ktv-host-authorization-url");input.focus();input.select();if(!document.execCommand("copy"))throw Error();}setAppMessage(t("purek.authorizationCopied"));}
    catch{throw Object.assign(new Error(),{code:"clipboard"});}
  }));
  document.addEventListener("visibilitychange",()=>{if(document.hidden&&!scanner.waitingForAndroidPermission())stopScan();});
  window.addEventListener("pagehide",()=>{localLife++;scanner.stop();officialUrl="";officialOwner="";byId("ktv-host-authorization-url").value="";});
  byId("ktv-host-pair").addEventListener("click",event=>{event.stopPropagation();close();window.BilikaraHostLayout?.selectPage?.("playback");document.querySelector('[data-android-page="playback"]')?.click();setRemoteQrPinned(true);});
  for(const [id,operation]of[["ktv-host-approve","approve"],["ktv-host-reject","decline"],["ktv-host-cancel","cancel"]])byId(id).addEventListener("click",()=>void action(byId(id),async()=>{
    const s=assistance.session;if(!s)return;
    const command=operation==="approve"&&s.kind==="resume"?"approve_resume":operation;
    applyAssistance(await request("/api/ktv/host",{operation:command,request_id:s.request_id,host_epoch:snapshot.state_epoch,...(command==="approve"?{replace_connected:snapshot.connected===true||state.data?.media_output?.target==="purek"}:{})}));
  }));
  byId("purek-submit").addEventListener("click",()=>void action(byId("purek-submit"),async()=>{
    const s=assistance.session;
    if(!snapshot.connected&&active()){
      if(assistance.candidate_owned!==true||!["authorization_pending","error"].includes(s?.status))return;
      applyAssistance(await request("/api/ktv/host",{operation:"check",request_id:s.request_id,host_epoch:assistance.host_epoch}));
    }else await castAction(snapshot.connected?"disconnect":"connect",snapshot.connected?{}:{address_confirmed:byId("purek-address-confirmed").checked});
  }));
  byId("purek-probe").addEventListener("click",()=>void action(byId("purek-probe"),()=>castAction("probe")));
  byId("purek-dlna-form").addEventListener("submit",event=>{
    event.preventDefault();
    if(pending||!opened||snapshot?.connected||active())return;
    void action(byId("purek-dlna-connect"),async()=>{
      stopScan();
      const ticket=localLife;
      const prepared=await prepareLocal(byId("purek-dlna-url").value.trim(),{manual:true});
      // Rust classifies and validates the address; official Pure K flows keep
      // their existing authorization step and never take this direct path.
      if(ticket===localLife&&opened&&prepared?.connection_type==="dlna")await castAction("connect");
    });
  });
  byId("cast-discover").addEventListener("click",event=>void action(event.currentTarget,()=>castAction("discover")));
  byId("cast-cancel-operation").addEventListener("click",event=>void action(event.currentTarget,()=>castAction("disconnect"),{cancel:true}));
  byId("cast-devices").addEventListener("click",event=>{
    const button=event.target.closest("button"),row=button?.closest("[data-cast-device]");
    if(!row||button.disabled)return;
    if(button.hasAttribute("data-cast-compatibility-test")){selfTest?.open(button,row.dataset.castDevice);return;}
    void action(button,()=>button.dataset.castMode?setDeviceMode(row.dataset.castDevice,button.dataset.castMode)
      :button.dataset.castPicture?setDeviceMode(row.dataset.castDevice,button.dataset.castPicture,"cast.set_device_picture","picture")
      :castAction("connect",{device_key:row.dataset.castDevice}));
  });
  document.addEventListener("keydown",event=>{
    if(!opened)return;
    if(document.getElementById("cast-self-test")?.open)return;
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(modal.querySelector(".cache-advanced-info.is-visible"))closeCacheAdvancedInfo();else close();return;}
    if(event.key!=="Tab")return;
    const nodes=[...modal.querySelectorAll("button,input,select,[tabindex='0']")].filter(n=>!n.disabled&&n.getClientRects().length),first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    else if(!modal.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}
  },true);
  selfTest=window.BilikaraCastSelfTest?.create({snapshot:()=>state.data,translate:t,post:request,refresh,
    closePhysical,disconnect:payload=>castAction("disconnect",payload),castBusy:()=>pending||castWorking(),
    physicalBusy:()=>state.presentationControlBusy||["activating","recovering"].includes(state.presentationSession?.phase),
    selfTestAvailable:()=>Boolean(cast().self_test),error:message=>setAppMessage(message,true),
    getReport:async()=>{const response=await fetch("/api/cast/self-test/report",{cache:"no-store"}),value=await response.json();if(!response.ok||!value.ok)throw value;return value.data;},
    saveReport:()=>saveTauriBackendDownload("/api/cast/self-test/download"),
    copyReport:value=>window.BilikaraDiagnosticsCopy.copyText(value,{fallbackMessage:t("service.diagnosticsFailed")})});
  document.addEventListener("bilikara:i18n",paint);new MutationObserver(position).observe(document.documentElement,{attributes:true,attributeFilter:["data-host-layout"]});position();
  window.BilikaraPureK={close,syncPresentation,requestOutput,settleOutput,sync(value){paintPipelineCheck();if(stale(value)){if(state.data)state.data.purek=snapshot;return;}apply(value||null);section.hidden=!snapshot;if(!snapshot){close({force:true});wake();return;}
    applyAssistance(state.data?.ktv_assistance);paint();syncPresentation();if(assistance.session?.status==="approval_pending")show();}};
})();
