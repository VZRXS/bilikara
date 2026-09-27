// Shared presentation-only overflow measurement for Host and Remote part pills.
(() => {
  function syncLabels(root) {
    root?.querySelectorAll(".audio-variant-button-label").forEach(label => {
      const text = label.querySelector(".audio-variant-button-text");
      if (!text || !label.clientWidth) return;
      const distance = Math.max(0, text.scrollWidth - label.clientWidth);
      label.classList.toggle("is-overflowing", distance > 1);
      label.style.setProperty("--part-scroll-distance", `${distance}px`);
      label.style.setProperty("--part-scroll-duration", `${Math.max(6, distance / 30 + 3)}s`);
    });
  }
  window.BilikaraPartSelector = Object.freeze({ syncLabels });
})();
