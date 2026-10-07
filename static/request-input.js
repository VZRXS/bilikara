/* Preserve link boundaries when pasting multiline share text into a text input. */
(function () {
  "use strict";
  const input = document.getElementById("url-input");
  input?.addEventListener("paste", (event) => {
    if (input.disabled || input.readOnly) return;
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!/[\r\n\t]/u.test(text)) return;
    event.preventDefault();
    input.setRangeText(text.replace(/[\r\n\t]+/gu, " "), input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
})();
