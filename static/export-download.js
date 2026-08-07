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

  const MAX_EXPORT_DIAGNOSTICS = 64;

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
    if (result && typeof result === "object") {
      const status = result.status;
      if (status === "saved" || status === "cancelled") {
        return status;
      }
      if (status === "failed") {
        throw new Error(normalizedErrorMessage(result.errorMessage || result.errorCode, fallback));
      }
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

  function generateRequestId() {
    if (typeof root !== "undefined" && root.crypto && typeof root.crypto.randomUUID === "function") {
      return root.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return "req_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  }

  function sanitizeExportDiagnosticEntry(rawEntry) {
    if (!rawEntry || typeof rawEntry !== "object") {
      return null;
    }
    const timestamp = typeof rawEntry.timestamp === "string" && rawEntry.timestamp.trim()
      ? rawEntry.timestamp.trim()
      : new Date().toISOString();
    const surface = ["host", "remote", "local"].includes(rawEntry.surface)
      ? rawEntry.surface
      : "host";
    const runtime = ["tauri", "browser"].includes(rawEntry.runtime)
      ? rawEntry.runtime
      : "browser";
    const format = rawEntry.format ? String(rawEntry.format).trim().toLowerCase() : null;
    const source = rawEntry.source ? String(rawEntry.source).trim().toLowerCase() : null;
    const pageSize = typeof rawEntry.pageSize === "number" && !isNaN(rawEntry.pageSize)
      ? Math.floor(rawEntry.pageSize)
      : (rawEntry.pageSize ? parseInt(rawEntry.pageSize, 10) || null : null);
    const stage = rawEntry.stage ? String(rawEntry.stage).trim() : null;
    const status = ["saved", "cancelled", "failed"].includes(rawEntry.status)
      ? rawEntry.status
      : null;
    const httpStatus = typeof rawEntry.httpStatus === "number" && !isNaN(rawEntry.httpStatus)
      ? Math.floor(rawEntry.httpStatus)
      : null;
    const contentType = rawEntry.contentType ? String(rawEntry.contentType).trim() : null;
    const bytes = typeof rawEntry.bytes === "number" && !isNaN(rawEntry.bytes)
      ? Math.floor(rawEntry.bytes)
      : null;
    const filenameExtension = rawEntry.filenameExtension ? String(rawEntry.filenameExtension).trim().toLowerCase() : null;
    const elapsedMs = typeof rawEntry.elapsedMs === "number" && !isNaN(rawEntry.elapsedMs)
      ? Math.max(0, Math.floor(rawEntry.elapsedMs))
      : null;

    let stageTimings = null;
    if (Array.isArray(rawEntry.stageTimings)) {
      stageTimings = rawEntry.stageTimings
        .filter((item) => item && typeof item === "object" && typeof item.stage === "string")
        .slice(0, 16)
        .map((item) => ({
          stage: String(item.stage).trim(),
          elapsedMs: typeof item.elapsedMs === "number" && !isNaN(item.elapsedMs)
            ? Math.max(0, Math.floor(item.elapsedMs))
            : 0,
        }));
    }

    const rawReqId = rawEntry.requestId || rawEntry.request_id || null;
    const requestId = rawReqId ? String(rawReqId).trim().slice(0, 64) : null;
    const errorCode = rawEntry.errorCode ? String(rawEntry.errorCode).trim().slice(0, 256) : null;
    const errorMessage = rawEntry.errorMessage ? String(rawEntry.errorMessage).trim().slice(0, 256) : null;

    return {
      timestamp,
      surface,
      runtime,
      format,
      source,
      pageSize,
      stage,
      status,
      httpStatus,
      contentType,
      bytes,
      filenameExtension,
      elapsedMs,
      stageTimings,
      requestId,
      errorCode,
      errorMessage,
    };
  }

  function createExportDiagnosticRing(maxCapacity = MAX_EXPORT_DIAGNOSTICS) {
    const limit = Math.max(1, Math.min(64, Math.floor(maxCapacity || MAX_EXPORT_DIAGNOSTICS)));
    let ring = [];

    return {
      push(rawEntry) {
        const sanitized = sanitizeExportDiagnosticEntry(rawEntry);
        if (!sanitized) {
          return;
        }
        ring.push(sanitized);
        if (ring.length > limit) {
          ring = ring.slice(-limit);
        }
      },
      snapshot() {
        return ring.map((entry) => ({
          ...entry,
          stageTimings: entry.stageTimings ? entry.stageTimings.map((t) => ({ ...t })) : null,
        }));
      },
      clear() {
        ring = [];
      },
      length() {
        return ring.length;
      },
    };
  }

  const defaultRing = createExportDiagnosticRing(MAX_EXPORT_DIAGNOSTICS);

  function recordExportDiagnostic(entry) {
    defaultRing.push(entry);
  }

  function getExportDiagnosticsSnapshot() {
    return defaultRing.snapshot();
  }

  function clearExportDiagnostics() {
    defaultRing.clear();
  }

  async function downloadBrowserFile(url, options = {}, environment = {}) {
    const fetchRef = environment.fetch || root?.fetch?.bind(root);
    const documentRef = environment.document || root?.document;
    const urlRef = environment.URL || root?.URL;
    const schedule = environment.setTimeout || root?.setTimeout?.bind(root);
    const fallbackMessage = String(options.fallbackMessage || "");
    const startTime = Date.now();
    const surface = options.surface || "host";
    const format = options.format || null;
    const source = options.source || null;
    const pageSize = options.pageSize || null;

    let requestId = options.requestId || null;
    let requestUrl = url;
    if (requestUrl && typeof requestUrl === "string") {
      try {
        const dummyUrl = new URL(requestUrl, "http://bilikara.invalid");
        if (!requestId) {
          if (dummyUrl.searchParams.has("request_id")) {
            requestId = dummyUrl.searchParams.get("request_id");
          } else if (dummyUrl.searchParams.has("requestId")) {
            requestId = dummyUrl.searchParams.get("requestId");
          }
        }
        const isPlaylistExport = dummyUrl.pathname === "/api/playlist/export";
        if (isPlaylistExport) {
          if (!requestId) {
            requestId = generateRequestId();
          }
          if (!dummyUrl.searchParams.has("request_id") && !dummyUrl.searchParams.has("requestId")) {
            dummyUrl.searchParams.set("request_id", requestId);
            requestUrl = dummyUrl.pathname + dummyUrl.search;
          }
        } else {
          requestUrl = dummyUrl.pathname + dummyUrl.search;
        }
      } catch {
        if (requestUrl.startsWith("/api/playlist/export")) {
          if (!requestId) {
            requestId = generateRequestId();
          }
          if (!requestUrl.includes("request_id=") && !requestUrl.includes("requestId=")) {
            requestUrl += (requestUrl.includes("?") ? "&" : "?") + "request_id=" + encodeURIComponent(requestId);
          }
        }
      }
    } else {
      if (!requestId) {
        requestId = generateRequestId();
      }
    }

    if (typeof fetchRef !== "function"
      || !documentRef?.body
      || typeof documentRef.createElement !== "function"
      || typeof urlRef?.createObjectURL !== "function"
      || typeof urlRef?.revokeObjectURL !== "function"
      || typeof schedule !== "function") {
      const errMessage = normalizedErrorMessage(null, fallbackMessage);
      recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "browser",
        format,
        source,
        pageSize,
        stage: "validate_environment",
        status: "failed",
        requestId,
        errorCode: "INVALID_ENVIRONMENT",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
      throw new Error(errMessage);
    }

    let response;
    let fetchStatus = null;
    let contentType = null;
    try {
      response = await fetchRef(requestUrl, {
        cache: "no-store",
        credentials: "same-origin",
        headers: options.headers || {},
      });
      fetchStatus = response.status;
      contentType = response.headers?.get?.("Content-Type") || null;
    } catch (error) {
      const errMessage = normalizedErrorMessage(error, fallbackMessage);
      recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "browser",
        format,
        source,
        pageSize,
        stage: "request_backend",
        status: "failed",
        requestId,
        errorCode: "FETCH_FAILED",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
      throw new Error(errMessage);
    }

    if (!response.ok) {
      const errMessage = await responseErrorMessage(response, fallbackMessage);
      recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "browser",
        format,
        source,
        pageSize,
        stage: "validate_response",
        status: "failed",
        httpStatus: fetchStatus,
        contentType,
        requestId,
        errorCode: "HTTP_ERROR",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
      throw new Error(errMessage);
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (error) {
      const errMessage = normalizedErrorMessage(error, fallbackMessage);
      recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "browser",
        format,
        source,
        pageSize,
        stage: "read_blob",
        status: "failed",
        httpStatus: fetchStatus,
        contentType,
        requestId,
        errorCode: "BLOB_FAILED",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
      throw new Error(errMessage);
    }

    const filename = filenameFromContentDisposition(
      response.headers?.get?.("Content-Disposition"),
      options.fallbackFilename || "download.bin",
    );
    const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
    const filenameExtension = extMatch ? extMatch[1].toLowerCase() : null;

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

    recordExportDiagnostic({
      timestamp: new Date().toISOString(),
      surface,
      runtime: "browser",
      format,
      source,
      pageSize,
      stage: "complete",
      status: "saved",
      httpStatus: fetchStatus || 200,
      contentType,
      bytes: blob?.size || null,
      filenameExtension,
      requestId,
      elapsedMs: Date.now() - startTime,
    });

    return true;
  }

  function isTauriCommandNotFoundError(error) {
    const msg = (
      typeof error === "string"
        ? error
        : error && typeof error.message === "string"
          ? error.message
          : ""
    ).toLowerCase();

    if (!msg.includes("save_backend_download")) {
      return false;
    }

    const patterns = [
      /command\s+['"]?save_backend_download['"]?\s+not\s+found/,
      /unknown\s+command\s+['"]?save_backend_download['"]?/,
    ];
    return patterns.some((re) => re.test(msg));
  }

  function hasOwnProp(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  }

  function isValidNativeDownloadResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return false;
    }

    const requiredKeys = [
      "status",
      "stage",
      "format",
      "source",
      "pageSize",
      "httpStatus",
      "contentType",
      "bytes",
      "filenameExtension",
      "elapsedMs",
      "stageTimings",
      "errorCode",
      "errorMessage",
    ];

    for (const key of requiredKeys) {
      if (!hasOwnProp(result, key)) {
        return false;
      }
    }

    if (!["saved", "cancelled", "failed"].includes(result.status)) {
      return false;
    }

    if (typeof result.stage !== "string" || result.stage.trim() === "") {
      return false;
    }

    if (typeof result.elapsedMs !== "number" || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) {
      return false;
    }

    if (!Array.isArray(result.stageTimings)) {
      return false;
    }

    for (const timing of result.stageTimings) {
      if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
        return false;
      }
      if (!hasOwnProp(timing, "stage") || !hasOwnProp(timing, "elapsedMs")) {
        return false;
      }
      if (typeof timing.stage !== "string" || timing.stage.trim() === "") {
        return false;
      }
      if (typeof timing.elapsedMs !== "number" || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0) {
        return false;
      }
    }

    if (result.format !== null && typeof result.format !== "string") {
      return false;
    }
    if (result.source !== null && typeof result.source !== "string") {
      return false;
    }
    if (result.pageSize !== null && (typeof result.pageSize !== "number" || !Number.isFinite(result.pageSize) || result.pageSize < 0)) {
      return false;
    }
    if (result.httpStatus !== null && (!Number.isInteger(result.httpStatus))) {
      return false;
    }
    if (result.contentType !== null && typeof result.contentType !== "string") {
      return false;
    }
    if (result.bytes !== null && (typeof result.bytes !== "number" || !Number.isFinite(result.bytes) || result.bytes < 0)) {
      return false;
    }
    if (result.filenameExtension !== null && typeof result.filenameExtension !== "string") {
      return false;
    }
    if (result.errorCode !== null && typeof result.errorCode !== "string") {
      return false;
    }
    if (result.errorMessage !== null && typeof result.errorMessage !== "string") {
      return false;
    }

    if (result.status === "saved") {
      if (result.stage !== "complete") {
        return false;
      }
      if (typeof result.httpStatus !== "number" || result.httpStatus < 200 || result.httpStatus > 299) {
        return false;
      }
      if (typeof result.contentType !== "string" || result.contentType.trim() === "") {
        return false;
      }
      if (typeof result.bytes !== "number" || !Number.isFinite(result.bytes) || result.bytes < 0) {
        return false;
      }
      if (typeof result.filenameExtension !== "string" || result.filenameExtension.trim() === "") {
        return false;
      }
      if (result.errorCode !== null || result.errorMessage !== null) {
        return false;
      }
    } else if (result.status === "cancelled") {
      if (result.stage !== "choose_destination") {
        return false;
      }
      if (result.errorCode !== null || result.errorMessage !== null) {
        return false;
      }
      if (
        result.httpStatus !== null ||
        result.contentType !== null ||
        result.bytes !== null ||
        result.filenameExtension !== null
      ) {
        return false;
      }
    } else if (result.status === "failed") {
      if (result.stage === "complete") {
        return false;
      }
      if (typeof result.errorCode !== "string" || result.errorCode.trim() === "") {
        return false;
      }
      if (typeof result.errorMessage !== "string" || result.errorMessage.trim() === "") {
        return false;
      }
    }

    return true;
  }

  return {
    clearExportDiagnostics,
    createExportDiagnosticRing,
    downloadBrowserFile,
    filenameFromContentDisposition,
    generateRequestId,
    getExportDiagnosticsSnapshot,
    isTauriCommandNotFoundError,
    isValidNativeDownloadResult,
    nativeDownloadStatus,
    normalizedErrorMessage,
    recordExportDiagnostic,
    sanitizeExportDiagnosticEntry,
  };
}));
