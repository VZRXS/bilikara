// Host presentation and local acquisition. Room validation, official
// authorization, permissions, registration and output remain in Rust.
(() => {
  "use strict";
  const byId=id=>document.getElementById(id), section=byId("purek-settings"),modal=byId("purek-modal");
  if(!section||!modal)return;
  const anchor=document.createComment("desktop room settings position");section.before(anchor);
  let snapshot=null, assistance={devices:[],session:null},pending=false,opened=false,previousFocus=null,inert=[];
  const retiredEpochs=new Set();
  const request=(route,body={})=>apiPost(route,body,{timeoutMs:25000});
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
    const response=await fetch("/api/purek/state",{cache:"no-store"}),payload=await response.json();
    if(!response.ok||payload.ok!==true)throw Error();
    if(ticket!==localLife||!opened){officialUrl="";return;}
    apply(payload.data);
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
  function paint(){
    const connected=snapshot?.connected===true,output=snapshot?.output;
    if(connected||officialOwner&&officialOwner!==candidateKey()){officialUrl="";officialOwner="";}
    byId("purek-output").hidden=!connected;
    byId("purek-output-name").textContent=connected?`${t("purek.title")} · ${snapshot.room_name||""}`:"";
    const recovery=assistance.recovery?.available===true;
    byId("ktv-host-room-status").textContent=t(connected?"purek.connected":recovery?"ktv.recoveryAvailable":snapshot?.room_name?"ktv.room.authorization_pending":"ktv.room.disconnected");
    const entryKey=connected?(mobile?"purek.manage":"purek.disconnect"):mobile?(snapshot?.room_name?"purek.manage":"ktv.scan"):"ktv.requestScan";
    byId("purek-open").setAttribute("aria-haspopup",connected&&!mobile?"false":"dialog");
    byId("purek-open").dataset.i18n=entryKey;byId("purek-open").textContent=t(entryKey);byId("purek-open").disabled=pending||snapshot?.busy===true;
    const dialogKey=mobile?(snapshot?.room_name?"purek.title":"ktv.scan"):"ktv.selectDevice";
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
    byId("purek-close").disabled=pending;
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
  }
  const errorKey=code=>["camera_secure","camera_permission","qr_image","qr_format","clipboard"].includes(code)?`ktv.error.${code}`
      :code.startsWith("purek_")&&["qr_invalid","qr_required","authorization","network","http","identity_changed","busy","protocol","renderer"].includes(code.slice(6))?`purek.error.${code.slice(6)}`:`ktv.error.${code.startsWith("ktv_")&&["busy","offline","stale","confirmation_required","secure_transport_required","scan_required","resume_unavailable","receiver_connected"].includes(code.slice(4))?code.slice(4):"failed"}`;
  // Host-only stage and stable code for support reports; never addresses or URLs.
  const errorText=code=>{
    const stage=snapshot?.error_code===code&&["route","description","connection_manager","authorization","revalidation","health_check"].includes(snapshot?.error_stage)?snapshot.error_stage:"";
    return code.startsWith("purek_")?`${t(errorKey(code))} (${stage?`${t(`purek.stage.${stage}`)} · `:""}${code})`:t(errorKey(code));
  };
  let actionError="",storedShown=false;
  function showError(error){
    if(error?.name==="AbortError")return;
    const code=String(error?.code||"");
    if(["camera_secure","camera_permission","qr_image"].includes(code)){scanner.stop();}
    actionError=code;
    byId("purek-error").textContent=errorText(code);byId("purek-error").hidden=false;
  }
  async function action(button,work){
    if(pending)return;pending=true;actionError="";byId("purek-error").hidden=true;
    const disabled=button.disabled;button.disabled=true;button.setAttribute("aria-busy","true");paint();
    try{await work();}catch(error){showError(error);}
    finally{pending=false;button.disabled=disabled;button.removeAttribute("aria-busy");paint();}
  }
  function show(){
    if(opened||!snapshot)return;opened=true;previousFocus=document.activeElement;
    inert=[...document.body.children].filter(n=>n!==modal&&!["SCRIPT","STYLE","LINK"].includes(n.tagName)).map(n=>[n,n.inert]);inert.forEach(([n])=>{n.inert=true;});
    modal.classList.remove("hidden");paint();byId("purek-close").focus({preventScroll:true});window.BilikaraHostWindow?.postMessage("purek-open");
  }
  function close({force=false}={}){if(!opened||pending&&!force)return;stopScan();officialUrl="";officialOwner="";byId("ktv-host-authorization-url").value="";closeCacheAdvancedInfo();opened=false;modal.classList.add("hidden");inert.forEach(([n,v])=>{n.inert=v;});inert=[];previousFocus?.focus({preventScroll:true});window.BilikaraHostWindow?.postMessage("purek-close");}
  async function openScanner(){
    if(!opened||!mobile||active()||snapshot?.connected||pending)return;
    await action(byId("purek-open"),()=>scanner.open());
  }
  byId("purek-open").addEventListener("click",()=>{if(snapshot?.connected&&!mobile){void action(byId("purek-open"),async()=>apply(await request("/api/purek/disconnect")));return;}show();if(mobile&&!snapshot?.room_name)void openScanner();if(!mobile)void action(byId("purek-open"),async()=>{const r=await fetch("/api/ktv/host",{cache:"no-store"});const p=await r.json();if(!r.ok||!p.ok)throw Error();applyAssistance(p.data);});});
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
    }else apply(await request(snapshot.connected?"/api/purek/disconnect":"/api/purek/connect"));
  }));
  byId("purek-probe").addEventListener("click",()=>void action(byId("purek-probe"),async()=>apply(await request("/api/purek/output/probe"))));
  byId("purek-dlna-form").addEventListener("submit",event=>{
    event.preventDefault();
    if(pending||!opened||snapshot?.connected||active())return;
    void action(byId("purek-dlna-connect"),async()=>{
      stopScan();
      const ticket=localLife;
      const prepared=await prepareLocal(byId("purek-dlna-url").value.trim(),{manual:true});
      // Rust classifies and validates the address; official Pure K flows keep
      // their existing authorization step and never take this direct path.
      if(ticket===localLife&&opened&&prepared?.connection_type==="dlna")apply(await request("/api/purek/connect"));
    });
  });
  document.addEventListener("keydown",event=>{
    if(!opened)return;
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(modal.querySelector(".cache-advanced-info.is-visible"))closeCacheAdvancedInfo();else close();return;}
    if(event.key!=="Tab")return;
    const nodes=[...modal.querySelectorAll("button,input,select,[tabindex='0']")].filter(n=>!n.disabled&&n.getClientRects().length),first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    else if(!modal.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}
  },true);
  document.addEventListener("bilikara:i18n",paint);new MutationObserver(position).observe(document.documentElement,{attributes:true,attributeFilter:["data-host-layout"]});position();
  window.BilikaraPureK={close,sync(value){if(stale(value)){if(state.data)state.data.purek=snapshot;return;}apply(value||null);section.hidden=!snapshot;if(!snapshot){close({force:true});return;}
    applyAssistance(state.data?.ktv_assistance);paint();if(assistance.session?.status==="approval_pending")show();}};
})();
