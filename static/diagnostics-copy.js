(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BilikaraDiagnosticsCopy = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DEFAULT_FAILURE_MESSAGE = "Clipboard write failed";

  function nativeClipboardWriter(environment) {
    const tauri = environment.tauri === undefined
      ? root?.__TAURI__
      : environment.tauri;
    const writeText = tauri?.clipboardManager?.writeText;
    return typeof writeText === "function"
      ? writeText.bind(tauri.clipboardManager)
      : null;
  }

  async function copyText(text, environment = {}) {
    const value = String(text);
    const fallbackMessage = String(environment.fallbackMessage || DEFAULT_FAILURE_MESSAGE);
    const nativeWrite = nativeClipboardWriter(environment);
    if (nativeWrite) {
      try {
        await nativeWrite(value);
        return { transport: "tauri" };
      } catch {
        // Fall through without exposing plugin details or clipboard contents.
      }
    }

    const navigatorRef = environment.navigator || root?.navigator;
    if (typeof navigatorRef?.clipboard?.writeText === "function") {
      try {
        await navigatorRef.clipboard.writeText(value);
        return { transport: "web" };
      } catch {
        // Fall through to the same-page legacy write path.
      }
    }

    const documentRef = environment.document || root?.document;
    if (documentRef?.body
      && typeof documentRef.createElement === "function"
      && typeof documentRef.execCommand === "function") {
      const textarea = documentRef.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      documentRef.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = Boolean(documentRef.execCommand("copy"));
      } catch {
        // Report only the caller-provided safe message below.
      } finally {
        textarea.remove();
      }
      if (copied) {
        return { transport: "legacy-web" };
      }
    }

    throw new Error(fallbackMessage);
  }

  function normalizedMarkdown(value) {
    return typeof value === "string" && value.trim() ? value : "";
  }

  function createRetryController(options = {}) {
    if (typeof options.generate !== "function" || typeof options.copyText !== "function") {
      throw new TypeError("generate and copyText functions are required");
    }

    let pendingMarkdown = "";

    return {
      hasPendingMarkdown() {
        return Boolean(pendingMarkdown);
      },

      clear() {
        pendingMarkdown = "";
      },

      async copy() {
        const reused = Boolean(pendingMarkdown);
        let markdown = pendingMarkdown;
        if (!reused) {
          pendingMarkdown = "";
          markdown = normalizedMarkdown(await options.generate());
          if (!markdown) {
            throw new Error(String(options.invalidMessage || "Invalid diagnostics Markdown"));
          }
        }

        try {
          const result = await options.copyText(markdown);
          pendingMarkdown = "";
          return { status: "copied", reused, transport: result?.transport || "" };
        } catch (error) {
          pendingMarkdown = markdown;
          return { status: "ready", reused, error };
        }
      },
    };
  }

  return {
    copyText,
    createRetryController,
  };
}));
