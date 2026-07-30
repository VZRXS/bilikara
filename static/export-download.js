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

  function normalizedErrorMessage(error, fallback) {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
    return String(fallback || "").trim();
  }

  function nativeDownloadStatus(result, fallback) {
    const status = result && typeof result === "object" ? result.status : "";
    if (status === "saved" || status === "cancelled") {
      return status;
    }
    throw new Error(normalizedErrorMessage(null, fallback));
  }

  function filenameFromContentDisposition(headerValue, fallback) {
    const value = String(headerValue || "");
    const quotedMatch = value.match(/filename="([^"]+)"/i);
    if (quotedMatch) {
      return quotedMatch[1];
    }
    const plainMatch = value.match(/filename=([^;]+)/i);
    return plainMatch ? plainMatch[1].trim() : fallback;
  }

  async function responseErrorMessage(response, fallback) {
    try {
      const payload = await response.json();
      return normalizedErrorMessage(payload?.error, fallback);
    } catch {
      return normalizedErrorMessage(null, fallback);
    }
  }

  async function downloadBrowserFile(url, options = {}, environment = {}) {
    const fetchRef = environment.fetch || root?.fetch?.bind(root);
    const documentRef = environment.document || root?.document;
    const urlRef = environment.URL || root?.URL;
    const schedule = environment.setTimeout || root?.setTimeout?.bind(root);
    const fallbackMessage = String(options.fallbackMessage || "");
    if (typeof fetchRef !== "function"
      || !documentRef?.body
      || typeof documentRef.createElement !== "function"
      || typeof urlRef?.createObjectURL !== "function"
      || typeof urlRef?.revokeObjectURL !== "function"
      || typeof schedule !== "function") {
      throw new Error(normalizedErrorMessage(null, fallbackMessage));
    }

    const response = await fetchRef(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: options.headers || {},
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, fallbackMessage));
    }

    const blob = await response.blob();
    const filename = filenameFromContentDisposition(
      response.headers?.get?.("Content-Disposition"),
      options.fallbackFilename || "download.bin",
    );
    const downloadUrl = urlRef.createObjectURL(blob);
    const link = documentRef.createElement("a");
    try {
      link.href = downloadUrl;
      link.download = filename;
      link.rel = "noopener";
      documentRef.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      schedule(() => urlRef.revokeObjectURL(downloadUrl), 1000);
    }
    return true;
  }

  return {
    downloadBrowserFile,
    filenameFromContentDisposition,
    nativeDownloadStatus,
    normalizedErrorMessage,
  };
}));
