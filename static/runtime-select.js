/* Runtime settings use their original HTML selects and the system picker.
   Keep the render hook for existing callers; it must not hide/replace a select,
   intercept native input, or mirror its value, disabled state and labels. */
(() => {
  'use strict';
  // Native select lifecycle, focus, keyboard and cancellation belong to the UA.
  window.BilikaraRuntimeSelect=Object.freeze({sync() {},close() {}});
})();
