// Remote presentation and local acquisition. Rust owns invitations, permissions,
// room credentials and all receiver I/O. Nothing here persists a QR/auth URL.
(() => {
  "use strict";
  const byId=id=>document.getElementById(id),dialog=byId("ktv-remote-modal");if(!dialog)return;
  let view=null,room={status:"disconnected"},officialUrl="",notice="",wantScanner=false,busy=false,requesting=false,restoring=false,life=0,expiry=null,previousFocus=null,scrollY=0,closing=false,ignoredCloses=0;
  const retiredEpochs=new Set(),retiredConnections=new Set(),closedRequests=new Set(),controllers=new Set();
  function remember(set,key,limit=32){set.add(key);while(set.size>limit)set.delete(set.values().next().value);}
  const active=status=>["pending","approval_pending","accepted","authorization_pending","connecting","error"].includes(status);
  const roomStates=new Set(["disconnected","authorization_pending","connecting","connected","capability_unverified","unsupported","error"]);
  const phases=new Set(["pending","approval_pending","accepted","authorization_pending","connecting","error","completed","declined","canceled","expired","disconnected"]);
  const scanner=window.BilikaraKtvScanner.surface({root:byId("ktv-scan-view"),prefix:"ktv",translate:t,
    onCamera:()=>void startScanner(),
    onFile:(file,input)=>{const ticket=life;void action(scanner.gallery,()=>scanner.file(file)).finally(()=>{if(ticket===life)input.value="";});},
    onDecode:raw=>busy?submit(raw):action(byId("ktv-camera"),()=>submit(raw)),onError:showError});
  function binding(){return view?.session?{request_id:view.session.request_id,host_epoch:view.host_epoch}:null;}
  const canScan=()=>view?.capabilities?.scan===true&&room?.connected!==true;
  const ownsCandidate=()=>view?.candidate_owned===true&&["authorization_pending","error"].includes(view?.session?.status);
  function message(code){
    if(code?.startsWith("purek_")&&["qr_invalid","description_invalid","authorization","network","http","identity_changed","busy","protocol","renderer"].includes(code.slice(6)))return t(`purek.error.${code.slice(6)}`);
    const key=String(code||"").replace(/^ktv_/,"");return t(`ktv.error.${["busy","offline","stale","scan_required","resume_unavailable","secure_transport_required","camera_secure","camera_permission","qr_image","clipboard","receiver_connected"].includes(key)?key:"failed"}`);
  }
  function showError(error){if(error?.name==="AbortError")return;const text=message(error?.code);byId("ktv-remote-error").textContent=text;byId("ktv-remote-error").hidden=false;if(!dialog.open)setFormMessage(text,true);}
  function clearPrivate(){officialUrl="";byId("ktv-authorization-url").value="";byId("ktv-open-wechat").removeAttribute("href");byId("ktv-room-url").value="";scanner.stop();}
  const validOfficial = window.BilikaraKtvScanner.validOfficial;
  function paint(){
    const s=view?.session,status=s?.status;
    const label=view?.connection_id?` · ${t(view.transport==="internet"||(!view.transport&&view.confidential)?"ktv.internet":"ktv.lan")} · ${view.connection_id.slice(0,6)}`:"";
    byId("ktv-room-status").textContent=t(view?`ktv.room.${room?.status||"disconnected"}`:"ktv.room.unavailable")+label;
    const locked=busy||restoring,owned=ownsCandidate();
    byId("ktv-session-status").textContent=notice?t(notice):(["pending","accepted"].includes(status)?"":s?t(status==="completed"?`ktv.room.${room?.status||"disconnected"}`:status==="approval_pending"&&s.kind==="resume"?"ktv.resumeApprovalPending":`ktv.session.${status}`):"");
    byId("ktv-invitation").hidden=status!=="pending";
    byId("ktv-scanner").hidden=status!=="accepted"||!canScan();
    byId("ktv-authorization").hidden=!owned||room?.connection_type!=="purek";
    byId("ktv-authorization-url").hidden=!officialUrl;
    byId("ktv-copy-authorization").hidden=!officialUrl;
    byId("ktv-load-authorization").hidden=Boolean(officialUrl);
    byId("ktv-check").hidden=!owned;
    byId("ktv-check").textContent=t(byId("ktv-check").hasAttribute("aria-busy")?"purek.working":officialUrl||room?.connection_type==="purek"?"ktv.check":"purek.check");
    byId("ktv-cancel-session").hidden=!active(status)||status==="pending";
    byId("ktv-secure-fallback").hidden=view?.confidential!==false||!canScan();
    byId("ktv-menu-scan").hidden=room?.connected===true;
    byId("ktv-menu-guidance").textContent=t(room?.connected===true?"ktv.deviceConnected":!view?"ktv.room.unavailable":view.recovery_available?"ktv.recoveryGuide":"ktv.remoteGuide");
    byId("ktv-menu-scan").textContent=t(owned?"ktv.continueAuthorization":"ktv.scan");
    byId("ktv-menu-resume").hidden=view?.capabilities?.resume!==true||!view?.recovery_available||active(status);
    byId("ktv-rescan").hidden=active(status)||!canScan();
    byId("ktv-camera").hidden=status!=="accepted";
    byId("ktv-camera").disabled=locked||!canScan();
    scanner.setDisabled(locked||!canScan()||status!=="accepted");
    byId("ktv-open-wechat").hidden=!officialUrl||!/MicroMessenger/i.test(navigator.userAgent);
    byId("ktv-share-authorization").hidden=!officialUrl||!window.isSecureContext||typeof navigator.share!=="function";
    for(const id of ["ktv-menu-scan","ktv-menu-resume","ktv-accept","ktv-rescan","ktv-import","ktv-submit-url","ktv-copy-authorization","ktv-load-authorization","ktv-share-authorization","ktv-check"])byId(id).disabled=locked||!canScan();
    byId("ktv-decline").disabled=locked;
    const footer=dialog.querySelector(":scope > .ktv-actions");footer.hidden=[...footer.children].every(node=>node.hidden);
    if(s?.error_code&&!locked&&dialog.open)showError({code:s.error_code});
  }
  function open(){
    if(dialog.open)return;
    previousFocus=document.activeElement;scrollY=window.scrollY;
    setRemoteMenuOpen(false);
    document.documentElement.classList.add("ktv-modal-open");dialog.showModal();byId("ktv-remote-close").focus({preventScroll:true});
  }
  function cleanupModal(restore){
    closeRemoteContextualInfo();
    clearTimeout(expiry);expiry=null;life++;wantScanner=false;busy=false;requesting=false;notice="";
    for(const node of [byId("ktv-menu-scan"),byId("ktv-menu-resume"),...dialog.querySelectorAll("button")])if(node.__ktvAction){delete node.__ktvAction;node.removeAttribute("aria-busy");}
    for(const controller of controllers)controller.abort();controllers.clear();clearPrivate();
    document.documentElement.classList.remove("ktv-modal-open");
    if(restore){window.scrollTo({top:scrollY,behavior:"instant"});const target=previousFocus?.getClientRects().length&&!previousFocus.closest("[inert]")?previousFocus:byId("remote-menu-toggle");target?.focus({preventScroll:true});}paint();
  }
  async function post(operation,fields={},signal){
    const controller=signal?null:new AbortController();if(controller)controllers.add(controller);
    const timer=controller?setTimeout(()=>controller.abort(),25000):null;
    try{
      const response=await fetch("/api/ktv/remote",{method:"POST",credentials:"same-origin",cache:"no-store",headers:clientHeaders({"Content-Type":"application/json"}),
        body:JSON.stringify({connection_id:view?.connection_id||"",request:{operation,...fields}}),signal:signal||controller.signal});
      const payload=await response.json();if(!response.ok||!payload.ok)throw Object.assign(new Error("KTV request failed"),{code:payload.code});
      return payload.data;
    }finally{if(controller)controllers.delete(controller);clearTimeout(timer);}
  }
  function exit(notify=true){
    if(closing)return;closing=true;
    const bound=binding(),status=view?.session?.status;
    if(notify&&bound&&active(status))remember(closedRequests,bound.request_id);
    const wasOpen=dialog.open;if(wasOpen){ignoredCloses++;dialog.close();}cleanupModal(wasOpen);closing=false;
    if(notify&&bound&&active(status))void post(status==="pending"?"ktv.scan.decline":"ktv.scan.cancel",bound).then(presence).catch(()=>{});
  }
  function disconnected(){
    if(view?.connection_id)remember(retiredConnections,view.connection_id);
    restoring=false;
    view=null;if(dialog.open)exit(false);else cleanupModal(false);
    paint();
  }
  function presence(next){
    if(!next||!(/^[a-f0-9]{64}$/).test(next.connection_id)||!(/^[a-zA-Z0-9_-]{1,128}$/).test(next.host_epoch)||!Number.isSafeInteger(next.revision)||next.revision<0||!roomStates.has(next.room?.status))return;
    if(next.session&&(!(/^[a-f0-9]{64}$/).test(next.session.request_id)||next.session.connection_id!==next.connection_id||!phases.has(next.session.status)||!Number.isInteger(next.session.remaining_seconds)||next.session.remaining_seconds<0||next.session.remaining_seconds>300))return;
    if(retiredEpochs.has(next.host_epoch)||retiredConnections.has(next.connection_id))return;
    if(closedRequests.has(next.session?.request_id)&&active(next.session?.status))return;
    if(view&&next.host_epoch===view.host_epoch&&next.connection_id===view.connection_id&&next.revision<view.revision)return;
    const connectionChanged=view&&(view.connection_id!==next.connection_id||view.host_epoch!==next.host_epoch);
    if(view&&next.host_epoch!==view.host_epoch)remember(retiredEpochs,view.host_epoch,16);
    const changed=view?.session?.request_id!==next.session?.request_id||connectionChanged;
    if(connectionChanged){remember(retiredConnections,view.connection_id);if(dialog.open)exit(false);else cleanupModal(false);}
    else if(changed){clearPrivate();if(view&&!requesting){if(dialog.open)exit(false);else cleanupModal(false);}}
    if(changed||view?.session?.status!==next.session?.status){notice="";byId("ktv-remote-error").hidden=true;}
    const {authorization_url,...safe}=next;view=safe;room=next.room||room;restoring=false;
    clearTimeout(expiry);expiry=null;
    if(active(next.session?.status)){
      const id=next.session.request_id;
      expiry=setTimeout(()=>{expiry=null;if(view?.session?.request_id===id)void refreshView();},Math.max(1000,((Number(next.session.remaining_seconds)||0)+1)*1000));
    }else if(next.session){clearPrivate();}
    if(next.session?.status==="pending")open();
    else if(wantScanner&&next.session?.status==="accepted")openScanner();
    paint();
  }
  function openScanner(){wantScanner=false;byId("ktv-remote-error").hidden=true;open();paint();}
  async function action(button,work){
    if(busy)return;busy=true;const ticket=life,wasDisabled=button.disabled;
    notice="";
    const owner={};button.__ktvAction=owner;
    byId("ktv-remote-error").hidden=true;button.disabled=true;button.setAttribute("aria-busy","true");paint();
    try{await work();}catch(error){if(ticket===life)showError(error);}
    finally{if(ticket===life)busy=false;if(button.__ktvAction===owner){delete button.__ktvAction;button.removeAttribute("aria-busy");button.disabled=wasDisabled;}paint();}
  }
  async function submit(raw){
    scanner.stop();
    if(view?.session?.status!=="accepted")throw Object.assign(new Error(),{code:"ktv_stale"});
    if(!canScan()||view?.capabilities?.submit!==true){scanner.stop();byId("ktv-room-url").value="";throw Object.assign(new Error(),{code:"ktv_stale"});}
    const ticket=life,bound=binding();
    // Never call the transport with pixels, filenames, blobs or image data.
    const result=await post("ktv.scan.submit",{...bound,url:raw});
    if(ticket!==life||binding()?.request_id!==bound.request_id)return;presence(result);
    if(binding()?.request_id!==bound.request_id)return;
    officialUrl=validOfficial(result.authorization_url)?result.authorization_url:"";
    byId("ktv-authorization-url").value=officialUrl;
    if(officialUrl)byId("ktv-open-wechat").href=officialUrl;
    byId("ktv-room-url").value="";paint();
  }
  byId("ktv-menu-toggle").addEventListener("click",()=>{
    const toggle=byId("ktv-menu-toggle"),expanded=toggle.getAttribute("aria-expanded")!=="true";
    toggle.setAttribute("aria-expanded",String(expanded));toggle.classList.toggle("is-expanded",expanded);byId("ktv-menu-content").classList.toggle("hidden",!expanded);syncRemoteMenuBounds();
    if(expanded)void refreshView();
  });
  async function beginAssistance(resume=false){
    if(!canScan())throw Object.assign(new Error(),{code:"ktv_stale"});
    if(resume&&view?.capabilities?.resume!==true)throw Object.assign(new Error(),{code:"ktv_resume_unavailable"});
    const ticket=life,connection=view?.connection_id;
    if(!resume&&active(view?.session?.status)){await refreshView();if(ticket===life&&connection===view?.connection_id){open();paint();}return;}
    wantScanner=!resume;requesting=true;
    try{const next=await post(resume?"ktv.authorization.resume.request":"ktv.scan.request");if(ticket!==life||connection!==view?.connection_id)return;presence(next);open();}
    finally{if(ticket===life)requesting=false;}
  }
  for(const id of["ktv-menu-scan","ktv-rescan"])byId(id).addEventListener("click",()=>void action(byId(id),()=>beginAssistance()));
  byId("ktv-menu-resume").addEventListener("click",()=>void action(byId("ktv-menu-resume"),()=>beginAssistance(true)));
  byId("ktv-accept").addEventListener("click",()=>void action(byId("ktv-accept"),async()=>{const ticket=life,bound=binding();wantScanner=true;const result=await post("ktv.scan.accept",bound);if(ticket!==life||binding()?.request_id!==bound?.request_id)return;presence(result);if(view?.session?.status==="accepted")openScanner();}));
  byId("ktv-decline").addEventListener("click",()=>exit(true));byId("ktv-remote-close").addEventListener("click",()=>exit(true));byId("ktv-cancel-session").addEventListener("click",()=>exit(true));
  dialog.addEventListener("cancel",event=>{event.preventDefault();exit(true);});dialog.addEventListener("close",()=>{if(ignoredCloses){ignoredCloses--;return;}exit(true);});
  // Native dialogs can stack above an existing export/rating modal. Its older
  // document listener must not trap focus or consume this dialog's Escape.
  document.addEventListener("keydown",event=>{
    if(!dialog.open||!["Escape","Tab"].includes(event.key))return;
    event.stopImmediatePropagation();
    if(event.key==="Escape"){event.preventDefault();if(dialog.querySelector('.info-trigger-wrap.is-visible'))closeRemoteContextualInfo();else exit(true);}
    else trapFocusWithin(dialog,event,byId("ktv-remote-close"));
  },true);
  async function startScanner(){
    if(!canScan()||view?.session?.status!=="accepted")return;
    await action(byId("ktv-camera"),()=>scanner.open());
  }
  byId("ktv-camera").addEventListener("click",()=>void startScanner());
  byId("ktv-submit-url").addEventListener("click",()=>void action(byId("ktv-submit-url"),()=>submit(byId("ktv-room-url").value.trim())));
  byId("ktv-room-url").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();byId("ktv-submit-url").click();}});
  byId("ktv-check").addEventListener("click",()=>void action(byId("ktv-check"),async()=>presence(await post("ktv.authorization.check",binding()))));
  byId("ktv-load-authorization").addEventListener("click",()=>void action(byId("ktv-load-authorization"),async()=>{
    const ticket=life,bound=binding(),result=await post("ktv.authorization.link.get",bound);
    if(ticket!==life||binding()?.request_id!==bound?.request_id||!ownsCandidate())return;
    officialUrl=validOfficial(result.authorization_url)?result.authorization_url:"";
    byId("ktv-authorization-url").value=officialUrl;
    if(officialUrl)byId("ktv-open-wechat").href=officialUrl;
  }));
  byId("ktv-copy-authorization").addEventListener("click",()=>void action(byId("ktv-copy-authorization"),async()=>{
    if(!officialUrl)return;
    try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(officialUrl);
      else{const input=byId("ktv-authorization-url");input.focus();input.select();if(!document.execCommand("copy"))throw Error();}}
    catch{throw Object.assign(new Error(),{code:"clipboard"});}
    notice="purek.authorizationCopied";
  }));
  byId("ktv-share-authorization").addEventListener("click",()=>void action(byId("ktv-share-authorization"),async()=>{if(officialUrl)await navigator.share({url:officialUrl});}));
  new MutationObserver(()=>{if(byId("remote-menu-panel").classList.contains("hidden")){byId("ktv-menu-toggle").setAttribute("aria-expanded","false");byId("ktv-menu-toggle").classList.remove("is-expanded");byId("ktv-menu-content").classList.add("hidden");}}).observe(byId("remote-menu-panel"),{attributes:true,attributeFilter:["class"]});
  document.addEventListener("bilikara:i18n",paint);
  window.addEventListener("bilikara:ktv-disconnected",disconnected);
  async function refreshView(){
    if(!view&&window.BilikaraRemoteTransport?.mode!=="internet")return;
    const ticket=life,connection=view?.connection_id;
    try{const next=await post("ktv.status.get");if(ticket===life)presence(next);}
    catch(error){if(error?.name!=="AbortError"&&ticket===life&&view?.connection_id===connection)disconnected();}
  }
  function suspendPage(){
    restoring=true;
    const wasOpen=dialog.open;if(wasOpen){ignoredCloses++;dialog.close();}
    cleanupModal(wasOpen);
  }
  document.addEventListener("visibilitychange",()=>{if(document.hidden)scanner.stop();else void refreshView();});
  window.BilikaraKtvRemote=Object.freeze({presence,disconnected,suspendPage,restorePage:refreshView,room(value){if(roomStates.has(value?.status))room=value;paint();}});paint();
})();
