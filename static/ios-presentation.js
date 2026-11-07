// Injected only into native-created Host/audience frames. Each document has a
// separate lease; native still validates the actual WK frame and origin.
(function(root, origin, audienceGeneration) {
  "use strict";
  const url = new URL(root.location.href);
  const stage = audienceGeneration > 0;
  if (root.top !== root || url.origin !== origin || url.hash
    || (stage ? url.pathname !== "/controller.html" || url.search !== `?presentationGeneration=${audienceGeneration}`
      : !["/", "/index.html"].includes(url.pathname) || url.search)) return;
  if (!root.crypto?.getRandomValues) return;
  const pipe = () => root.webkit?.messageHandlers?.bilikaraPresentation;
  const token = () => Array.from(root.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,"0")).join("");
  let documentId = token(), retired = false;
  function lifecycle(command) {
    pipe()?.postMessage(JSON.stringify({schema_version:1, document_id:documentId, command, args:{}}));
  }
  const bridge = {
    platform: "ios",
    onmessage: null,
    postMessage(raw) {
      if (retired) throw new Error("display_page_closed");
      if (typeof pipe()?.postMessage !== "function") throw new Error("display_unavailable");
      const request = JSON.parse(raw);
      // Repeat registration before ordinary calls: document-start may precede
      // WK's committed URL. Repeated registration never revives a retired ID.
      if (request.id) lifecycle("document");
      pipe()?.postMessage(JSON.stringify({...request, schema_version:1, document_id:documentId}));
    },
  };
  Object.defineProperty(root,"BilikaraHostPresentation",{value:bridge});
  Object.defineProperty(root,"BilikaraIosPresentationReceiver",{value:Object.freeze({
    reply(document, payload) {
      if (!retired && document === documentId) bridge.onmessage?.({data:JSON.stringify(payload)});
    },
    event(document, name, payload) {
      if (!retired && document === documentId) root.dispatchEvent(new CustomEvent("bilikara-native-presentation",{detail:{name,payload}}));
    },
  })});
  lifecycle("document");
  root.document.addEventListener("DOMContentLoaded",()=>lifecycle("document"),{once:true});
  root.addEventListener("pagehide",()=>{lifecycle("retire");retired=true;});
  root.addEventListener("pageshow",event=>{if(event.persisted&&retired){documentId=token();retired=false;lifecycle("document");}});
})(globalThis, "__BILIKARA_PRESENTATION_ORIGIN__", __BILIKARA_PRESENTATION_GENERATION__);
