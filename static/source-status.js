/* One presentation of native source-refresh state for Host and Remote. */
(function (root) {
  "use strict";
  const reloads = new Map();
  let observedTask;
  let observedSources;
  function takeSourceChanges(task = {}) {
    const sources = task.last_result?.rebuild?.sources;
    if (!sources) { observedSources = undefined; return []; }
    const previous = observedSources;
    observedSources = {...sources};
    return ["uids", "favorites"].filter(key => Number(sources[key]) > 0
      && (!previous || sources.generation !== previous.generation || sources[key] !== previous[key]));
  }
  function takeCompletion(task = {}, saving = false) {
    const signature = JSON.stringify([task.busy, task.background_busy, task.last_status,
      task.last_updated_at, task.last_message, task.last_error]);
    // The initial server snapshot is a baseline, not a new completion. Compare
    // server observations, never the phone's clock with the Host's clock.
    if (observedTask === undefined) { observedTask = signature; return false; }
    if (saving) return false; // Consume a fast completion after the request settles.
    const changed = signature !== observedTask;
    observedTask = signature;
    return changed && !task.busy && !task.background_busy
      && ["success", "partial", "failed"].includes(task.last_status);
  }
  function setBusy(button, busy) {
    button.classList.add("source-action-button");
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
  function syncCard(card, task = {}, translate) {
    const progress = task.last_result?.rebuild;
    const busy = Boolean(task.busy || task.background_busy || task.last_status === "running");
    const active = busy && progress && (card.dataset.uid
      ? progress.phase === 'uid' && card.dataset.uid === String(progress.current_uid || '')
      : progress.phase === 'favlist' && card.dataset.folderId === String(progress.current_folder_id || ''));
    card.classList.toggle('source-card-loading', Boolean(active));
    if (active) card.setAttribute('aria-busy', 'true');
    else card.removeAttribute('aria-busy');
    let spinner = card.querySelector('.source-card-spinner');
    if (!active) { spinner?.remove(); return; }
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'source-card-spinner';
      spinner.setAttribute('role', 'status');
      (card.querySelector('.follow-up-count') || card).append(spinner);
    }
    spinner.setAttribute('aria-label', translate('gatcha.pullingSources'));
    spinner.title = translate('gatcha.pullingSources');
  }
  function sync(containers, {task = {}, translate}) {
    for (const container of containers.filter(Boolean)) {
      container.querySelector(':scope > .source-task-status')?.remove();
      for (const card of container.querySelectorAll('.follow-up-button')) syncCard(card, task, translate);
    }
  }
  root.BilikaraSourceStatus = {sync, syncCard, setBusy, queueReload, flush, takeCompletion, takeSourceChanges};
})(window);
