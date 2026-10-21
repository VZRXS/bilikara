// UI / image acquisition only. QR policy, registration and live room state are
// Rust-owned. No token is stored in localStorage, history or diagnostics.
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const request = (route, body = {}) => apiPost(route, body, {timeoutMs:25000});
  const section = byId("purek-settings"), modal = byId("purek-modal");
  if (!section || !modal) return;
  const anchor = document.createComment("desktop room settings position");
  section.before(anchor);
  const openButton = byId("purek-open");
  const submit = byId("purek-submit"), url = byId("purek-url"), image = byId("purek-image");
  const camera = byId("purek-camera"), cameraImage = byId("purek-camera-image");
  const imageSource = byId("purek-image-source");
  let snapshot = null, prepared = null, pending = false, opened = false;
  let previousFocus = null, inert = [];
  function stale(value) {
    return typeof value?.state_epoch === "string" && value.state_epoch === snapshot?.state_epoch
      && Number.isSafeInteger(value.revision) && Number.isSafeInteger(snapshot?.revision)
      && value.revision < snapshot.revision;
  }
  function applyResponse(value) {
    if (stale(value)) return;
    snapshot = value;
    // Keep the accepted Rust projection visible during language-only renders,
    // before the next SSE snapshot arrives.
    if (state.data) state.data.purek = value;
  }
  function position() {
    const android = document.documentElement.dataset.hostPlatform === "android";
    camera.hidden = !android;
    byId("purek-drop-hint").hidden = android;
    const phone = android
      && document.documentElement.dataset.hostLayout === "portrait";
    const destination = phone ? byId("android-my-scroll") : anchor.parentElement;
    if (phone && section.parentElement !== destination) destination.append(section);
    else if (!phone && anchor.nextSibling !== section) anchor.after(section);
    section.classList.toggle("android-my-card", phone);
  }
  function showError(error) {
    const code = String(error?.code || "").replace(/^purek_/, "");
    const key = ["qr_invalid","qr_image","qr_required","description_invalid","authorization","network","http","identity_changed","busy","protocol","renderer"].includes(code) ? code : "network";
    byId("purek-error").textContent = t(`purek.error.${key}`);
    byId("purek-error").hidden = false;
  }
  function clearError() { byId("purek-error").hidden = true; }
  function paint() {
    const connected = snapshot?.connected === true;
    byId("purek-output").hidden = !connected;
    byId("purek-output-name").textContent = connected ? `${t("purek.title")} · ${snapshot.room_name || ""}` : "";
    openButton.textContent = t(connected ? "purek.connected" : "purek.connectShort");
    openButton.setAttribute("aria-label",t(connected ? "purek.manage" : "purek.connect"));
    openButton.disabled = pending || snapshot?.busy === true;
    byId("purek-input-step").hidden = Boolean(prepared || connected);
    byId("purek-authorization-step").hidden = !prepared && !connected;
    byId("purek-room-name").textContent = prepared?.room_name || snapshot?.room_name || "";
    byId("purek-authorize").hidden = connected || !prepared?.authorization_url;
    byId("purek-input-hint").hidden = Boolean(prepared || connected);
    byId("purek-auth-hint").hidden = connected || !prepared;
    byId("purek-auth-hint").textContent = t(prepared?.connection_type === "dlna" ? "purek.dlnaHint" : "purek.authHint");
    byId("purek-output-hint").hidden = !connected;
    byId("purek-output-details").hidden = !connected;
    byId("purek-media-controls").hidden = !connected;
    const output = snapshot?.output;
    const reason = {
      purek_output_no_av_transport:"noAvTransport",
      purek_output_no_video_format:"noVideoFormat",
      purek_output_validation_required:"validationRequired",
      purek_output_context_changed:"contextChanged",
      purek_output_interrupted:"interrupted",
    }[output?.last_error];
    const outputLabel = reason || (["starting","streaming","paused","stopped","probing","unverified"].includes(output?.status) ? output.status
      : output?.status === "error" ? (output.last_error?.startsWith("purek_output_") ? "pipelineFailed" : "probeFailed") : "authorized");
    byId("purek-output-status").hidden = !connected;
    const brief = {noAvTransport:"purek.outputBrief.noAvTransport",noVideoFormat:"purek.outputBrief.noVideoFormat",
      contextChanged:"mediaOutput.status.stopped",interrupted:"mediaOutput.status.error",pipelineFailed:"mediaOutput.status.error",probeFailed:"mediaOutput.status.unverified",validationRequired:"mediaOutput.status.authorized"}[outputLabel] || `mediaOutput.status.${outputLabel}`;
    byId("purek-output-status").textContent = t(snapshot?.connection_type === "dlna" && ["authorized","validationRequired"].includes(outputLabel) ? "purek.connected" : brief);
    byId("purek-output-details").textContent = t(`purek.output.${outputLabel}`);
    byId("purek-probe").hidden = !connected;
    byId("purek-probe").disabled = pending || snapshot?.busy === true || output?.pipeline_level != null;
    byId("purek-probe").textContent = t(byId("purek-probe").hasAttribute("aria-busy") ? "purek.working" : "purek.output.probe");
    byId("purek-reidentify").hidden = connected;
    submit.textContent = t(pending ? "purek.working" : connected ? "purek.disconnect" : prepared ? (prepared.connection_type === "dlna" ? "purek.connect" : "purek.check") : "purek.continue");
    submit.classList.toggle("purek-primary", !connected);
    submit.disabled = pending || snapshot?.busy === true || (!connected && !prepared && !url.value.trim());
    for (const id of ["purek-import", "purek-camera", "purek-reidentify", "purek-authorize"]) byId(id).disabled = pending;
    url.disabled = pending;
  }
  async function action(button, work) {
    if (pending || snapshot?.busy) return;
    pending = true; clearError();
    const disabled = button.disabled;
    button.disabled = true; button.setAttribute("aria-busy", "true"); paint();
    try { await work(); }
    catch (error) { showError(error); }
    finally {
      pending = false; if (!opened) { prepared = null; url.value = ""; image.value = ""; cameraImage.value = ""; } button.disabled = disabled; button.removeAttribute("aria-busy"); paint();
    }
  }
  function show() {
    if (opened || !snapshot) return;
    opened = true; previousFocus = document.activeElement;
    inert = Array.from(document.body.children).filter(node => node !== modal && !["SCRIPT","STYLE","LINK"].includes(node.tagName)).map(node => [node,node.inert]);
    inert.forEach(([node]) => { node.inert = true; });
    modal.classList.remove("hidden"); clearError(); paint();
    window.BilikaraHostWindow?.postMessage("purek-open");
    byId("purek-close").focus({preventScroll:true});
  }
  function close() {
    if (!opened) return;
    closeCacheAdvancedInfo();
    opened = false; modal.classList.add("hidden");
    imageSource.classList.remove("is-drag-over");
    window.BilikaraHostWindow?.postMessage("purek-close");
    inert.forEach(([node,value]) => { node.inert = value; }); inert = [];
    // Discard the browser's authorization URL when idle; Rust keeps the pending
    // room privately so an in-flight request can still complete consistently.
    if (!pending) { prepared = null; url.value = ""; image.value = ""; cameraImage.value = ""; }
    previousFocus?.focus({preventScroll:true});
  }
  async function prepare(body, route = "prepare") {
    prepared = await request(`/api/purek/${route}`, body);
    url.value = ""; image.value = ""; cameraImage.value = "";
  }
  async function pixels(file) {
    if (!file || file.size > 12*1024*1024 || (file.type && !file.type.startsWith("image/"))) throw {code:"purek_qr_image"};
    const picture = new Image();
    const dataUrl = await new Promise((resolve,reject) => {
      const reader = new FileReader();
      const clear = () => { reader.onload = null; reader.onerror = null; reader.onabort = null; };
      reader.onload = () => { const result = reader.result; clear(); resolve(result); };
      reader.onerror = reader.onabort = () => { clear(); reject({code:"purek_qr_image"}); };
      reader.readAsDataURL(file);
    });
    try {
      await new Promise((resolve,reject) => { picture.onload = resolve; picture.onerror = () => reject({code:"purek_qr_image"}); picture.src = dataUrl; });
      if (!picture.naturalWidth || !picture.naturalHeight || picture.naturalWidth*picture.naturalHeight > 24000000) throw {code:"purek_qr_image"};
      const scale = Math.min(1,576/Math.max(picture.naturalWidth,picture.naturalHeight));
      const width = Math.round(picture.naturalWidth*scale), height = Math.round(picture.naturalHeight*scale);
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0,0,width,height);
      context.drawImage(picture,0,0,width,height);
      const rgba = context.getImageData(0,0,width,height).data;
      const grey = new Uint8Array(width*height);
      for (let i=0;i<grey.length;i++) grey[i] = Math.round(rgba[i*4]*0.299+rgba[i*4+1]*0.587+rgba[i*4+2]*0.114);
      let binary = "";
      for (let i=0;i<grey.length;i+=8192) binary += String.fromCharCode(...grey.subarray(i,i+8192));
      return {width,height,pixels:btoa(binary)};
    } finally { picture.onload = null; picture.onerror = null; picture.src = ""; }
  }
  openButton.addEventListener("click", show);
  byId("purek-output-manage").addEventListener("click", () => { state.presentationSettingsOpen = false; syncPresentationPanelVisibility(); show(); });
  byId("purek-close").addEventListener("click", close);
  byId("purek-cancel").addEventListener("click", close);
  byId("purek-reidentify").addEventListener("click", () => { prepared = null; clearError(); paint(); url.focus(); });
  url.addEventListener("input", paint);
  url.addEventListener("keydown", event => { if (event.key === "Enter" && !submit.disabled) { event.preventDefault(); submit.click(); } });
  byId("purek-import").addEventListener("click", () => { if (!pending) { image.value = ""; image.click(); } });
  image.addEventListener("change", () => { if (image.files[0]) action(byId("purek-import"), async () => prepare(await pixels(image.files[0]),"decode")); });
  camera.addEventListener("click", () => { if (!pending) { cameraImage.value = ""; cameraImage.click(); } });
  cameraImage.addEventListener("change", () => { if (cameraImage.files[0]) action(camera, async () => prepare(await pixels(cameraImage.files[0]),"decode")); });
  // Tauri desktop leaves DOM file dropping enabled. Only this open Host
  // dialog owns image drops; playlist dragging and URL inputs remain separate.
  const desktopFileDrag = event => opened && document.documentElement.dataset.hostPlatform !== "android"
    && Array.from(event.dataTransfer?.types || []).includes("Files");
  const canImport = () => !pending && !snapshot?.busy && !snapshot?.connected && !prepared;
  modal.addEventListener("dragover", event => {
    if (!desktopFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = canImport() ? "copy" : "none";
    imageSource.classList.toggle("is-drag-over", canImport());
  });
  modal.addEventListener("dragleave", event => {
    if (!modal.contains(event.relatedTarget)) imageSource.classList.remove("is-drag-over");
  });
  modal.addEventListener("drop", event => {
    if (!desktopFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); imageSource.classList.remove("is-drag-over");
    if (!canImport()) return;
    const files = event.dataTransfer.files;
    if (files.length !== 1) { showError({code:"purek_qr_image"}); return; }
    action(byId("purek-import"), async () => prepare(await pixels(files[0]),"decode"));
  });
  submit.addEventListener("click", () => action(submit, async () => {
    if (snapshot.connected) { applyResponse(await request("/api/purek/disconnect")); prepared = null; close(); }
    else if (prepared) { applyResponse(await request("/api/purek/connect")); prepared = null; }
    else await prepare({url:url.value.trim()});
  }));
  byId("purek-probe").addEventListener("click", () => action(byId("purek-probe"), async () => {
    applyResponse(await request("/api/purek/output/probe"));
  }));
  byId("purek-authorize").addEventListener("click", () => action(byId("purek-authorize"), async () => {
    const target = prepared?.authorization_url;
    if (!target) return;
    if (document.documentElement.dataset.hostPlatform === "android") {
      if (!window.BilikaraAndroidPlatform?.openRoomAuthorization) throw {code:"purek_authorization"};
      await window.BilikaraAndroidPlatform.openRoomAuthorization(target);
    } else if (document.documentElement.dataset.hostPlatform === "desktop") {
      if (!window.BilikaraDesktopPlatform?.openExternal) throw {code:"purek_authorization"};
      await window.BilikaraDesktopPlatform.openExternal(target);
    } else window.open(target,"_blank","noopener,noreferrer");
  }));
  document.addEventListener("keydown", event => {
    if (!opened) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if(modal.querySelector(".cache-advanced-info.is-visible")) closeCacheAdvancedInfo();
      else close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(modal.querySelectorAll("button,input,select,[tabindex='0']")).filter(node => !node.disabled && node.getClientRects().length);
    const first=focusable[0], last=focusable[focusable.length-1];
    if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); }
    else if (!modal.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
  }, true);
  document.addEventListener("bilikara:i18n", paint);
  new MutationObserver(position).observe(document.documentElement,{attributes:true,attributeFilter:["data-host-layout"]});
  position();
  window.BilikaraPureK = {
    close,
    sync(value) {
      if (stale(value)) {
        if (state.data) state.data.purek = snapshot;
        return;
      }
      if (snapshot?.connected && !value?.connected && value?.error_code) setAppMessage(t("purek.connectionLost"), true);
      snapshot = value || null; section.hidden = !snapshot;
      if (!snapshot) { close(); return; }
      paint();
    },
  };
})();
