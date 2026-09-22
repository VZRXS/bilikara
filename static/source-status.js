/* One presentation of native source-refresh state for Host and Remote. */
(function (root) {
  "use strict";
  const reloads = new Map();
  function setBusy(button, busy) {
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
  function flush(key) {
    const pending = reloads.get(key);
    if (pending && pending.ready()) {
      reloads.delete(key);
      void pending.reload();
    }
  }
  function queueReload(key, ready, reload) {
    reloads.set(key, {ready, reload});
    flush(key);
  }
  function sync(containers, {task = {}, loading = false, translate}) {
    const running = Boolean(task.busy || task.background_busy || task.last_status === "running");
    let text = translate(running ? "gatcha.pullingSources" : "gatcha.readingSource");
    const progress = task.last_result?.rebuild;
    if (running && progress) {
      const favorites = progress.phase === "favlist";
      const index = Number(favorites ? progress.favlist_index : progress.uid_index);
      const total = Number(favorites ? progress.favlist_total : progress.uid_total);
      if (Number.isSafeInteger(index) && Number.isSafeInteger(total) && index > 0 && index <= total) {
        text += ` ${index} / ${total}`;
      }
    }
    for (const container of containers.filter(Boolean)) {
      let status = container.querySelector(":scope > .source-task-status");
      if (!status) {
        status = document.createElement("div");
        status.className = "source-task-status";
        status.setAttribute("role", "status");
        const label = document.createElement("span");
        status.append(label);
        container.prepend(status);
      }
      status.hidden = !running && !loading;
      status.firstChild.textContent = text;
    }
  }
  root.BilikaraSourceStatus = {sync, setBusy, queueReload, flush};
})(window);
