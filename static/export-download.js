(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BilikaraExportDownload = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const ATTACHMENT_FRAME_CLEANUP_DELAY_MS = 60_000;

  function isLoopbackIpv4(address) {
    const parts = String(address || "").split(".");
    if (parts.length !== 4) {
      return false;
    }
    const octets = parts.map((part) => {
      if (!/^\d{1,3}$/.test(part)) {
        return NaN;
      }
      return Number.parseInt(part, 10);
    });
    return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      && octets[0] === 127;
  }

  function isLoopbackHostname(hostname) {
    let normalized = String(hostname || "").trim().toLowerCase();
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
      normalized = normalized.slice(1, -1);
    }
    normalized = normalized.replace(/\.$/, "");
    if (normalized === "localhost" || normalized === "::1") {
      return true;
    }
    if (isLoopbackIpv4(normalized)) {
      return true;
    }
    if (!normalized.startsWith("::ffff:")) {
      return false;
    }

    const mappedAddress = normalized.slice("::ffff:".length);
    if (isLoopbackIpv4(mappedAddress)) {
      return true;
    }
    const mappedWords = mappedAddress.split(":");
    if (mappedWords.length !== 2 || mappedWords.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
      return false;
    }
    const highWord = Number.parseInt(mappedWords[0], 16);
    return (highWord >> 8) === 127;
  }

  function triggerAttachmentDownload(url, environment = {}) {
    const documentRef = environment.document || root?.document;
    const schedule = environment.setTimeout || root?.setTimeout?.bind(root);
    if (!documentRef?.body || typeof documentRef.createElement !== "function") {
      throw new Error("attachment download requires a document body");
    }
    if (typeof schedule !== "function") {
      throw new Error("attachment download requires setTimeout");
    }

    const frame = documentRef.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = String(url || "");
    documentRef.body.appendChild(frame);
    schedule(() => {
      frame.remove();
    }, ATTACHMENT_FRAME_CLEANUP_DELAY_MS);
    return true;
  }

  return {
    isLoopbackHostname,
    triggerAttachmentDownload,
  };
}));
