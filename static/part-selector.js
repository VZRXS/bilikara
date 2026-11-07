// Shared part-pill presentation and connection-authorized cache requests.
(() => {
  const pending = new Set();
  const paints = new WeakMap();
  let reportedFailure = "";
  function supplement(snapshot, item) {
    const value = snapshot?.audio_supplements?.[item?.id];
    return value?.item_incarnation_id === item?.item_incarnation_id ? value : null;
  }
  function supplementVariants(snapshot, item) {
    return supplement(snapshot, item)?.ready?.audio_variants || [];
  }
  function paintProgress(roots, snapshot, item, locked = false, reportError) {
    const task = supplement(snapshot, item);
    const failed = task?.status === "failed" && ![...(item?.audio_variants || []), ...supplementVariants(snapshot, item)]
      .some(variant => Number(variant.page) === task.page);
    const failureMessage = failed ? String(task.message || "").trim() || t("cache.failed") : "";
    const failureKey = failed ? `${item.item_incarnation_id}:${task.cache_attempt_token}:${task.page}:${failureMessage}` : "";
    if (failureKey !== reportedFailure) {
      reportedFailure = failureKey;
      if (failureKey) reportError?.(failureMessage);
    }
    const requestKey = `${item?.item_incarnation_id}:`;
    const requesting = [...pending].some(key => key.startsWith(requestKey));
    const busy = requesting || ["queued", "downloading"].includes(task?.status);
    for (const root of roots) for (const button of root?.querySelectorAll(".audio-variant-button") || []) {
      if (button.dataset.itemId !== item?.id) continue;
      const active = busy && (Number(button.dataset.page) === task?.page || pending.has(requestKey + button.dataset.page));
      button.disabled = button.dataset.bound === "true" ? locked : busy || item?.cache_status !== "ready";
      if (active) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
      const pageFailed = !active && failed && Number(button.dataset.page) === task.page;
      button.dataset.audioCache = active ? "pending" : pageFailed ? "failed" : "";
      const label = button.querySelector(".audio-variant-button-text")?.textContent || "";
      button.title = pageFailed ? `${label}: ${failureMessage}` : label;
      if (pageFailed) button.setAttribute("aria-description", failureMessage);
      else button.removeAttribute("aria-description");
      let progress = button.querySelector(".audio-part-progress");
      if (!progress) {
        progress = document.createElement("span");
        progress.className = "audio-part-progress";
        progress.setAttribute("aria-hidden", "true");
        button.prepend(progress);
      }
      const old = paints.get(button);
      const draw = () => {
        if (!button.isConnected) return;
        const percent = task?.progress;
        button.classList.toggle("is-cache-indeterminate", active && percent == null);
        button.style.setProperty("--audio-cache-progress", `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`);
        paints.set(button, {at: performance.now(), timer: 0});
      };
      if (old?.timer) clearTimeout(old.timer);
      if (active && old && performance.now() - old.at < 1000) {
        paints.set(button, {...old, timer: setTimeout(draw, 1000 - (performance.now() - old.at))});
      } else draw();
    }
  }
  async function cacheAudio({item, page, snapshot, post, refresh, reportError}) {
    const key = `${item.item_incarnation_id}:${page}`;
    const task = supplement(snapshot, item);
    if (!Number.isSafeInteger(page) || page < 1 || pending.has(key) || ["queued", "downloading"].includes(task?.status)) return;
    pending.add(key);
    refresh();
    try {
      await post("/api/cache/audio", {item_id: item.id, expected_item_incarnation_id: item.item_incarnation_id, page});
    } catch (error) {
      reportError(error.message);
    } finally {
      pending.delete(key);
      refresh();
    }
  }
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
  window.BilikaraPartSelector = Object.freeze({ syncLabels, supplementVariants, paintProgress, cacheAudio });
})();
