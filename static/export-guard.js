(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BilikaraExportGuard = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createExportGuard(buttons) {
    const guardedButtons = Array.from(buttons || []).filter(Boolean);
    let busy = false;
    let originalDisabledStates = [];

    function setBusy(value) {
      busy = Boolean(value);
      if (busy) {
        originalDisabledStates = guardedButtons.map((button) => Boolean(button.disabled));
      }
      guardedButtons.forEach((button, index) => {
        button.disabled = busy ? true : originalDisabledStates[index];
        if (busy) {
          button.setAttribute("aria-busy", "true");
        } else {
          button.removeAttribute("aria-busy");
        }
      });
      if (!busy) {
        originalDisabledStates = [];
      }
    }

    async function run(task) {
      if (busy) {
        return false;
      }
      if (typeof task !== "function") {
        throw new TypeError("export task must be a function");
      }

      setBusy(true);
      try {
        await task();
        return true;
      } finally {
        setBusy(false);
      }
    }

    return {
      isBusy: () => busy,
      run,
    };
  }

  return { createExportGuard };
}));
