// Injected into the native-created main WKWebView at document start. It is not
// loaded by Host HTML or Remote. Native independently verifies every frame.
(function(root, nativeOrigin) {
  "use strict";
  if (root.top !== root || root.location.origin !== nativeOrigin
    || !["/", "/index.html"].includes(root.location.pathname) || root.location.search || root.location.hash) return;
  if (!root.crypto?.getRandomValues) return;
  // Injected only in the exact owned main document, never Remote/login pages.
  function constrainPageScale() {
    const viewport = root.document.querySelector?.('meta[name="viewport"]');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  }
  root.document.addEventListener("DOMContentLoaded", constrainPageScale, {once: true});
  const pipe = () => root.webkit?.messageHandlers?.bilikaraPlatform;
  const newDocumentId = () => Array.from(root.crypto.getRandomValues(new Uint8Array(16)),
    value => value.toString(16).padStart(2, "0")).join("");
  let documentId = newDocumentId();
  const pending = new Map();
  let sequence = 0, retired = false, awaitingLoginReturn = false, leftForLogin = false, refreshAfterRestore = false;
  function notifyDocument(action) {
    try { pipe()?.postMessage(JSON.stringify({schema_version: 1, document_id: documentId, id: 0, action})); }
    catch {}
  }
  notifyDocument("document");
  root.document.addEventListener("DOMContentLoaded", () => notifyDocument("document"), {once: true});
  const documentReady=root.document.readyState==='loading'
    ?new Promise(resolve=>root.document.addEventListener('DOMContentLoaded',resolve,{once:true})):Promise.resolve();
  function cancel(id, generation = documentId) {
    try { pipe()?.postMessage(JSON.stringify({schema_version: 1, document_id: generation, id, action: "cancel"})); }
    catch {}
  }
  function call(action, data, timeoutMs = 15000, signal = null) {
    const jsonCount=[...pending.values()].filter(request=>request.action==='request-json').length;
    if (retired || pending.size >= 24 || (action==='request-json'?jsonCount>=16:pending.size-jsonCount>=8)
      || sequence >= 0xffffffff) return Promise.reject(new Error("ios_platform_busy"));
    if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
    const native = pipe();
    if (typeof native?.postMessage !== "function") return Promise.reject(new Error("ios_platform_unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const generation = documentId;
      const timeout = root.setTimeout(() => {
        if (generation !== documentId || !pending.has(id)) return;
        pending.get(id)?.cleanup?.();pending.delete(id); cancel(id, generation); reject(new Error("ios_platform_timeout"));
      }, timeoutMs);
      const abort=()=>{
        if(generation!==documentId||!pending.has(id))return;
        pending.get(id).cleanup?.();pending.delete(id);root.clearTimeout(timeout);cancel(id,generation);
        reject(new DOMException('Aborted','AbortError'));
      };
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      pending.set(id, {resolve, reject, timeout, action,cleanup});
      signal?.addEventListener('abort',abort,{once:true});
      try { native.postMessage(JSON.stringify({...data, schema_version: 1, document_id: documentId, id, action})); }
      catch {
        root.clearTimeout(timeout); cleanup();pending.delete(id); reject(new Error("ios_platform_unavailable"));
      }
    });
  }
  function receive(reply) {
    if (retired || reply?.schema_version !== 1 || reply.document_id !== documentId) return;
    const request = pending.get(reply.id);
    if (!request || typeof reply.ok !== "boolean") return;
    // The preparation deadline stops when UIKit has presented its picker.
    // Choosing a Files provider/destination has no arbitrary UI deadline.
    if (request.action === "save-history" && reply.ok && reply.data?.status === "choosing") {
      root.clearTimeout(request.timeout); request.timeout = null; return;
    }
    pending.delete(reply.id); root.clearTimeout(request.timeout);request.cleanup?.();
    if (reply.ok) request.resolve(reply.data);
    else request.reject(new Error("ios_platform_failed"));
  }
  function returned(event) {
    if (awaitingLoginReturn && root.document.visibilityState === "visible" && leftForLogin) {
      awaitingLoginReturn = false; leftForLogin = false;
      root.dispatchEvent(new CustomEvent("bilikara:ios-login-return", {detail:{source:event?.type || "reply"}}));
    }
  }
  root.document.addEventListener("visibilitychange", event => {
    if (awaitingLoginReturn && root.document.visibilityState === "hidden") leftForLogin = true;
    returned(event);
  });
  root.addEventListener("focus", returned);
  root.addEventListener("pagehide", () => {
    notifyDocument("retire");
    root.dispatchEvent(new CustomEvent("bilikara:ios-fullscreen-reset"));
    refreshAfterRestore = awaitingLoginReturn;
    retired = true; awaitingLoginReturn = false;
    for (const [id, request] of pending) {
      root.clearTimeout(request.timeout); cancel(id); request.reject(new Error("ios_platform_retired"));
      request.cleanup?.();
    }
    pending.clear();
  });
  root.addEventListener("pageshow", event => {
    if (!retired || !event.persisted) return;
    documentId = newDocumentId(); sequence = 0; retired = false;
    notifyDocument("document");
    if (refreshAfterRestore) root.dispatchEvent(new CustomEvent("bilikara:ios-login-return"));
    refreshAfterRestore = false;
  });
  Object.defineProperty(root, "BilikaraIosPlatform", {value: Object.freeze({
    available: () => !retired && typeof pipe()?.postMessage === "function",
    ...("__BILIKARA_IOS_HTTP__" === "enabled" ? {requestJson:async (request,signal=null)=>{
      await documentReady;
      const verifying=request.method==='POST'&&request.path?.split('?')[0]==='/api/player/automatic-volume'
        &&request.body?.action==='enable'&&request.body?.enabled===true;
      const reply=await call('request-json',{json_request:request},verifying?130000:35000,signal);
      if(reply?.transport_error){const error=new Error(reply.transport_error);error.nativeTransportCode=reply.transport_error;throw error;}
      if(!Number.isInteger(reply?.status)||reply.status<200||reply.status>599||!reply.body||typeof reply.body!=='object')throw new Error('native_api_invalid_reply');
      return reply;
    }} : {}),
    openQrWebLink: url => call("open-qr-web-link", {url}),
    openBilibiliVideo: async url => {
      const result = await call("open-bilibili-video", {url});
      if (result?.opened !== true) throw new Error("ios_platform_failed");
      return result;
    },
    openLoginLink: async url => {
      awaitingLoginReturn = true; leftForLogin = false;
      try {
        const result = await call("open-bilibili-login", {url});
        if (result?.opened !== true) throw new Error("ios_platform_failed");
        returned();
      } catch (error) { awaitingLoginReturn = false; throw error; }
    },
    saveHistory: async (format, source, pageSize) => {
      if (!["csv", "image"].includes(format) || ![50,60,80,100,150,200].includes(pageSize)
        || typeof source !== "string" || !/^(played|history|played-[A-Za-z0-9._-]{1,128}\.json)$/.test(source)) throw new Error("ios_export_options");
      let result;
      try {
        result = await call("save-history", {export: {format, source, pageSize}}, 120000);
        root.BilikaraExportDownload?.recordExportDiagnostic({surface:"host", runtime:"tauri", format, source, pageSize,
          stage:"ios-system-save", status:result?.status, errorCode:result?.errorCode, errorMessage:result?.errorMessage});
        if (result?.status === "saved" || result?.status === "cancelled") return result.status === "saved";
        throw new Error(result?.errorMessage || "ios_export_failed");
      } catch (error) {
        if (!result) root.BilikaraExportDownload?.recordExportDiagnostic({surface:"host", runtime:"tauri", format, source, pageSize,
          stage:"ios-system-save", status:"failed", errorCode:error.message});
        throw error;
      }
    },
    setPlayerFullscreen: async active => {
      if (typeof active !== "boolean") throw new Error("ios_platform_request");
      const result = await call("set-player-fullscreen", {active});
      if (result?.active !== active) throw new Error("ios_platform_failed");
      return true;
    },
    syncDock: data => call("sync-dock", {dock: data}),
    _backGesture: data => {
      if (retired || data?.document_id !== documentId
        || !["began", "changed", "ended", "cancelled"].includes(data.phase)
        || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1
        || !Number.isFinite(data.velocity) || Math.abs(data.velocity) > 10000) return;
      root.dispatchEvent(new CustomEvent("bilikara:ios-back", {
        detail: {phase: data.phase, progress: data.progress, velocity: data.velocity},
      }));
    },
    _dockSelected: data => {
      if (retired || data?.document_id !== documentId || !Number.isInteger(data.index) || data.index < 0 || data.index >= 5) return;
      root.dispatchEvent(new CustomEvent("bilikara:ios-dock-select", {detail: {index: data.index}}));
    },
    _receive: receive,
  })});
})(globalThis, "__BILIKARA_IOS_ORIGIN__");
